/**
 * Shared test scaffolding. Not a test file (no `.test.ts`), so the runner skips
 * it; tests import from here instead of re-deriving the same stubs. Centralizing
 * the `as unknown as` casts keeps that unavoidable test-only noise in ONE place.
 */
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { ActorRegistry } from "./actor.ts";
import type { Config } from "./config.ts";
import type { ConnectionManager } from "./connections/manager.ts";
import type { Logger } from "./logger.ts";
import type { IntegrationContext } from "./integrations/types.ts";
import { ReplyOutbox } from "./outbox.ts";
import type { PiRuntime } from "./pi/runtime.ts";
import type { ReminderStore } from "./reminders/store.ts";

/** A no-op logger for tests that don't assert on logging. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};

/** The visible text of a tool result (ignores any non-text content). */
export function textOf(result: { content: { type: string }[] }): string {
  return result.content.map((c) => (c.type === "text" ? (c as TextContent).text : "")).join("");
}

/**
 * An IntegrationContext for tests. Override only what the test exercises; unused
 * deps are stubbed (and will throw loudly if a tool unexpectedly reaches for one).
 */
export function fakeIntegrationContext(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    runtime: undefined as unknown as PiRuntime,
    config: {} as unknown as Config,
    logger: silentLogger,
    outbox: new ReplyOutbox(),
    connections: undefined as unknown as ConnectionManager,
    actor: new ActorRegistry(),
    reminders: undefined as unknown as ReminderStore,
    ...overrides,
  };
}

/** A per-call CustomToolContext for tests (only the session accessors tools use). */
export function fakeToolContext(opts: { sessionFile?: string; sessionId?: string } = {}): CustomToolContext {
  return {
    sessionManager: {
      getSessionFile: () => opts.sessionFile,
      getSessionId: () => opts.sessionId ?? "test-session",
    },
  } as unknown as CustomToolContext;
}
