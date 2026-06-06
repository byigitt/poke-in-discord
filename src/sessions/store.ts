/**
 * Owns the live conversation sessions: one serialized "lane" per Discord
 * conversation, plus idle eviction. Everything for a given conversation key runs
 * on that key's promise chain, which is the per-conversation mutex — messages are
 * answered in order, creation/disposal never races, and only one writer ever
 * touches a session file at a time.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { Logger } from "../logger.ts";
import { ConversationSessionFactory, type SessionFactoryDeps } from "./factory.ts";

/** A unit of work to run against a conversation's session. */
export type ConversationTask = (session: AgentSession) => Promise<void>;

interface Lane {
  /** Live session, or null when never created / evicted (recreated on next use). */
  session: AgentSession | null;
  /** Serialization chain. Always settled-or-pending; never rejects (errors swallowed for chaining). */
  tail: Promise<void>;
  lastActivityMs: number;
}

const MAX_SWEEP_INTERVAL_MS = 5 * 60_000;

export class ConversationSessions {
  private readonly factory: ConversationSessionFactory;
  private readonly lanes = new Map<string, Lane>();
  private readonly logger: Logger;
  private readonly idleMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SessionFactoryDeps) {
    this.factory = new ConversationSessionFactory(deps);
    this.logger = deps.logger.child("sessions");
    this.idleMs = deps.config.sessionIdleMs;
  }

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { session: null, tail: Promise.resolve(), lastActivityMs: Date.now() };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /**
   * Run `task` against the conversation's session, serialized behind any prior
   * work for the same key. Resolves/rejects with the task's own outcome; the
   * lane itself stays usable even if the task throws.
   */
  run(key: string, task: ConversationTask): Promise<void> {
    const lane = this.lane(key);
    const result = lane.tail.then(async () => {
      if (!lane.session) lane.session = await this.factory.create(key);
      lane.lastActivityMs = Date.now();
      try {
        await task(lane.session);
      } finally {
        lane.lastActivityMs = Date.now();
      }
    });
    lane.tail = result.catch(() => {});
    return result;
  }

  /** Forget a conversation entirely: dispose the live session and delete history. */
  async reset(key: string): Promise<void> {
    const lane = this.lanes.get(key);
    if (!lane) {
      await this.factory.deleteFile(key);
      return;
    }
    const done = lane.tail.then(async () => {
      if (lane.session) {
        await lane.session.dispose();
        lane.session = null;
      }
      await this.factory.deleteFile(key);
    });
    lane.tail = done.catch(() => {});
    await done;
  }

  /** Begin the background idle sweep. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.evictIdle(), Math.min(this.idleMs, MAX_SWEEP_INTERVAL_MS));
    this.sweepTimer.unref?.();
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [key, lane] of this.lanes) {
      if (!lane.session || now - lane.lastActivityMs <= this.idleMs) continue;
      // Queue disposal on the lane so it can't race an in-flight or queued reply.
      const done = lane.tail.then(async () => {
        if (lane.session && Date.now() - lane.lastActivityMs > this.idleMs) {
          await lane.session.dispose();
          lane.session = null;
          this.logger.info("evicted idle conversation", { key });
        }
      });
      lane.tail = done.catch(() => {});
    }
  }

  /** Stop the sweep and flush every live session to disk. */
  async dispose(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const flushes: Promise<void>[] = [];
    for (const lane of this.lanes.values()) {
      flushes.push(
        lane.tail
          .then(async () => {
            if (lane.session) {
              await lane.session.dispose();
              lane.session = null;
            }
          })
          .catch(() => {}),
      );
    }
    this.lanes.clear();
    await Promise.all(flushes);
  }
}
