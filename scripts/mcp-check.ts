/**
 * Manual MCP check — does the bot's MCP bridge actually work, end to end?
 *
 * Run: `bun run scripts/mcp-check.ts`. It uses the SAME wiring as the bot:
 * loadMcpBridge discovers your configured MCP servers, the factory registers them
 * via refreshMCPTools, and a real agent turn proves the model can call them.
 * Needs MCP configured (a `.mcp.json` to opt in + servers in your standard MCP
 * config, e.g. Claude Code). Skips cleanly if nothing is configured.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { PiRuntime } from "../src/pi/runtime.ts";
import { loadMcpBridge } from "../src/mcp/bridge.ts";
import { buildPersona } from "../src/pi/persona.ts";
import { ConversationSessions } from "../src/sessions/store.ts";
import { extractAssistantText } from "../src/discord/delivery.ts";

process.env.DISCORD_TOKEN ??= "fake-token-for-mcp-check";

function textOf(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
}

const logger = createLogger("mcp-check");
const config = loadConfig();
const runtime = await PiRuntime.create(config, logger);

// MCP is opt-in via a `.mcp.json`. Use a temp one so this check runs without
// committing a config to the repo; discovery still finds your global MCP servers.
const mcpDir = mkdtempSync(join(tmpdir(), "poke-mcp-check-"));
writeFileSync(join(mcpDir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
console.log("[1] loadMcpBridge — the bot's real path (temp .mcp.json opts MCP in)…");
const bridge = await loadMcpBridge(mcpDir, runtime.authStorage, logger.child("mcp"));
if (!bridge) {
  console.log("No MCP configured. Add a `.mcp.json` (even `{}`) to opt in, plus servers in your");
  console.log("standard MCP config (e.g. ~/.claude.json or .mcp.json). Nothing to check — exiting.");
  process.exit(0);
}
console.log("  servers:", bridge.servers);
console.log("  tools:", bridge.tools.length, "→", bridge.tools.map((t) => t.name).slice(0, 12).join(", "));

// Deterministic proof the tools return real data: if context7 is here, fetch zod docs.
const docs = bridge.tools.find((t) => /context.*(docs|query)/i.test(t.name));
if (docs) {
  console.log(`\n[2] direct call: ${docs.name} for /colinhacks/zod…`);
  const ctx = {
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "check" },
  } as unknown as CustomToolContext;
  const res = await docs.execute(
    "c1",
    { libraryId: "/colinhacks/zod", context7CompatibleLibraryID: "/colinhacks/zod", libraryName: "zod", topic: "z.object", query: "z.object schema" },
    undefined,
    ctx,
  );
  const text = textOf(res as { content?: { type: string; text?: string }[] });
  console.log(`  → ${res.isError ? "ERROR" : `${text.length} chars`}: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
}

// End-to-end: the agent must CALL an MCP tool (not hallucinate <use_mcp_tool> text).
console.log("\n[3] agent end-to-end (factory registers MCP tools via refreshMCPTools)…");
const persona = buildPersona({ botName: config.botName, capabilities: [...bridge.capabilities], setupGuides: [] });
const conversations = new ConversationSessions({ runtime, config, persona, tools: [], mcpTools: bridge.tools, logger });
conversations.start();
const prompt = docs
  ? "Use context7 to look up the zod library docs, then in one sentence say what z.object does."
  : "List the MCP tools you can call, then actually call one of them and report the result.";
let reply = "";
await conversations.run("mcp-check", async (session) => {
  await session.prompt(prompt);
  reply = extractAssistantText(session.getLastAssistantMessage());
});
console.log("  reply:", reply.replace(/\s+/g, " ").slice(0, 320));

await conversations.dispose();
await bridge.dispose();
rmSync(mcpDir, { recursive: true, force: true });

const hallucinated = /<use_mcp_tool>/.test(reply);
console.log("\n=== RESULT ===");
console.log("  bridge loaded MCP tools:", bridge.tools.length > 0);
console.log("  agent called a tool natively (no <use_mcp_tool> hallucination):", !hallucinated && reply.trim().length > 0);
process.exit(hallucinated ? 1 : 0);
