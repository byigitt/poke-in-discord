import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../test-support.ts";
import { loadBuiltinMcp } from "./builtin.ts";
import type { BuiltinMcpServer } from "./catalog.ts";
import type { McpBridge } from "./bridge.ts";

// A real stdio MCP server (the same fixture the file bridge tests use), reached
// through a synthetic catalog entry so the loader's connect path is exercised
// end-to-end without any external dependency.
const ECHO_SERVER = join(import.meta.dir, "fixtures", "echo-server.ts");

const echoApp: BuiltinMcpServer = {
  name: "echo",
  label: "Echo",
  capability: "Echo text back",
  tokenEnv: ["ECHO_TOKEN"],
  setup: { credential: "an echo token" },
  transport: { type: "stdio", command: "bun", args: ["run", ECHO_SERVER], tokenVar: "ECHO_TOKEN" },
};

let dir: string;
let bridge: McpBridge | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-builtin-"));
});

afterEach(async () => {
  await bridge?.dispose().catch(() => {});
  bridge = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadBuiltinMcp", () => {
  test("returns null when no built-in app has a configured credential", async () => {
    bridge = await loadBuiltinMcp([echoApp], {}, dir, silentLogger);
    expect(bridge).toBeNull();
  });

  test("connects a configured app and surfaces its tools, capability, and name", async () => {
    bridge = await loadBuiltinMcp([echoApp], { ECHO_TOKEN: "secret" }, dir, silentLogger);
    expect(bridge).not.toBeNull();
    expect(bridge!.servers).toContain("echo");
    expect(bridge!.capabilities).toContain("Echo text back");
    // The fixture exposes one tool, "echo" (pi namespaces it as mcp__echo_…).
    expect(bridge!.tools.some((t) => t.name.includes("echo"))).toBe(true);
  }, 20_000);

  test("only advertises and connects apps whose credential is present", async () => {
    const ghost: BuiltinMcpServer = {
      name: "ghost",
      label: "Ghost",
      capability: "Never loads",
      tokenEnv: ["GHOST_TOKEN"],
      setup: { credential: "a ghost token" },
      transport: { type: "stdio", command: "bun", args: ["run", ECHO_SERVER], tokenVar: "GHOST_TOKEN" },
    };
    bridge = await loadBuiltinMcp([echoApp, ghost], { ECHO_TOKEN: "secret" }, dir, silentLogger);
    expect(bridge!.servers).toEqual(["echo"]);
    expect(bridge!.capabilities).toEqual(["Echo text back"]);
  }, 20_000);
});
