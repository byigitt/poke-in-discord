/**
 * MCP bridge — the long tail. Poke's own answer for "everything else" (Notion,
 * Linear, GitHub, Sentry, …) is MCP, and pi speaks MCP natively, so instead of
 * hand-writing dozens of integrations we let the operator drop a standard
 * `.mcp.json` next to the bot and every server's tools come along for the ride.
 *
 * Gated like everything else: no `.mcp.json` ⇒ no MCP, no capability, no open
 * connections. When present, we connect once at startup (tools are shared across
 * conversations, same as integration tools) and disconnect on shutdown so stdio
 * servers don't outlive the bot.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AuthStorage, CustomTool } from "@oh-my-pi/pi-coding-agent";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp";
import type { Logger } from "../logger.ts";

export interface McpBridge {
  /** Tools from every connected server, ready to merge into the agent's tool set. */
  readonly tools: CustomTool[];
  /** One persona line naming the connected servers, or undefined if none. */
  readonly capability?: string;
  /** Names of the servers that connected. */
  readonly servers: string[];
  /** Disconnect every server (kills stdio child processes). Call on shutdown. */
  dispose(): Promise<void>;
}

/** Standard MCP config filename, the same one Cursor/Claude use. */
export const MCP_CONFIG_FILE = ".mcp.json";

/**
 * Connect to the MCP servers declared in `<cwd>/.mcp.json`, or return null when
 * there's no config or nothing connects. Errors per server are logged, not fatal.
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
  if (result.connectedServers.length === 0) {
    await result.manager.disconnectAll().catch(() => {});
    return null;
  }

  logger.info("mcp connected", { servers: result.connectedServers, tools: result.tools.length });
  return {
    tools: result.tools.map((loaded) => loaded.tool),
    capability: `Use tools from connected MCP servers: ${result.connectedServers.join(", ")}`,
    servers: result.connectedServers,
    dispose: () => result.manager.disconnectAll(),
  };
}
