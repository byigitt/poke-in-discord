/**
 * Live smoke test of the full assembled pipeline WITHOUT Discord:
 * config → PiRuntime (pi auth) → integrations → persona → ConversationSessions.
 * Exercises voice, memory, a real tool call, and the no-fabrication guardrail.
 * Throwaway — run manually with `bun run scripts/smoke.ts`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { PiRuntime } from "../src/pi/runtime.ts";
import { buildPersona } from "../src/pi/persona.ts";
import { IntegrationRegistry } from "../src/integrations/registry.ts";
import { clockIntegration } from "../src/integrations/examples/clock.ts";
import { ConversationSessions } from "../src/sessions/store.ts";
import { extractAssistantText, toDiscordMessages } from "../src/discord/delivery.ts";
import type { ImageContent } from "@oh-my-pi/pi-ai";

// Set env before loadConfig() is called (no module reads these at import time).
const tmp = mkdtempSync(join(tmpdir(), "poke-smoke-"));
process.env.DISCORD_TOKEN = "fake-token-for-smoke";
process.env.POKE_SESSION_DIR = tmp;
process.env.POKE_THINKING = "off";
process.env.POKE_BOT_NAME = "Poke";

const logger = createLogger("smoke");
const config = loadConfig();
const runtime = await PiRuntime.create(config, logger);

// Enable the example tool integration to validate the extensibility surface end-to-end.
const registry = new IntegrationRegistry().register(clockIntegration);
const tools = await registry.buildTools({ runtime, config, logger: logger.child("integrations") });
const persona = buildPersona({ botName: config.botName, capabilities: registry.capabilities() });
console.log(`\ntools: ${tools.map((t) => t.name).join(", ")}`);
console.log(`capabilities: ${JSON.stringify(registry.capabilities())}`);

const conversations = new ConversationSessions({ runtime, config, persona, tools, logger });
const KEY = "smoke-channel";

async function ask(text: string, images?: ImageContent[]): Promise<string[]> {
  let bubbles: string[] = [];
  await conversations.run(KEY, async (session) => {
    await session.prompt(text, images ? { images } : undefined);
    const reply = extractAssistantText(session.getLastAssistantMessage());
    bubbles = toDiscordMessages(reply, config.maxReplyMessages);
  });
  console.log(`\n> ${text}${images?.length ? ` [+${images.length} image]` : ""}`);
  bubbles.forEach((b, i) => console.log(`  [bubble ${i + 1}] ${b}`));
  return bubbles;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// 1) Basic voice
const hello = (await ask("yo")).join(" ");
assert(hello.length > 0, "responds to a greeting");

// 2) Memory across turns
await ask("my name is Barış and I'm building a discord bot");
const recall = (await ask("what's my name?")).join(" ");
assert(/bar[ıi]ş/i.test(recall), "remembers the user's name within the conversation");

// 3) Real tool call through the integration surface
const time = (await ask("what time is it in Tokyo right now? just tell me")).join(" ");
assert(/\d/.test(time), "used the clock tool (reply contains a time)");

// 4) No fabrication when asked for a capability it doesn't have
const email = (await ask("send an email to my boss saying I'll be late")).join(" ").toLowerCase();
assert(
  /can't|cannot|can not|not able|don'?t have|no (access|way)|unable/.test(email),
  "refuses an action it can't actually do (no fabrication)",
);

// 5) Reset clears memory
await conversations.reset(KEY);
const afterReset = (await ask("what's my name?")).join(" ");
assert(!/bar[ıi]ş/i.test(afterReset), "reset wiped the conversation memory");

// 6) Delivery splitter unit behavior
const fenced = "here you go\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\ndone";
const split = toDiscordMessages(fenced, 5);
assert(split.some((m) => m.includes("```ts") && m.includes("const b = 2;")), "keeps a fenced code block intact");

// 7) Vision: an image attachment actually reaches the model (only when it accepts images).
if (runtime.model.input.includes("image")) {
  // A 48x48 solid crimson PNG, base64-encoded (see src/discord/attachments.ts for the real path).
  const crimsonPng =
    "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAVElEQVR4nO3UUQ0AIAzEUEQgB/8qJgYXlI+XTMByabtmn69u5R94yEIYYlkdHh2yEIZYVodHhyyEIZbV4dEhC2GIZXV4dMhCGGJZHR4dshCG5q1lF0KTjJdAHIiQAAAAAElFTkSuQmCC";
  const image: ImageContent = { type: "image", data: crimsonPng, mimeType: "image/png" };
  const seen = (await ask("in one word, what color is this image?", [image])).join(" ").toLowerCase();
  assert(/red|crimson|pink|maroon|rose/.test(seen), "describes the attached image (sees the red square)");
} else {
  console.log("\n  (skipping vision check — resolved model has no image input)");
}

await conversations.dispose();
console.log("\nALL SMOKE CHECKS PASSED");
process.exit(0);
