/**
 * MCP bridge — the long tail. The popular apps ship built in (see `catalog.ts` /
 * `builtin.ts`); this covers everything else. Poke's own answer for "everything
 * else" (Sentry, context7, your own servers, …) is MCP, and pi speaks MCP
 * natively, so instead of hand-writing dozens of integrations we ride the
 * standard MCP config.
 *
 * Opt-in: a `.mcp.json` next to the bot turns MCP on (no file ⇒ no MCP). Once on,
 * pi discovers servers from the usual places — that `.mcp.json` PLUS your global
 * MCP config (Claude Code's `~/.claude.json`, marketplace plugins, etc.) — so the
 * servers you already use elsewhere come along for free. Tools load once at
 * startup (cached, so no spawn), are shared across conversations, and the per-
 * session factory registers them via `refreshMCPTools` (NOT customTools) — that's
 * what actually lets the model call them. Unauthed HTTP servers log a warning and
 * are skipped; everything else proceeds.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AuthStorage, CustomTool } from "@oh-my-pi/pi-coding-agent";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp";
import type { Logger } from "../logger.ts";

export interface McpBridge {
  /** Tools from every connected server, ready to merge into the agent's tool set. */
  readonly tools: CustomTool[];
  /**
   * Persona lines for what's connected — one per built-in app (curated text), or
   * a single line naming the long-tail servers. Empty when nothing is advertised.
   */
  readonly capabilities: readonly string[];
  /** Names of the servers that connected. */
  readonly servers: string[];
  /** Disconnect every server (kills stdio child processes). Call on shutdown. */
  dispose(): Promise<void>;
}

/** Standard MCP config filename, the same one Cursor/Claude use. */
export const MCP_CONFIG_FILE = ".mcp.json";

/**
 * Load MCP tools (the `.mcp.json` opt-in + your global MCP config). Returns null
 * when MCP isn't opted in or no server yields tools. Per-server errors (e.g. an
 * HTTP server needing OAuth) are logged, not fatal.
 */
export async function loadMcpBridge(
  cwd: string,
  authStorage: AuthStorage,
  logger: Logger,
): Promise<McpBridge | null> {
  if (!existsSync(join(cwd, MCP_CONFIG_FILE))) return null;

  const result = await discoverAndLoadMCPTools(cwd, { authStorage, enableProjectConfig: true });
  for (const failure of result.errors) {
    logger.warn("mcp server failed to load", { server: failure.path, error: failure.error });
  }
  const tools = result.tools.map((loaded) => loaded.tool);
  if (tools.length === 0) {
    await result.manager.disconnectAll().catch(() => {});
    return null;
  }

  // `connectedServers` is empty when tools come from pi's cache (no live spawn at
  // startup — the server is dialed lazily on first call), so fall back to each
  // tool's source label so we still report what's available.
  const servers =
    result.connectedServers.length > 0
      ? result.connectedServers
      : [...new Set(result.tools.map((t) => t.path.replace(/^mcp:/, "").replace(/ via .*$/, "")))];

  logger.info("mcp ready", { servers, tools: tools.length });
  return {
    tools,
    capabilities: [`Use tools from connected MCP servers: ${servers.join(", ")}`],
    servers,
    dispose: () => result.manager.disconnectAll(),
  };
}
