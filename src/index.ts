/**
 * Entrypoint. Boots pi's auth + model systems, env-gates the integration catalog,
 * wires the account-linking framework (token store + OAuth manager + callback
 * server), assembles the persona and tools, and starts the Discord bot. Shuts
 * down cleanly so in-flight conversations flush their history to disk.
 */
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { buildPersona, connectionStatusSection } from "./pi/persona.ts";
import { PiRuntime } from "./pi/runtime.ts";
import { IntegrationRegistry } from "./integrations/registry.ts";
import { ALL_INTEGRATIONS } from "./integrations/index.ts";
import { selectConfigured, integrationSetupGuide } from "./integrations/select.ts";
import { resolveProvider } from "./connections/oauth.ts";
import { TokenStore } from "./connections/store.ts";
import { ConnectionManager } from "./connections/manager.ts";
import { OAuthCallbackServer } from "./connections/server.ts";
import { ReminderStore } from "./reminders/store.ts";
import { ConversationSessions } from "./sessions/store.ts";
import { DiscordBot } from "./discord/bot.ts";
import { ReplyOutbox } from "./outbox.ts";
import { ActorRegistry } from "./actor.ts";
import { loadMcpBridge, type McpBridge } from "./mcp/bridge.ts";
import { loadBuiltinMcp } from "./mcp/builtin.ts";
import { BUILTIN_MCP_SERVERS, builtinSetupGuide, dormantBuiltins } from "./mcp/catalog.ts";

const logger = createLogger("poke");

async function main(): Promise<void> {
  const config = loadConfig();

  const runtime = await PiRuntime.create(config, logger);

  // Account-linking framework: per-user OAuth tokens, the manager that mints
  // connect URLs and hands fresh tokens to tools, the per-turn speaker, and the
  // file-upload buffer.
  const tokenStore = new TokenStore(config.connectionsFile);
  const redirectUri = `${config.oauthRedirectBase.replace(/\/+$/, "")}/oauth/callback`;
  const connections = new ConnectionManager(tokenStore, redirectUri, logger.child("connections"));
  const actor = new ActorRegistry();
  const outbox = new ReplyOutbox();
  const reminderStore = new ReminderStore(config.remindersFile);

  // Env-gate the catalog: only configured apps load. Register an OAuth provider
  // for each connectable app that is configured so `connect <app>` works.
  const { enabled, skipped } = selectConfigured(ALL_INTEGRATIONS, process.env);
  for (const skip of skipped) {
    logger.info("integration skipped — missing config", { name: skip.name, missing: skip.missing });
  }
  for (const integration of enabled) {
    if (!integration.connection) continue;
    const provider = resolveProvider(integration.connection, process.env);
    if (provider) connections.registerProvider(provider);
  }

  const registry = new IntegrationRegistry().registerAll(enabled);
  const integrationTools = await registry.buildTools({
    runtime,
    config,
    outbox,
    connections,
    actor,
    reminders: reminderStore,
    logger: logger.child("integrations"),
  });

  // MCP, two ways. First the built-ins: the popular apps (GitHub, Notion, Linear,
  // …) shipped in the box, each connecting only when its credential is in the env.
  // Then the long tail: any servers from your standard MCP config (.mcp.json,
  // Claude Code, etc.). Both yield tools registered per-session via refreshMCPTools
  // (NOT customTools), which is what actually lets the model call them.
  const builtinMcp = await loadBuiltinMcp(BUILTIN_MCP_SERVERS, process.env, process.cwd(), logger.child("mcp"));
  const fileMcp = await loadMcpBridge(process.cwd(), runtime.authStorage, logger.child("mcp"));
  const mcpBridges = [builtinMcp, fileMcp].filter((bridge): bridge is McpBridge => bridge !== null);
  const mcpTools = mcpBridges.flatMap((bridge) => bridge.tools);
  const capabilities = [...registry.capabilities(), ...mcpBridges.flatMap((bridge) => bridge.capabilities)];
  // The knowledge bank: apps that exist but aren't configured (no MCP token, no
  // OAuth client). The persona uses these so the bot can walk a user through
  // turning one on instead of just refusing — built-in MCP apps and dormant
  // OAuth integrations alike. Always-on apps and the shell toggle declare no
  // `setup`, so they never show up here.
  const setupGuides = [
    ...dormantBuiltins(BUILTIN_MCP_SERVERS, process.env).map(builtinSetupGuide),
    ...ALL_INTEGRATIONS.filter((integration) => !enabled.includes(integration))
      .map((integration) => integrationSetupGuide(integration, redirectUri))
      .filter((guide): guide is string => guide !== null),
  ];
  const persona = buildPersona({ botName: config.botName, capabilities, setupGuides });
  logger.info("persona assembled", {
    botName: config.botName,
    integrations: registry.size,
    tools: integrationTools.length,
    mcpServers: mcpBridges.flatMap((bridge) => bridge.servers),
    mcpTools: mcpTools.length,
    setupGuides: setupGuides.length,
  });

  // Live, per-turn ground truth of the speaker's account links, injected into the
  // system prompt each turn. Without it the model only sees the static capability
  // list ("… once they connect it") and can't tell who's connected — so it hedges
  // and asks an already-linked user to connect again. undefined when nothing is
  // connectable, leaving the prompt untouched.
  const connectionCatalog = connections.catalog();
  const connectionStatus =
    connectionCatalog.length > 0
      ? (sessionFile: string): string | null => {
          const current = actor.current(sessionFile);
          return current
            ? connectionStatusSection(connectionCatalog, connections.connections(current.userId))
            : null;
        }
      : undefined;

  const conversations = new ConversationSessions({
    runtime,
    config,
    persona,
    tools: integrationTools,
    mcpTools,
    connectionStatus,
    logger,
  });
  conversations.start();

  // Only open the callback port when something is actually connectable.
  const oauthServer = connections.hasProviders()
    ? new OAuthCallbackServer(connections, config.oauthPort, logger.child("oauth"))
    : null;
  oauthServer?.start();

  const supportsImages = runtime.model.input.includes("image");
  logger.info("vision support", { supportsImages });
  const bot = new DiscordBot(config, conversations, supportsImages, outbox, connections, actor, reminderStore, logger);
  await bot.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    await bot.stop().catch((error) => logger.error("bot stop failed", { error }));
    oauthServer?.stop();
    await conversations.dispose().catch((error) => logger.error("session flush failed", { error }));
    await Promise.all(
      mcpBridges.map((bridge) => bridge.dispose().catch((error) => logger.error("mcp disconnect failed", { error }))),
    );
    tokenStore.close();
    reminderStore.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("fatal startup error", { error });
  process.exitCode = 1;
});
