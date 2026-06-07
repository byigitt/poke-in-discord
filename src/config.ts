/**
 * Typed, validated runtime configuration.
 *
 * Bun auto-loads `.env`, so every value here comes from `process.env`. Anything
 * required and missing is a hard, explained startup failure — never a silent
 * default that fails mysteriously later.
 */
import { homedir } from "node:os";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "auto"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const RESPOND_MODES = ["mention", "all"] as const;
export type RespondMode = (typeof RESPOND_MODES)[number];

export interface Config {
  /** Discord bot token. */
  readonly discordToken: string;
  /** Name the assistant uses for itself. */
  readonly botName: string;
  /** Explicit `provider/model` selector, or undefined to auto-resolve. */
  readonly model: string | undefined;
  /** Reasoning effort. `off` keeps replies snappy and texty. */
  readonly thinking: ThinkingLevel;
  /** In servers: answer only on mention/reply, or every message. DMs always answer. */
  readonly respondTo: RespondMode;
  /** Directory where per-conversation history (memory) is persisted. */
  readonly sessionDir: string;
  /** Evict an idle conversation from memory after this many minutes. */
  readonly sessionIdleMs: number;
  /** Cap on how many separate Discord messages a single reply may become. */
  readonly maxReplyMessages: number;
  /** Largest image attachment (bytes) the bot will download and forward to a vision model. */
  readonly imageMaxBytes: number;
  /** Most image attachments forwarded from a single message. */
  readonly maxImagesPerMessage: number;
  /** Override for pi's agent config dir (credentials/models). undefined → ~/.omp/agent. */
  readonly agentDir: string | undefined;
  /** Root directory the file tools may read from and upload. Paths are confined under it. */
  readonly filesRoot: string;
  /** Largest file (bytes) the bot will read inline or upload to Discord. */
  readonly fileMaxBytes: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function oneOf<T extends readonly string[]>(name: string, allowed: T, fallback: T[number]): T[number] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T[number];
  throw new Error(`Invalid ${name}="${raw}". Expected one of: ${allowed.join(", ")}.`);
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid ${name}="${raw}". Expected a positive integer.`);
  }
  return n;
}

export function loadConfig(): Config {
  return {
    discordToken: required("DISCORD_TOKEN"),
    botName: optional("POKE_BOT_NAME", "Poke"),
    model: process.env.POKE_MODEL?.trim() || undefined,
    thinking: oneOf("POKE_THINKING", THINKING_LEVELS, "off"),
    respondTo: oneOf("POKE_RESPOND_TO", RESPOND_MODES, "mention"),
    sessionDir: optional("POKE_SESSION_DIR", ".sessions"),
    sessionIdleMs: positiveInt("POKE_SESSION_IDLE_MINUTES", 30) * 60_000,
    maxReplyMessages: positiveInt("POKE_MAX_REPLY_MESSAGES", 5),
    imageMaxBytes: positiveInt("POKE_MAX_IMAGE_MB", 8) * 1024 * 1024,
    maxImagesPerMessage: positiveInt("POKE_MAX_IMAGES", 4),
    agentDir: process.env.POKE_AGENT_DIR?.trim() || undefined,
    filesRoot: optional("POKE_FILES_ROOT", homedir()),
    fileMaxBytes: positiveInt("POKE_FILES_MAX_MB", 8) * 1024 * 1024,
  };
}
