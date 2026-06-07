/**
 * Live smoke test of the full assembled pipeline WITHOUT Discord:
 * config → PiRuntime (pi auth) → integrations → persona → ConversationSessions.
 * Exercises voice, memory, a real tool call, and the no-fabrication guardrail.
 * Throwaway — run manually with `bun run scripts/smoke.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { PiRuntime } from "../src/pi/runtime.ts";
import { buildPersona } from "../src/pi/persona.ts";
import { IntegrationRegistry } from "../src/integrations/registry.ts";
import { clockIntegration } from "../src/integrations/examples/clock.ts";
import { filesystemIntegration } from "../src/integrations/filesystem/index.ts";
import { webSearchIntegration } from "../src/integrations/web-search/index.ts";
import { ConversationSessions } from "../src/sessions/store.ts";
import { extractAssistantText, toDiscordMessages } from "../src/discord/delivery.ts";
import { ReplyOutbox, type PendingFile } from "../src/outbox.ts";
import { ActorRegistry } from "../src/actor.ts";
import { TokenStore } from "../src/connections/store.ts";
import { ConnectionManager } from "../src/connections/manager.ts";
import { resolveProvider } from "../src/connections/oauth.ts";
import { googleCalendarIntegration } from "../src/integrations/google-calendar/index.ts";
import { remindersIntegration } from "../src/integrations/reminders/index.ts";
import { ReminderStore } from "../src/reminders/store.ts";
import { shellIntegration } from "../src/integrations/shell/index.ts";
import type { ImageContent } from "@oh-my-pi/pi-ai";

// Set env before loadConfig() is called (no module reads these at import time).
const tmp = mkdtempSync(join(tmpdir(), "poke-smoke-"));
const filesRoot = join(tmp, "files");
mkdirSync(filesRoot);
const DEMO_FILE = "poke-smoke-demo.txt";
writeFileSync(join(filesRoot, DEMO_FILE), "hello from the poke smoke test\n");
process.env.DISCORD_TOKEN = "fake-token-for-smoke";
process.env.POKE_SESSION_DIR = tmp;
process.env.POKE_FILES_ROOT = filesRoot;
process.env.POKE_THINKING = "off";
process.env.POKE_BOT_NAME = "Poke";

const logger = createLogger("smoke");
const config = loadConfig();
const runtime = await PiRuntime.create(config, logger);

// Enable the example clock tool plus real filesystem access and web search to
// validate the extensibility surface — including file upload staging and a live
// web search through pi's own providers — end-to-end.
const registry = new IntegrationRegistry()
  .register(clockIntegration)
  .register(filesystemIntegration)
  .register(webSearchIntegration)
  .register(remindersIntegration)
  .register(shellIntegration);
const outbox = new ReplyOutbox();
const actor = new ActorRegistry();
const connections = new ConnectionManager(
  new TokenStore(join(tmp, "connections.db")),
  "http://localhost:8787/oauth/callback",
  logger.child("connections"),
);
const reminderStore = new ReminderStore(join(tmp, "reminders.db"));
const tools = await registry.buildTools({ runtime, config, outbox, connections, actor, reminders: reminderStore, logger: logger.child("integrations") });
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

// 8) Filesystem: the bot finds a real local file and stages it for upload. We
// drive the lane directly (instead of `ask`) so we can drain the outbox by the
// same session key the send_file tool routed through.
let staged: PendingFile[] = [];
await conversations.run(KEY, async (session) => {
  await session.prompt(`send me the file called ${DEMO_FILE}`);
  console.log(`\n> send me the file called ${DEMO_FILE}`);
  console.log(`  [reply] ${extractAssistantText(session.getLastAssistantMessage())}`);
  staged = session.sessionFile ? outbox.drain(session.sessionFile) : [];
});
assert(
  staged.some((f) => f.name === DEMO_FILE),
  "found a local file and staged it for upload (send_file → outbox)",
);

// 9) Web search: the bot looks up a current fact online through pi's providers.
// Runs in its own conversation (a fresh session, like a separate channel) so it
// doesn't share a lane with the file-send turn above.
let webReply = "";
await conversations.run("smoke-web", async (session) => {
  await session.prompt("search the web: who won the 2022 fifa world cup? one word");
  webReply = extractAssistantText(session.getLastAssistantMessage());
});
console.log("\n> search the web: who won the 2022 fifa world cup?");
console.log(`  [reply] ${webReply}`);
assert(/argentina/i.test(webReply), "answered from a live web search (web_search via pi)");

// 10) Account linking: the Google Calendar connect flow yields a real consent URL.
// (No live Google account — this verifies the framework + integration wiring.)
const gcalProvider = resolveProvider(googleCalendarIntegration.connection!, {
  GOOGLE_CLIENT_ID: "smoke-client-id",
  GOOGLE_CLIENT_SECRET: "smoke-secret",
});
connections.registerProvider(gcalProvider!);
const connectUrl = connections.beginConnect("smoke-user", "google-calendar") ?? "";
console.log(`\n> connect google-calendar\n  ${connectUrl.slice(0, 90)}…`);
assert(
  connectUrl.includes("accounts.google.com") && connectUrl.includes("calendar.events"),
  "connect google-calendar produces a real Google consent URL",
);

// 11) Reminders: the model schedules one via set_reminder, keyed to user + channel.
// (We set the actor by hand here since we're not going through the bot.)
let remindReply = "";
await conversations.run("smoke-remind", async (session) => {
  if (session.sessionFile) actor.enter(session.sessionFile, { userId: "smoke-user", channelId: "smoke-remind" });
  try {
    await session.prompt("remind me to stretch my legs in 10 minutes");
    remindReply = extractAssistantText(session.getLastAssistantMessage());
  } finally {
    if (session.sessionFile) actor.leave(session.sessionFile);
  }
});
console.log(`\n> remind me to stretch my legs in 10 minutes\n  [reply] ${remindReply}`);
const scheduled = reminderStore.listForUser("smoke-user");
assert(scheduled.length >= 1 && /stretch|legs/i.test(scheduled.at(-1)!.text), "scheduled a reminder via set_reminder");

// 12) Reminder delivery: the agent turns a fired reminder into a natural nudge
// (the same injection the bot's scheduler uses on its own channel lane).
let nudge = "";
await conversations.run("smoke-nudge", async (session) => {
  await session.prompt(
    `[reminder due] Earlier the user asked to be reminded: "stretch your legs". It's time — nudge them now, briefly, in your own voice. Don't mention reminders or any machinery.`,
  );
  nudge = extractAssistantText(session.getLastAssistantMessage());
});
console.log(`\n[reminder fires]\n  [reply] ${nudge}`);
assert(nudge.trim().length > 0 && /stretch|leg/i.test(nudge), "delivers a fired reminder as a natural nudge");

// 13) Recurring reminders: the model schedules a cron-based (weekly/daily) one.
let recurReply = "";
await conversations.run("smoke-recur", async (session) => {
  if (session.sessionFile) actor.enter(session.sessionFile, { userId: "recur-user", channelId: "smoke-recur" });
  try {
    await session.prompt("every weekday at 9am, remind me to check standup");
    recurReply = extractAssistantText(session.getLastAssistantMessage());
  } finally {
    if (session.sessionFile) actor.leave(session.sessionFile);
  }
});
console.log(`\n> every weekday at 9am, remind me to check standup\n  [reply] ${recurReply}`);
const recurring = reminderStore.listForUser("recur-user");
assert(recurring.length >= 1 && Boolean(recurring.at(-1)!.cron), "scheduled a recurring (cron) reminder");
console.log(`  [stored cron] ${recurring.at(-1)!.cron}`);

// 14) Shell: the bot actually runs a command on the host and reads its output.
let shellReply = "";
await conversations.run("smoke-shell", async (session) => {
  await session.prompt("run this command and tell me the output: echo poke-shell-works");
  shellReply = extractAssistantText(session.getLastAssistantMessage());
});
console.log(`\n> run: echo poke-shell-works\n  [reply] ${shellReply}`);
assert(/poke-shell-works/.test(shellReply), "ran a shell command and reported its output (run_command)");

// 15) File write: the bot creates a file on disk with the content it's asked for.
let writeReply = "";
await conversations.run("smoke-write", async (session) => {
  await session.prompt("create a file called poke-write-test.txt with exactly this text: buy milk");
  writeReply = extractAssistantText(session.getLastAssistantMessage());
});
console.log(`\n> create a file poke-write-test.txt ("buy milk")\n  [reply] ${writeReply}`);
const written = readFileSync(join(filesRoot, "poke-write-test.txt"), "utf8");
assert(/buy milk/i.test(written), "wrote a file to disk (write_file)");

await conversations.dispose();
console.log("\nALL SMOKE CHECKS PASSED");
process.exit(0);
