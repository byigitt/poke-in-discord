/**
 * Builds (and resumes, and deletes) the pi agent session backing one Discord
 * conversation. Each conversation maps to a deterministic `.jsonl` file, so the
 * bot remembers a chat across restarts and idle eviction: a fresh process that
 * sees an existing file resumes it with full history.
 */
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { CustomTool } from "../integrations/types.ts";
import type { PiRuntime } from "../pi/runtime.ts";

/** Inputs needed to materialize conversation sessions. Stable for the bot's lifetime. */
export interface SessionFactoryDeps {
  readonly runtime: PiRuntime;
  readonly config: Config;
  /** Prebuilt persona system prompt (replaces pi's default coding prompt entirely). */
  readonly persona: string;
  /** Tools contributed by enabled integrations (empty in the base build). */
  readonly tools: CustomTool[];
  /** MCP tools — registered via refreshMCPTools (not customTools) so the model can call them. */
  readonly mcpTools: CustomTool[];
  /**
   * Live, per-turn account-link status for the speaking user, keyed by session
   * file. Re-evaluated each prompt and appended to the system prompt so the model
   * knows which connectable apps THIS user has actually linked — instead of
   * guessing from the static capability list and asking an already-connected user
   * to connect again. Returns null when there's nothing to say (no actor between
   * turns, no connectable apps); omit it entirely when nothing is connectable.
   */
  readonly connectionStatus?: (sessionFile: string) => string | null;
  readonly logger: Logger;
}

/** Discord ids are snowflakes, but stay defensive against unexpected key shapes. */
function safeFileStem(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "conversation";
}

export class ConversationSessionFactory {
  private readonly sessionDir: string;
  private readonly settings: Settings;

  constructor(private readonly deps: SessionFactoryDeps) {
    this.sessionDir = isAbsolute(deps.config.sessionDir)
      ? deps.config.sessionDir
      : resolve(process.cwd(), deps.config.sessionDir);
    // Isolated settings: independent of the host's omp config, with compaction
    // (summarize very long chats) and retry (ride out transient provider errors).
    this.settings = Settings.isolated({
      "compaction.enabled": true,
      "retry.enabled": true,
    });
  }

  filePath(key: string): string {
    return join(this.sessionDir, `${safeFileStem(key)}.jsonl`);
  }

  /** Create a session for `key`, resuming its on-disk history when present. */
  async create(key: string): Promise<AgentSession> {
    const file = this.filePath(key);
    const resuming = existsSync(file);

    let sessionManager: SessionManager;
    if (resuming) {
      sessionManager = await SessionManager.open(file);
    } else {
      sessionManager = SessionManager.create(this.sessionDir, this.sessionDir);
      await sessionManager.setSessionFile(file);
    }

    const { session } = await createAgentSession({
      cwd: this.sessionDir,
      authStorage: this.deps.runtime.authStorage,
      modelRegistry: this.deps.runtime.modelRegistry,
      model: this.deps.runtime.model,
      thinkingLevel: this.deps.runtime.thinkingLevel,
      // Re-evaluated per prompt, so the model always knows "now" — needed for
      // reminders ("in 10 min") and calendar/email time math — and learns the
      // speaker's live account links this turn, so it won't tell an
      // already-connected user to connect again (the static persona can't know).
      systemPrompt: () => {
        const status = this.deps.connectionStatus?.(file) ?? null;
        return [
          this.deps.persona,
          ...(status ? [status] : []),
          `The current date and time is ${new Date().toString()}.`,
        ];
      },
      customTools: this.deps.tools,
      sessionManager,
      settings: this.settings,
      // A focused texting bot, not a coding agent: no built-in tools, no MCP,
      // no LSP, no python, no ambient discovery. Integrations add capability.
      toolNames: [],
      enableMCP: false,
      enableLsp: false,
      skipPythonPreflight: true,
      disableExtensionDiscovery: true,
      skills: [],
      contextFiles: [],
      requireYieldTool: false,
      hasUI: false,
      // Stable per-conversation id improves provider prompt caching + sticky auth.
      providerSessionId: `discord:${safeFileStem(key)}`,
    });

    // MCP tools must be REGISTERED + activated via refreshMCPTools, not passed as
    // customTools — otherwise the model can't actually call them (it hallucinates a
    // `<use_mcp_tool>` text format instead). `activateAll` is meant for exactly this:
    // externally-provisioned servers when the session's own MCP discovery is off.
    if (this.deps.mcpTools.length > 0) {
      await session.refreshMCPTools(this.deps.mcpTools, { activateAll: true });
    }

    this.deps.logger.debug(resuming ? "resumed session" : "created session", {
      key,
      messages: session.messages.length,
    });
    return session;
  }

  /** Permanently forget a conversation: its on-disk history and artifacts. */
  async deleteFile(key: string): Promise<void> {
    const file = this.filePath(key);
    await rm(file, { force: true });
    // Session artifacts live in a sibling dir named like the session file sans .jsonl.
    await rm(file.replace(/\.jsonl$/, ""), { recursive: true, force: true });
  }
}
