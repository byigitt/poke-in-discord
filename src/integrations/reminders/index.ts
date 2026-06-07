/**
 * Reminders — the Poke move: tell the bot "remind me to X at Y" and it nudges you
 * when the time comes, in its own voice, right where you asked.
 *
 * This file is just the set/list/cancel tools. The actual nudging is the bot's
 * ReminderScheduler firing stored reminders; tools here only read the current
 * speaker + channel (via {@link currentActor}) and write to the store. Relative
 * times (`in_minutes`) are exact; absolute `due_at` relies on the current time
 * the system prompt gives the model.
 */
import { z } from "zod/v4";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { type Integration, currentActor, defineTool } from "../types.ts";

interface ReminderReply {
  content: TextContent[];
  isError?: boolean;
}
function ok(text: string): ReminderReply {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): ReminderReply {
  return { content: [{ type: "text", text }], isError: true };
}

const NO_ACTOR = "I can't tell who to remind right now — try again in a moment.";

function whenText(dueAt: number): string {
  return new Date(dueAt).toLocaleString();
}

export const remindersIntegration: Integration = {
  name: "reminders",
  capability: "Set reminders and nudge the user when they're due",
  tools(ctx) {
    return [
      defineTool({
        name: "set_reminder",
        label: "Set a reminder",
        description:
          "Schedule a reminder. The bot will message the user when it's due. Use `in_minutes` for relative times ('in 10 minutes' → 10, 'in 2 hours' → 120) and `due_at` (RFC3339) for absolute times ('tomorrow 9am'); compute it from the current time you're given.",
        parameters: z.object({
          text: z.string().min(1).describe("What to remind them about, in their words."),
          in_minutes: z.number().int().min(1).max(525_600).optional().describe("Minutes from now. Best for 'in X'."),
          due_at: z.string().optional().describe("Absolute RFC3339 time, e.g. 2026-06-08T09:00:00+03:00."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const actor = currentActor(ctx, toolCtx);
          if (!actor) return fail(NO_ACTOR);

          const now = Date.now();
          let dueAt: number;
          if (params.in_minutes !== undefined) {
            dueAt = now + params.in_minutes * 60_000;
          } else if (params.due_at) {
            const parsed = Date.parse(params.due_at);
            if (Number.isNaN(parsed)) {
              return fail("I couldn't read that time — give `in_minutes`, or `due_at` as RFC3339.");
            }
            dueAt = parsed;
          } else {
            return fail("when should I remind you? give `in_minutes` or a `due_at` time.");
          }
          if (dueAt <= now + 1000) return fail("that time's already passed — pick something in the future.");

          const reminder = ctx.reminders.add({
            userId: actor.userId,
            channelId: actor.channelId,
            text: params.text,
            dueAt,
          });
          ctx.logger.info("reminder set", { id: reminder.id, dueAt });
          return ok(`set — I'll remind you ${whenText(dueAt)}: "${params.text}".`);
        },
      }),

      defineTool({
        name: "list_reminders",
        label: "List reminders",
        description: "List the user's pending reminders, with their ids (use an id to cancel one).",
        parameters: z.object({}),
        async execute(_id, _params, _onUpdate, toolCtx) {
          const actor = currentActor(ctx, toolCtx);
          if (!actor) return fail(NO_ACTOR);

          const reminders = ctx.reminders.listForUser(actor.userId);
          if (reminders.length === 0) return ok("no reminders set.");
          return ok(reminders.map((r) => `• [${r.id}] ${whenText(r.dueAt)} — "${r.text}"`).join("\n"));
        },
      }),

      defineTool({
        name: "cancel_reminder",
        label: "Cancel a reminder",
        description: "Cancel a pending reminder by its id (from list_reminders).",
        parameters: z.object({
          id: z.number().int().describe("Reminder id to cancel."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const actor = currentActor(ctx, toolCtx);
          if (!actor) return fail(NO_ACTOR);

          const removed = ctx.reminders.removeOwned(params.id, actor.userId);
          return removed ? ok(`cancelled reminder ${params.id}.`) : fail(`no reminder ${params.id} of yours to cancel.`);
        },
      }),
    ];
  },
};
