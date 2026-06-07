/**
 * The integration catalog — every integration this build knows how to run.
 *
 * Add a new app by importing it here; env-gating (see `select.ts`) and the
 * connect flow are automatic. Each integration lives in its own folder under
 * `src/integrations/<name>/index.ts`, with a colocated `<name>.test.ts`.
 */
import type { Integration } from "./types.ts";
import { filesystemIntegration } from "./filesystem/index.ts";
import { webSearchIntegration } from "./web-search/index.ts";
import { googleCalendarIntegration } from "./google-calendar/index.ts";
import { gmailIntegration } from "./gmail/index.ts";
import { remindersIntegration } from "./reminders/index.ts";
import { shellIntegration } from "./shell/index.ts";

/** Every integration this build knows how to run — configured or not. */
export const ALL_INTEGRATIONS: readonly Integration[] = [
  filesystemIntegration,
  webSearchIntegration,
  remindersIntegration,
  shellIntegration,
  googleCalendarIntegration,
  gmailIntegration,
];