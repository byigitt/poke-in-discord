import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { silentLogger } from "../test-support.ts";
import { loadMcpBridge, type McpBridge } from "./bridge.ts";

// The fixture server is no-auth; the bridge only forwards this to the loader.
const noAuth = undefined as unknown as AuthStorage;
const ECHO_SERVER = join(import.meta.dir, "fixtures", "echo-server.ts");

let dir: string;
let bridge: McpBridge | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-mcp-"));
});

afterEach(async () => {
  await bridge?.dispose().catch(() => {});
  bridge = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadMcpBridge", () => {
  test("returns null when there is no .mcp.json (MCP simply off)", async () => {
    bridge = await loadMcpBridge(dir, noAuth, silentLogger);
    expect(bridge).toBeNull();
  });

  test("connects to a configured stdio server and surfaces its tools", async () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { echo: { command: "bun", args: ["run", ECHO_SERVER] } } }),
    );

    bridge = await loadMcpBridge(dir, noAuth, silentLogger);
    expect(bridge).not.toBeNull();
    expect(bridge!.servers).toContain("echo");
    expect(bridge!.capability).toContain("echo");
    // The fixture exposes one tool, "echo" (pi may namespace it, so match loosely).
    expect(bridge!.tools.some((t) => t.name.includes("echo"))).toBe(true);
  }, 20_000);
});
