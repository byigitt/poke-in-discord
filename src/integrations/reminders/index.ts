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
import { type Integration, currentActor, defineTool, toolError, toolText } from "../types.ts";
import { cronNext } from "../../reminders/cron.ts";


const NO_ACTOR = "I can't tell who to remind right now — try again in a moment.";

function whenText(dueAt: number): string {
  return new Date(dueAt).toLocaleString();
}

export const remindersIntegration: Integration = {
  name: "reminders",
  capability: "Set one-off or recurring (daily/weekly/cron) reminders and nudge the user when due",
  tools(ctx) {
    return [
      defineTool({
        name: "set_reminder",
        label: "Set a reminder",
        description:
          "Schedule a reminder; the bot messages the user when it's due. For a one-off, use `in_minutes` ('in 10 minutes' → 10) or `due_at` (RFC3339, computed from the current time you're given). For something recurring, use `cron` (5-field, local time): '0 9 * * *' = every day 9am, '30 8 * * 1-5' = weekdays 8:30, '0 * * * *' = hourly. `cron` wins if given.",
        parameters: z.object({
          text: z.string().min(1).describe("What to remind them about, in their words."),
          in_minutes: z.number().int().min(1).max(525_600).optional().describe("Minutes from now. Best for 'in X'."),
          due_at: z.string().optional().describe("Absolute RFC3339 time, e.g. 2026-06-08T09:00:00+03:00."),
          cron: z.string().optional().describe("5-field cron for a recurring reminder, e.g. '0 9 * * *'."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const actor = currentActor(ctx, toolCtx);
          if (!actor) return toolError(NO_ACTOR);

          const now = Date.now();
          let dueAt: number;
          if (params.cron) {
            const next = cronNext(params.cron, new Date(now));
            if (!next) return toolError("I couldn't read that schedule — use a cron like `0 9 * * *` (daily 9am).");
            dueAt = next.getTime();
          } else if (params.in_minutes !== undefined) {
            dueAt = now + params.in_minutes * 60_000;
          } else if (params.due_at) {
            const parsed = Date.parse(params.due_at);
            if (Number.isNaN(parsed)) {
              return toolError("I couldn't read that time — give `in_minutes`, `due_at` (RFC3339), or a `cron`.");
            }
            dueAt = parsed;
          } else {
            return toolError("when should I remind you? give `in_minutes`, a `due_at`, or a `cron`.");
          }
          if (dueAt <= now + 1000) return toolError("that time's already passed — pick something in the future.");

          const reminder = ctx.reminders.add({
            userId: actor.userId,
            channelId: actor.channelId,
            text: params.text,
            dueAt,
            cron: params.cron,
          });
          ctx.logger.info("reminder set", { id: reminder.id, dueAt, cron: params.cron });
          return toolText(params.cron
            ? `set — I'll remind you on schedule (next ${whenText(dueAt)}): "${params.text}".`
            : `set — I'll remind you ${whenText(dueAt)}: "${params.text}".`);
        },
      }),

      defineTool({
        name: "list_reminders",
        label: "List reminders",
        description: "List the user's pending reminders, with their ids (use an id to cancel one).",
        parameters: z.object({}),
        async execute(_id, _params, _onUpdate, toolCtx) {
          const actor = currentActor(ctx, toolCtx);
          if (!actor) return toolError(NO_ACTOR);

          const reminders = ctx.reminders.listForUser(actor.userId);
          if (reminders.length === 0) return toolText("no reminders set.");
          return toolText(reminders
            .map((r) => {
              const when = r.cron ? `repeats \`${r.cron}\` (next ${whenText(r.dueAt)})` : whenText(r.dueAt);
              return `• [${r.id}] ${when} — "${r.text}"`;
            })
            .join("\n"));
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
          if (!actor) return toolError(NO_ACTOR);

          const removed = ctx.reminders.removeOwned(params.id, actor.userId);
          return removed ? toolText(`cancelled reminder ${params.id}.`) : toolError(`no reminder ${params.id} of yours to cancel.`);
        },
      }),
    ];
  },
};
