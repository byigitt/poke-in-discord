import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Config } from "../../config.ts";
import type { Logger } from "../../logger.ts";
import type { IntegrationContext } from "../types.ts";
import { shellIntegration } from "./index.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function textOf(result: { content: { type: string }[] }): string {
  return result.content.map((c) => (c.type === "text" ? (c as TextContent).text : "")).join("");
}

// run_command ignores the per-call CustomToolContext.
const toolCtx = {} as CustomToolContext;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-shell-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runCommand(config: Partial<Config>, params: unknown) {
  const ctx = {
    config: { shellCwd: dir, shellTimeoutMs: 5000, ...config } as unknown as Config,
    logger: silent,
  } as unknown as IntegrationContext;
  const tools = await shellIntegration.tools(ctx);
  const tool = tools.find((t) => t.name === "run_command");
  if (!tool) throw new Error("run_command not built");
  return tool.execute("c", params, undefined, toolCtx);
}

describe("run_command", () => {
  test("returns stdout and a zero exit code", async () => {
    const res = await runCommand({}, { command: "echo hello-shell" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("hello-shell");
    expect(textOf(res)).toContain("exit 0");
  });

  test("surfaces a non-zero exit code", async () => {
    const res = await runCommand({}, { command: "exit 3" });
    expect(textOf(res)).toContain("exit 3");
  });

  test("runs in the configured working directory", async () => {
    const res = await runCommand({}, { command: "pwd" });
    expect(textOf(res)).toContain(basename(dir));
  });

  test("captures stderr as well as stdout", async () => {
    const res = await runCommand({}, { command: "echo oops 1>&2" });
    expect(textOf(res)).toContain("oops");
  });

  test("kills a command that exceeds the timeout", async () => {
    const res = await runCommand({ shellTimeoutMs: 200 }, { command: "sleep 5" });
    expect(textOf(res).toLowerCase()).toContain("timed out");
  });

  test("truncates very long output", async () => {
    const res = await runCommand({}, { command: "yes abcdefghij | head -n 5000" });
    expect(textOf(res)).toContain("truncated");
  });
});
