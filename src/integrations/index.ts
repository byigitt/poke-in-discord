/**
 * The enabled integration set.
 *
 * The base build ships pure conversation — no tools, no external access. To grow
 * the bot, build an Integration (see `examples/clock.ts` for a complete,
 * type-checked template) and add it to the array below. The persona and the
 * agent's toolset update automatically; nothing else needs to change.
 *
 * Example:
 *   import { clockIntegration } from "./examples/clock.ts";
 *   import { googleCalendar } from "./google/calendar.ts";
 *   export function enabledIntegrations(): Integration[] {
 *     return [clockIntegration, googleCalendar];
 *   }
 */
import type { Integration } from "./types.ts";

export function enabledIntegrations(): Integration[] {
  return [];
}
