/**
 * The extensibility contract.
 *
 * An Integration is a self-contained bundle of capability: a name, an optional
 * one-line description that flows into the persona, and a set of model-callable
 * tools. Adding Google Calendar, Gmail, web search, smart-home control, etc.
 * later means writing one file that exports an Integration and registering it —
 * nothing in the core changes.
 *
 * Tool parameters are authored with Zod v4 (`import { z } from "zod/v4"`), which
 * pi accepts natively. Use `defineTool` so `execute`'s `params` are fully typed
 * from the schema.
 */
import type { CustomTool, CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import type { TSchema, TextContent } from "@oh-my-pi/pi-ai";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { PiRuntime } from "../pi/runtime.ts";
import type { ReplyOutbox } from "../outbox.ts";
import type { ActorRegistry, TurnActor } from "../actor.ts";
import type { ConnectionManager } from "../connections/manager.ts";
import type { ConnectionSpec } from "../connections/oauth.ts";
import type { ReminderStore } from "../reminders/store.ts";

/** A model-callable tool. Re-exported so integrations import one name from here. */
export type { CustomTool } from "@oh-my-pi/pi-coding-agent";

/** What a tool returns: plain text the model reads, optionally flagged as a failure. */
export interface ToolReply {
  content: TextContent[];
  isError?: boolean;
}

/** A successful, plain-text tool result. */
export function toolText(text: string): ToolReply {
  return { content: [{ type: "text", text }] };
}

/** A failed tool result — same text channel, flagged so the model knows it didn't work. */
export function toolError(text: string): ToolReply {
  return { content: [{ type: "text", text }], isError: true };
}

/** Everything an integration may need while constructing its tools. */
export interface IntegrationContext {
  /** Shared pi auth + model access (for tools that need to make their own LLM/API calls). */
  readonly runtime: PiRuntime;
  /** Validated runtime configuration. */
  readonly config: Config;
  /** Scoped logger for this integration. */
  readonly logger: Logger;
  /**
   * Stage files to be uploaded alongside the current reply. A tool reaches the
   * Discord channel only through here: it stages a file keyed by the running
   * session (`ctx.sessionManager.getSessionFile()`), and the bot uploads it once
   * the turn finishes.
   */
  readonly outbox: ReplyOutbox;
  /** Linked-account tokens. OAuth tools resolve the current user's token via {@link currentToken}. */
  readonly connections: ConnectionManager;
  /** Who is talking this turn, so a tool can find *that* user's connected accounts. */
  readonly actor: ActorRegistry;
  /** Persistent reminders. The reminders integration adds/lists/cancels here; the bot's scheduler fires them. */
  readonly reminders: ReminderStore;
}

export interface Integration {
  /** Unique id, e.g. "google-calendar". Used for dedup and logging. */
  readonly name: string;
  /**
   * One human line describing what this unlocks, written for the user, e.g.
   * "Check and create events on your Google Calendar". Injected verbatim into
   * the persona's capability list so the assistant truthfully advertises it.
   */
  readonly capability?: string;
  /** Plain env vars that must ALL be set for this integration to load (non-OAuth gating). */
  readonly requires?: readonly string[];
  /**
   * An account the user links via `connect`. Declaring it both gates the
   * integration on the OAuth client env being present and registers the provider
   * so `connect <provider>` works. Tools then call {@link currentToken}.
   */
  readonly connection?: ConnectionSpec;
  /** Build this integration's tools. May be async (e.g. to set up a client). */
  tools(ctx: IntegrationContext): CustomTool[] | Promise<CustomTool[]>;
}

/**
 * Identity helper that captures the Zod parameter schema as a type parameter so
 * `execute(_, params, …)` sees the inferred shape instead of `unknown`. Author
 * tools with this.
 */
export function defineTool<S extends TSchema, D = unknown>(tool: CustomTool<S, D>): CustomTool<S, D> {
  return tool;
}

/**
 * Resolve a usable access token for the integration's connection, for whichever
 * user is talking this turn. Returns null when there's no actor or the user
 * hasn't linked the account — the tool should then tell them to `connect`.
 *
 * This is the one line every OAuth tool needs; it hides the actor + session +
 * refresh plumbing so an integration stays about its API, not our wiring.
 */
export function currentToken(
  ctx: IntegrationContext,
  toolCtx: CustomToolContext,
  provider: string,
): Promise<string | null> {
  const sessionKey = toolCtx.sessionManager.getSessionFile();
  if (!sessionKey) return Promise.resolve(null);
  const actor = ctx.actor.current(sessionKey);
  if (!actor) return Promise.resolve(null);
  return ctx.connections.accessToken(actor.userId, provider);
}

/**
 * The user + channel behind the current turn, or null between turns. Tools that
 * act per-user or per-channel (reminders, connections) resolve identity here
 * instead of reaching into the session plumbing themselves.
 */
export function currentActor(ctx: IntegrationContext, toolCtx: CustomToolContext): TurnActor | null {
  const sessionKey = toolCtx.sessionManager.getSessionFile();
  if (!sessionKey) return null;
  return ctx.actor.current(sessionKey) ?? null;
}
