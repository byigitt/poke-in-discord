/**
 * The integration catalog and the env-gated selection that decides which ones
 * actually load.
 *
 * Each integration declares what it needs — plain `requires` env vars and/or an
 * OAuth `connection` (whose client env gates it). `selectConfigured` keeps only
 * the ones whose requirements are met, so an unconfigured app simply isn't there:
 * no half-wired tools, no capabilities the bot can't honor. Add a new app by
 * importing it into `ALL_INTEGRATIONS`; gating and the connect flow are automatic.
 */
import type { Integration } from "./types.ts";
import { filesystemIntegration } from "./filesystem/index.ts";
import { webSearchIntegration } from "./web-search/index.ts";
import { googleCalendarIntegration } from "./google-calendar/index.ts";
import { gmailIntegration } from "./gmail/index.ts";

/** Every integration this build knows how to run — configured or not. */
export const ALL_INTEGRATIONS: readonly Integration[] = [
  filesystemIntegration,
  webSearchIntegration,
  googleCalendarIntegration,
  gmailIntegration,
];

/** One integration that couldn't load, and exactly which env vars it's missing. */
export interface SkippedIntegration {
  readonly name: string;
  readonly missing: string[];
}

export interface IntegrationSelection {
  readonly enabled: Integration[];
  readonly skipped: SkippedIntegration[];
}

/** Env vars an integration needs but doesn't have. Empty ⇒ ready to load. */
function missingRequirements(integration: Integration, env: Record<string, string | undefined>): string[] {
  const needed = [...(integration.requires ?? [])];
  if (integration.connection) {
    needed.push(integration.connection.clientIdEnv, integration.connection.clientSecretEnv);
  }
  return needed.filter((name) => !env[name]?.trim());
}

/** Split the catalog into what can load now vs what's missing config (with reasons). */
export function selectConfigured(
  integrations: readonly Integration[],
  env: Record<string, string | undefined>,
): IntegrationSelection {
  const enabled: Integration[] = [];
  const skipped: SkippedIntegration[] = [];
  for (const integration of integrations) {
    const missing = missingRequirements(integration, env);
    if (missing.length === 0) enabled.push(integration);
    else skipped.push({ name: integration.name, missing });
  }
  return { enabled, skipped };
}
