/**
 * Connects the built-in MCP catalog. Where `bridge.ts` rides a `.mcp.json` for
 * the long tail, this dials the curated apps in `catalog.ts` directly: it builds
 * an MCP manager, connects every server whose credential is configured, and
 * returns their tools plus one persona line each — the same {@link McpBridge}
 * shape the file bridge returns, so the bot merges them the same way.
 *
 * The pi MCP manager awaits each server's `initialize` + `tools/list` on a cold
 * start (no cache here, same as the file bridge), so a server that connects ends
 * up in `connectedServers` with its tools in the snapshot; one that fails (bad
 * token, network) lands in `errors` — logged, never fatal — and is neither
 * advertised nor counted.
 */
import { MCPManager, type MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { Logger } from "../logger.ts";
import type { McpBridge } from "./bridge.ts";
import { type BuiltinMcpServer, selectBuiltinServers } from "./catalog.ts";

/**
 * Connect every built-in server whose credential is present in `env`. Returns
 * null when none are configured or none connect — so an operator who set no
 * tokens pays nothing and the bot offers nothing it can't back up.
 */
export async function loadBuiltinMcp(
  catalog: readonly BuiltinMcpServer[],
  env: Record<string, string | undefined>,
  cwd: string,
  logger: Logger,
): Promise<McpBridge | null> {
  const { enabled, skipped } = selectBuiltinServers(catalog, env);
  for (const skip of skipped) {
    logger.debug("built-in app off — no credential", { name: skip.name, tokenEnv: skip.tokenEnv });
  }
  if (enabled.length === 0) return null;

  const configs: Record<string, MCPServerConfig> = {};
  for (const server of enabled) configs[server.name] = server.config;

  const manager = new MCPManager(cwd);
  const result = await manager.connectServers(configs, {});
  for (const [name, error] of result.errors) {
    logger.warn("built-in app failed to connect", { name, error });
  }

  const connected = new Set(result.connectedServers);
  const ready = enabled.filter((server) => connected.has(server.name));
  if (ready.length === 0) {
    await manager.disconnectAll().catch(() => {});
    return null;
  }

  logger.info("built-in mcp ready", { servers: ready.map((s) => s.name), tools: result.tools.length });
  return {
    tools: result.tools as CustomTool[],
    capabilities: ready.map((server) => server.capability),
    servers: ready.map((server) => server.name),
    dispose: () => manager.disconnectAll(),
  };
}
