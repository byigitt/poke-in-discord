import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger.ts";
import { ReminderScheduler } from "./scheduler.ts";
import { type Reminder, ReminderStore } from "./store.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

let dir: string;
let store: ReminderStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-sched-"));
  store = new ReminderStore(join(dir, "reminders.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ReminderScheduler.tick", () => {
  test("delivers due reminders and removes them", async () => {
    store.add({ userId: "u", channelId: "c", text: "due", dueAt: Date.now() - 1000 });
    const delivered: Reminder[] = [];
    const scheduler = new ReminderScheduler(store, async (r) => void delivered.push(r), silent);

    await scheduler.tick();

    expect(delivered.map((r) => r.text)).toEqual(["due"]);
    expect(store.due(Date.now())).toEqual([]);
  });

  test("leaves not-yet-due reminders alone", async () => {
    store.add({ userId: "u", channelId: "c", text: "later", dueAt: Date.now() + 60_000 });
    const delivered: Reminder[] = [];
    const scheduler = new ReminderScheduler(store, async (r) => void delivered.push(r), silent);

    await scheduler.tick();

    expect(delivered).toEqual([]);
    expect(store.listForUser("u").length).toBe(1);
  });

  test("removes a reminder even when delivery throws (fire-once, never stuck)", async () => {
    store.add({ userId: "u", channelId: "c", text: "boom", dueAt: Date.now() - 1 });
    const scheduler = new ReminderScheduler(store, async () => {
      throw new Error("delivery failed");
    }, silent);

    await scheduler.tick();

    expect(store.due(Date.now())).toEqual([]);
  });

  test("ticks never overlap, so a slow delivery can't double-fire", async () => {
    store.add({ userId: "u", channelId: "c", text: "slow", dueAt: Date.now() - 1 });
    let active = 0;
    let maxActive = 0;
    let deliveries = 0;
    const scheduler = new ReminderScheduler(store, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      deliveries++;
      await delay(30);
      active--;
    }, silent);

    await Promise.all([scheduler.tick(), scheduler.tick()]);

    expect(maxActive).toBe(1);
    expect(deliveries).toBe(1);
  });

  test("recurring reminders are rescheduled to the future, not removed", async () => {
    store.add({ userId: "u", channelId: "c", text: "daily", dueAt: Date.now() - 1000, cron: "*/5 * * * *" });
    const delivered: Reminder[] = [];
    const scheduler = new ReminderScheduler(store, async (r) => void delivered.push(r), silent);

    await scheduler.tick();
    expect(delivered).toHaveLength(1);

    const remaining = store.listForUser("u");
    expect(remaining).toHaveLength(1); // still there, rolled forward
    expect(remaining[0]!.cron).toBe("*/5 * * * *");
    expect(remaining[0]!.dueAt).toBeGreaterThan(Date.now());

    await scheduler.tick(); // not due again yet
    expect(delivered).toHaveLength(1);
  });
});
