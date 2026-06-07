/**
 * Entrypoint. Boots pi's auth + model systems, assembles the persona and tools
 * from the enabled integrations, and starts the Discord bot. Shuts down cleanly
 * so in-flight conversations flush their history to disk.
 */
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { buildPersona } from "./pi/persona.ts";
import { PiRuntime } from "./pi/runtime.ts";
import { IntegrationRegistry } from "./integrations/registry.ts";
import { enabledIntegrations } from "./integrations/index.ts";
import { ConversationSessions } from "./sessions/store.ts";
import { DiscordBot } from "./discord/bot.ts";
import { ReplyOutbox } from "./outbox.ts";

const logger = createLogger("poke");

async function main(): Promise<void> {
  const config = loadConfig();

  const runtime = await PiRuntime.create(config, logger);

  // Shared between the file tools (which stage files to upload) and the bot
  // (which drains and uploads them after each turn).
  const outbox = new ReplyOutbox();
  const registry = new IntegrationRegistry().registerAll(enabledIntegrations());
  const tools = await registry.buildTools({ runtime, config, outbox, logger: logger.child("integrations") });
  const persona = buildPersona({ botName: config.botName, capabilities: registry.capabilities() });
  logger.info("persona assembled", { botName: config.botName, integrations: registry.size, tools: tools.length });

  const conversations = new ConversationSessions({ runtime, config, persona, tools, logger });
  conversations.start();

  const supportsImages = runtime.model.input.includes("image");
  logger.info("vision support", { supportsImages });
  const bot = new DiscordBot(config, conversations, supportsImages, outbox, logger);
  await bot.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    await bot.stop().catch((error) => logger.error("bot stop failed", { error }));
    await conversations.dispose().catch((error) => logger.error("session flush failed", { error }));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error("fatal startup error", { error });
  process.exitCode = 1;
});
