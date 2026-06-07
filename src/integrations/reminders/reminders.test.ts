import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Config } from "../../config.ts";
import type { Logger } from "../../logger.ts";
import type { PiRuntime } from "../../pi/runtime.ts";
import { ActorRegistry } from "../../actor.ts";
import type { ConnectionManager } from "../../connections/manager.ts";
import { ReplyOutbox } from "../../outbox.ts";
import { ReminderStore } from "../../reminders/store.ts";
import type { CustomTool, IntegrationContext } from "../types.ts";
import { remindersIntegration } from "./index.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function textOf(result: { content: { type: string }[] }): string {
  return result.content.map((c) => (c.type === "text" ? (c as TextContent).text : "")).join("");
}

const SESSION = "/sessions/chan.jsonl";
let dir: string;
let store: ReminderStore;
let tools: Map<string, CustomTool>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "poke-remint-"));
  store = new ReminderStore(join(dir, "reminders.db"));
  const actor = new ActorRegistry();
  actor.enter(SESSION, { userId: "u1", channelId: "c1" });
  const ctx: IntegrationContext = {
    runtime: undefined as unknown as PiRuntime,
    config: {} as unknown as Config,
    logger: silent,
    outbox: new ReplyOutbox(),
    connections: undefined as unknown as ConnectionManager,
    actor,
    reminders: store,
  };
  tools = new Map((await remindersIntegration.tools(ctx)).map((t) => [t.name, t]));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A turn whose actor is registered (default) vs an unknown session (no actor).
const known = (): CustomToolContext =>
  ({ sessionManager: { getSessionFile: () => SESSION, getSessionId: () => "sid" } }) as unknown as CustomToolContext;
const anonymous = (): CustomToolContext =>
  ({ sessionManager: { getSessionFile: () => "/other.jsonl", getSessionId: () => "x" } }) as unknown as CustomToolContext;

describe("set_reminder", () => {
  test("schedules a relative reminder for the current user + channel", async () => {
    const before = Date.now();
    const res = await tools.get("set_reminder")!.execute("c", { text: "call mom", in_minutes: 10 }, undefined, known());
    expect(res.isError).toBeFalsy();
    const stored = store.listForUser("u1");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).toBe("call mom");
    expect(stored[0]!.channelId).toBe("c1");
    expect(stored[0]!.dueAt).toBeGreaterThanOrEqual(before + 10 * 60_000);
  });

  test("schedules an absolute reminder from a future due_at", async () => {
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const res = await tools.get("set_reminder")!.execute("c", { text: "dentist", due_at: due }, undefined, known());
    expect(res.isError).toBeFalsy();
    expect(store.listForUser("u1")[0]!.dueAt).toBe(Date.parse(due));
  });

  test("rejects a time in the past", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await tools.get("set_reminder")!.execute("c", { text: "x", due_at: past }, undefined, known());
    expect(res.isError).toBe(true);
    expect(store.listForUser("u1")).toHaveLength(0);
  });

  test("rejects when given neither in_minutes nor due_at", async () => {
    const res = await tools.get("set_reminder")!.execute("c", { text: "x" }, undefined, known());
    expect(res.isError).toBe(true);
  });

  test("refuses when there's no actor for the turn", async () => {
    const res = await tools.get("set_reminder")!.execute("c", { text: "x", in_minutes: 5 }, undefined, anonymous());
    expect(res.isError).toBe(true);
    expect(store.listForUser("u1")).toHaveLength(0);
  });
});

describe("list_reminders & cancel_reminder", () => {
  test("lists the user's reminders with ids", async () => {
    store.add({ userId: "u1", channelId: "c1", text: "one", dueAt: Date.now() + 1000 });
    const res = await tools.get("list_reminders")!.execute("c", {}, undefined, known());
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("one");
  });

  test("reports an empty list cleanly", async () => {
    const res = await tools.get("list_reminders")!.execute("c", {}, undefined, known());
    expect(textOf(res).toLowerCase()).toContain("no reminders");
  });

  test("cancels an existing reminder by id, rejects unknown ids", async () => {
    const r = store.add({ userId: "u1", channelId: "c1", text: "kill me", dueAt: Date.now() + 1000 });
    const ok = await tools.get("cancel_reminder")!.execute("c", { id: r.id }, undefined, known());
    expect(ok.isError).toBeFalsy();
    expect(store.listForUser("u1")).toHaveLength(0);

    const miss = await tools.get("cancel_reminder")!.execute("c", { id: 9999 }, undefined, known());
    expect(miss.isError).toBe(true);
  });
});
