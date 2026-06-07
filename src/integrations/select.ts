/**
 * Env-gated selection: decide which integrations actually load.
 *
 * Each integration declares what it needs — plain `requires` env vars and/or an
 * OAuth `connection` (whose client env gates it). `selectConfigured` keeps only
 * the ones whose requirements are met, so an unconfigured app simply isn't there:
 * no half-wired tools, no capabilities the bot can't honor.
 */
import type { Integration } from "./types.ts";

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
