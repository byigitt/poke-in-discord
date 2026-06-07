/**
 * The enabled integration set.
 *
 * This build enables filesystem access (browse/search/read/send files from the
 * host). To grow the bot further, build an Integration (see `examples/clock.ts`
 * for a complete, type-checked template) and add it to the array below. The
 * persona and the agent's toolset update automatically; nothing else changes.
 *
 * Example:
 *   import { clockIntegration } from "./examples/clock.ts";
 *   import { googleCalendar } from "./google/calendar.ts";
 *   export function enabledIntegrations(): Integration[] {
 *     return [clockIntegration, googleCalendar];
 *   }
 */
import type { Integration } from "./types.ts";
import { filesystemIntegration } from "./filesystem/index.ts";

export function enabledIntegrations(): Integration[] {
  return [filesystemIntegration];
}
