import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
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

  test("stores a cron expression for recurring reminders", () => {
    const r = store.add({ userId: "u", channelId: "c", text: "standup", dueAt: 1000, cron: "0 9 * * 1-5" });
    expect(r.cron).toBe("0 9 * * 1-5");
    expect(store.due(2000)[0]!.cron).toBe("0 9 * * 1-5");
  });

  test("one-shot reminders have no cron", () => {
    store.add({ userId: "u", channelId: "c", text: "once", dueAt: 1000 });
    expect(store.due(2000)[0]!.cron).toBeUndefined();
  });

  test("reschedule moves a reminder to a new time without removing it", () => {
    const r = store.add({ userId: "u", channelId: "c", text: "roll", dueAt: 100, cron: "0 9 * * *" });
    expect(store.reschedule(r.id, 9999)).toBe(true);
    expect(store.due(50)).toEqual([]); // no longer due at the old time
    expect(store.due(10_000).map((x) => x.dueAt)).toEqual([9999]);
  });

  test("migrates an older db that predates the cron column", () => {
    const file = join(dir, "legacy.db");
    const raw = new Database(file, { create: true });
    raw.run(
      `CREATE TABLE reminders (
         id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, channel TEXT NOT NULL,
         text TEXT NOT NULL, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    );
    raw.run("INSERT INTO reminders (user, channel, text, due_at, created_at) VALUES (?, ?, ?, ?, ?)", [
      "u",
      "c",
      "legacy",
      5,
      1,
    ]);
    raw.close();

    const migrated = new ReminderStore(file); // should ALTER TABLE ADD COLUMN cron
    const rows = migrated.due(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("legacy");
    expect(rows[0]!.cron).toBeUndefined();
    migrated.add({ userId: "u", channelId: "c", text: "new", dueAt: 6, cron: "0 9 * * *" });
    expect(migrated.due(10).some((r) => r.cron === "0 9 * * *")).toBe(true);
    migrated.close();
  });
});
