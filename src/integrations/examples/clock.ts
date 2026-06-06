/**
 * Example integration — a working template, intentionally NOT enabled by default.
 *
 * Copy this shape to build real integrations (Google Calendar, Gmail, web
 * search, …): export an `Integration`, give it a `capability` line, and return
 * tools built with `defineTool` + Zod. To turn it on, add it to the array in
 * `../index.ts`.
 */
import { z } from "zod/v4";
import { type Integration, defineTool } from "../types.ts";

export const clockIntegration: Integration = {
  name: "clock",
  capability: "Tell the current date and time in any timezone",
  tools(ctx) {
    return [
      defineTool({
        name: "current_time",
        label: "Current time",
        description:
          "Get the current date and time. Pass an IANA timezone (e.g. 'Europe/Istanbul') to localize it.",
        parameters: z.object({
          timezone: z
            .string()
            .optional()
            .describe("IANA timezone like 'America/New_York'. Omit for UTC."),
        }),
        async execute(_id, params) {
          const timezone = params.timezone ?? "UTC";
          try {
            const formatted = new Intl.DateTimeFormat("en-US", {
              timeZone: timezone,
              dateStyle: "full",
              timeStyle: "long",
            }).format(new Date());
            return { content: [{ type: "text", text: formatted }] };
          } catch {
            ctx.logger.warn("invalid timezone requested", { timezone });
            return {
              content: [{ type: "text", text: `"${timezone}" isn't a timezone I recognize.` }],
              isError: true,
            };
          }
        },
      }),
    ];
  },
};
