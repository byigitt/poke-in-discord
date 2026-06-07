/**
 * Fires due reminders. A plain poll loop: every tick it asks the store for what's
 * due and hands each to a `deliver` callback (the bot turns that into a message).
 *
 * Polling is deliberately dumb and robust: ticks never overlap (a slow delivery
 * can't cause a double-fire), and the first tick runs immediately on start so
 * reminders that came due while the bot was offline go out right away. Each
 * reminder is removed after its delivery attempt — fire-once, never stuck.
 */
import type { Logger } from "../logger.ts";
import type { Reminder, ReminderStore } from "./store.ts";

const DEFAULT_POLL_MS = 15_000;

export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly store: ReminderStore,
    /** Deliver one reminder to its channel. Should resolve once it has tried its best. */
    private readonly deliver: (reminder: Reminder) => Promise<void>,
    private readonly logger: Logger,
    private readonly pollMs: number = DEFAULT_POLL_MS,
  ) {}

  /** Start polling. Fires anything already overdue right away (offline catch-up). */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll. Public for tests; skips itself if a previous tick is still running. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const reminder of this.store.due(Date.now())) {
        try {
          await this.deliver(reminder);
        } catch (error) {
          this.logger.error("reminder delivery failed", { id: reminder.id, error });
        } finally {
          this.store.remove(reminder.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
