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
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { PiRuntime } from "../pi/runtime.ts";

/** A model-callable tool. Re-exported so integrations import one name from here. */
export type { CustomTool } from "@oh-my-pi/pi-coding-agent";

/** Everything an integration may need while constructing its tools. */
export interface IntegrationContext {
  /** Shared pi auth + model access (for tools that need to make their own LLM/API calls). */
  readonly runtime: PiRuntime;
  /** Validated runtime configuration. */
  readonly config: Config;
  /** Scoped logger for this integration. */
  readonly logger: Logger;
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
