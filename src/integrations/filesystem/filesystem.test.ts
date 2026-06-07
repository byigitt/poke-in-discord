import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Config } from "../../config.ts";
import type { Logger } from "../../logger.ts";
import type { PiRuntime } from "../../pi/runtime.ts";
import { ReplyOutbox } from "../../outbox.ts";
import type { ActorRegistry } from "../../actor.ts";
import type { ConnectionManager } from "../../connections/manager.ts";
import type { CustomTool, IntegrationContext } from "../types.ts";
import { filesystemIntegration } from "./index.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** A tool result reduced to its visible text. */
function textOf(result: { content: { type: string }[] }): string {
  return result.content.map((c) => (c.type === "text" ? (c as TextContent).text : "")).join("");
}

const UPLOAD_CAP = 1024;

let parent: string;
let root: string;
let outbox: ReplyOutbox;
let tools: Map<string, CustomTool>;

beforeAll(async () => {
  parent = mkdtempSync(join(tmpdir(), "poke-fs-"));
  root = join(parent, "root");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "hello notes");
  writeFileSync(join(root, "sub", "deep.txt"), "deep content");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0x68, 0x00, 0x69])); // embedded NUL
  writeFileSync(join(root, "big.txt"), "x".repeat(UPLOAD_CAP * 2)); // over the upload cap
  writeFileSync(join(parent, "secret.txt"), "TOP SECRET"); // sibling, outside the root
  symlinkSync(join(parent, "secret.txt"), join(root, "leak.txt")); // a link escaping the root

  outbox = new ReplyOutbox();
  const ctx: IntegrationContext = {
    runtime: undefined as unknown as PiRuntime, // unused by the file tools
    config: { filesRoot: root, fileMaxBytes: UPLOAD_CAP } as unknown as Config,
    logger: silent,
    outbox,
    // The file tools use neither; satisfy the context shape without a real DB.
    connections: undefined as unknown as ConnectionManager,
    actor: undefined as unknown as ActorRegistry,
  };
  tools = new Map((await filesystemIntegration.tools(ctx)).map((t) => [t.name, t]));
});

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
});

const session = (file?: string): CustomToolContext =>
  ({ sessionManager: { getSessionFile: () => file } }) as unknown as CustomToolContext;

async function run(name: string, params: unknown, sessionFile?: string) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} was not built`);
  return tool.execute("call-1", params, undefined, session(sessionFile));
}

describe("list_directory", () => {
  test("lists files and folders under the root", async () => {
    const res = await run("list_directory", {});
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("notes.txt");
    expect(text).toContain("sub");
  });

  test("refuses an absolute path outside the root", async () => {
    const res = await run("list_directory", { path: "/etc" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("outside");
  });
});

describe("search_files", () => {
  test("finds a file nested in a subfolder", async () => {
    const res = await run("search_files", { query: "deep", limit: 50 });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(join("sub", "deep.txt"));
  });

  test("matches a glob against the filename", async () => {
    const res = await run("search_files", { query: "*.txt", limit: 50 });
    const text = textOf(res);
    expect(text).toContain("notes.txt");
    expect(text).toContain("deep.txt");
  });

  test("reports no matches cleanly", async () => {
    const res = await run("search_files", { query: "does-not-exist-anywhere", limit: 50 });
    expect(res.isError).toBeFalsy();
    expect(textOf(res).toLowerCase()).toContain("no files");
  });
});

describe("read_text_file", () => {
  test("returns a text file's contents", async () => {
    const res = await run("read_text_file", { path: "notes.txt" });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("hello notes");
  });

  test("refuses a binary file and points at send_file", async () => {
    const res = await run("read_text_file", { path: "binary.bin" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("send_file");
  });

  test("errors on a missing file", async () => {
    const res = await run("read_text_file", { path: "nope.txt" });
    expect(res.isError).toBe(true);
  });
});

describe("send_file", () => {
  test("stages a file for upload, keyed by the session", async () => {
    const key = "/sessions/upload.jsonl";
    const res = await run("send_file", { path: "notes.txt" }, key);
    expect(res.isError).toBeFalsy();
    const staged = outbox.drain(key);
    expect(staged.map((f) => f.name)).toEqual(["notes.txt"]);
    expect(staged[0]!.path.endsWith(join("root", "notes.txt"))).toBe(true);
  });

  test("rejects a file larger than the cap and stages nothing", async () => {
    const key = "/sessions/big.jsonl";
    const res = await run("send_file", { path: "big.txt" }, key);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("too big");
    expect(outbox.drain(key)).toEqual([]);
  });

  test("refuses a path that traverses outside the root", async () => {
    const key = "/sessions/traversal.jsonl";
    const res = await run("send_file", { path: "../secret.txt" }, key);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("outside");
    expect(outbox.drain(key)).toEqual([]);
  });

  test("refuses a symlink that escapes the root", async () => {
    const key = "/sessions/symlink.jsonl";
    const res = await run("send_file", { path: "leak.txt" }, key);
    expect(res.isError).toBe(true);
    expect(outbox.drain(key)).toEqual([]);
  });

  test("needs a live session to attach to", async () => {
    const res = await run("send_file", { path: "notes.txt" }, undefined);
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("can't attach");
  });
});
