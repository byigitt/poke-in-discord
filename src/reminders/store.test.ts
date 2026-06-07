import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderStore } from "./store.ts";

let dir: string;
let store: ReminderStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-rem-"));
  store = new ReminderStore(join(dir, "reminders.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ReminderStore", () => {
  test("add returns the reminder with an assigned id", () => {
    const r = store.add({ userId: "u1", channelId: "c1", text: "call mom", dueAt: 1000 });
    expect(r.id).toBeGreaterThan(0);
    expect(r).toMatchObject({ userId: "u1", channelId: "c1", text: "call mom", dueAt: 1000 });
  });

  test("due returns reminders at or before now, oldest first; future ones excluded", () => {
    store.add({ userId: "u", channelId: "c", text: "late", dueAt: 100 });
    store.add({ userId: "u", channelId: "c", text: "early", dueAt: 50 });
    store.add({ userId: "u", channelId: "c", text: "future", dueAt: 10_000 });
    expect(store.due(200).map((r) => r.text)).toEqual(["early", "late"]);
  });

  test("listForUser is soonest-first and isolated per user", () => {
    store.add({ userId: "u1", channelId: "c", text: "a", dueAt: 200 });
    store.add({ userId: "u1", channelId: "c", text: "b", dueAt: 100 });
    store.add({ userId: "u2", channelId: "c", text: "c", dueAt: 50 });
    expect(store.listForUser("u1").map((r) => r.text)).toEqual(["b", "a"]);
    expect(store.listForUser("u2").map((r) => r.text)).toEqual(["c"]);
  });

  test("remove deletes by id and reports whether it existed", () => {
    const r = store.add({ userId: "u", channelId: "c", text: "x", dueAt: 1 });
    expect(store.remove(r.id)).toBe(true);
    expect(store.remove(r.id)).toBe(false);
    expect(store.due(10)).toEqual([]);
  });

  test("removeOwned only deletes the owner's reminder", () => {
    const r = store.add({ userId: "u1", channelId: "c", text: "x", dueAt: 1 });
    expect(store.removeOwned(r.id, "u2")).toBe(false);
    expect(store.removeOwned(r.id, "u1")).toBe(true);
  });

  test("survives a reopen (reminders persist across restarts)", () => {
    store.add({ userId: "u", channelId: "c", text: "persisted", dueAt: 5 });
    store.close();
    const reopened = new ReminderStore(join(dir, "reminders.db"));
    expect(reopened.due(10).map((r) => r.text)).toEqual(["persisted"]);
    reopened.close();
  });
});
