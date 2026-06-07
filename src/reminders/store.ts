/**
 * Persistent reminder storage, backed by SQLite (built into Bun). Reminders must
 * survive restarts — the whole point is that the bot nudges you later, even if it
 * was redeployed in between — so they live on disk, keyed by an auto-increment id,
 * tagged with the user who set it and the channel to deliver it back to.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Reminder {
  readonly id: number;
  /** Discord user who set it (for `list`/`cancel` ownership). */
  readonly userId: string;
  /** Discord channel to deliver the nudge back to. */
  readonly channelId: string;
  readonly text: string;
  /** When to fire, epoch ms. */
  readonly dueAt: number;
}

interface ReminderRow {
  id: number;
  user: string;
  channel: string;
  text: string;
  due_at: number;
}

function toReminder(row: ReminderRow): Reminder {
  return { id: row.id, userId: row.user, channelId: row.channel, text: row.text, dueAt: row.due_at };
}

export class ReminderStore {
  private readonly db: Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS reminders (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         user TEXT NOT NULL,
         channel TEXT NOT NULL,
         text TEXT NOT NULL,
         due_at INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* best effort */
    }
  }

  /** Persist a reminder and return it with its assigned id. */
  add(input: { userId: string; channelId: string; text: string; dueAt: number }): Reminder {
    const result = this.db.run("INSERT INTO reminders (user, channel, text, due_at, created_at) VALUES (?, ?, ?, ?, ?)", [
      input.userId,
      input.channelId,
      input.text,
      input.dueAt,
      Date.now(),
    ]);
    return { id: Number(result.lastInsertRowid), ...input };
  }

  /** Reminders that are due at or before `now`, oldest first. */
  due(now: number): Reminder[] {
    return this.db
      .query<ReminderRow, [number]>("SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at")
      .all(now)
      .map(toReminder);
  }

  /** A user's pending reminders, soonest first. */
  listForUser(userId: string): Reminder[] {
    return this.db
      .query<ReminderRow, [string]>("SELECT * FROM reminders WHERE user = ? ORDER BY due_at")
      .all(userId)
      .map(toReminder);
  }

  /** Delete by id (used by the scheduler after firing). Returns whether a row went. */
  remove(id: number): boolean {
    return this.db.run("DELETE FROM reminders WHERE id = ?", [id]).changes > 0;
  }

  /** Delete by id only if it belongs to `userId` (used by `cancel`). */
  removeOwned(id: number, userId: string): boolean {
    return this.db.run("DELETE FROM reminders WHERE id = ? AND user = ?", [id, userId]).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
