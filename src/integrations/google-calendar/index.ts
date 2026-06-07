/**
 * Google Calendar — read and add events on the connected user's primary calendar.
 *
 * Gated on the shared Google OAuth client (`GOOGLE_CLIENT_ID/SECRET`); each user
 * links their own account with `connect google-calendar`. Tools resolve *that*
 * user's token via `currentToken` and call the Calendar API through `googleApi`,
 * so there's no auth or HTTP boilerplate here — just the three things people ask
 * for over text: what's on my calendar, add this, schedule that.
 */
import { z } from "zod/v4";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { type Integration, currentToken, defineTool } from "../types.ts";
import { googleApi } from "../google/api.ts";
import { googleConnection } from "../google/oauth.ts";

const PROVIDER = "google-calendar";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const RECONNECT = "your Google Calendar connection expired — reconnect by saying `connect google-calendar`.";
const NOT_CONNECTED = "connect your Google Calendar first — say `connect google-calendar`.";

interface CalendarReply {
  content: TextContent[];
  isError?: boolean;
}
function ok(text: string): CalendarReply {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): CalendarReply {
  return { content: [{ type: "text", text }], isError: true };
}

interface CalendarEvent {
  id?: string;
  summary?: string;
  htmlLink?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

function whenOf(event: CalendarEvent): string {
  return event.start?.dateTime ?? event.start?.date ?? "(no time)";
}

function formatEvent(event: CalendarEvent): string {
  const where = event.location ? ` @ ${event.location}` : "";
  return `• ${event.summary ?? "(untitled)"} — ${whenOf(event)}${where}`;
}

export const googleCalendarIntegration: Integration = {
  name: "google-calendar",
  capability: "Check and add events on the user's Google Calendar (once they connect it)",
  connection: googleConnection(PROVIDER, "Google Calendar", ["https://www.googleapis.com/auth/calendar.events"]),
  tools(ctx) {
    return [
      defineTool({
        name: "list_calendar_events",
        label: "List calendar events",
        description:
          "List upcoming events from the user's Google Calendar. Use for 'what's on my calendar', 'am I free', etc. Defaults to events from now onward.",
        parameters: z.object({
          query: z.string().optional().describe("Only events matching this text."),
          time_min: z.string().optional().describe("RFC3339 lower bound; defaults to now."),
          time_max: z.string().optional().describe("RFC3339 upper bound."),
          max_results: z.number().int().min(1).max(50).default(10).describe("How many events to return."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const token = await currentToken(ctx, toolCtx, PROVIDER);
          if (!token) return fail(NOT_CONNECTED);

          const query = new URLSearchParams({
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: String(params.max_results),
            timeMin: params.time_min ?? new Date().toISOString(),
          });
          if (params.time_max) query.set("timeMax", params.time_max);
          if (params.query) query.set("q", params.query);

          const result = await googleApi<{ items?: CalendarEvent[] }>(token, `${EVENTS_URL}?${query}`);
          if (!result.ok) return fail(result.status === 401 ? RECONNECT : `couldn't read your calendar (${result.status}).`);

          const events = result.data.items ?? [];
          if (events.length === 0) return ok("nothing on the calendar for that window.");
          ctx.logger.info("listed calendar events", { count: events.length });
          return ok(events.map(formatEvent).join("\n"));
        },
      }),

      defineTool({
        name: "quick_add_calendar_event",
        label: "Quick-add a calendar event",
        description:
          "Add an event from a natural-language phrase, e.g. 'lunch with Sam tomorrow at noon' or 'dentist June 12 3pm'. Google parses the time. Best for quick texty scheduling.",
        parameters: z.object({
          text: z.string().min(1).describe("Natural-language event, including when."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const token = await currentToken(ctx, toolCtx, PROVIDER);
          if (!token) return fail(NOT_CONNECTED);

          const url = `${EVENTS_URL}/quickAdd?text=${encodeURIComponent(params.text)}`;
          const result = await googleApi<CalendarEvent>(token, url, { method: "POST" });
          if (!result.ok) return fail(result.status === 401 ? RECONNECT : `couldn't add that event (${result.status}).`);

          ctx.logger.info("quick-added calendar event");
          return ok(`added: ${formatEvent(result.data)}`);
        },
      }),

      defineTool({
        name: "create_calendar_event",
        label: "Create a calendar event",
        description:
          "Create an event with exact start/end times. Use when you already know precise RFC3339 timestamps; otherwise prefer quick_add_calendar_event.",
        parameters: z.object({
          summary: z.string().min(1).describe("Event title."),
          start: z.string().describe("RFC3339 start, e.g. 2026-06-08T12:00:00+03:00."),
          end: z.string().describe("RFC3339 end."),
          description: z.string().optional(),
          location: z.string().optional(),
          time_zone: z.string().optional().describe("IANA tz (e.g. Europe/Istanbul) if start/end lack an offset."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const token = await currentToken(ctx, toolCtx, PROVIDER);
          if (!token) return fail(NOT_CONNECTED);

          const body = {
            summary: params.summary,
            description: params.description,
            location: params.location,
            start: { dateTime: params.start, timeZone: params.time_zone },
            end: { dateTime: params.end, timeZone: params.time_zone },
          };
          const result = await googleApi<CalendarEvent>(token, EVENTS_URL, {
            method: "POST",
            body: JSON.stringify(body),
          });
          if (!result.ok) return fail(result.status === 401 ? RECONNECT : `couldn't create that event (${result.status}).`);

          ctx.logger.info("created calendar event");
          return ok(`created: ${formatEvent(result.data)}`);
        },
      }),
    ];
  },
};
