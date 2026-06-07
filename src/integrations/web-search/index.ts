/**
 * Web search — lets the assistant look things up online for current, external
 * information (news, recent events, prices, facts) it doesn't already know.
 *
 * It runs entirely through pi, the same way the rest of the bot does: there is
 * no separate search API key. `runSearchQuery` consults the bot's existing pi
 * auth (`ctx.runtime.authStorage`) and pi's own provider chain with automatic
 * fallback (Anthropic, OpenAI, Perplexity, Brave, Tavily, …), using whichever
 * provider your pi credentials already unlock.
 */
import { z } from "zod/v4";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { type Integration, type ToolReply, defineTool, toolError } from "../types.ts";

export const webSearchIntegration: Integration = {
  name: "web-search",
  capability: "Search the web for current, up-to-date information",
  tools(ctx) {
    return [
      defineTool({
        name: "web_search",
        label: "Web search",
        description:
          "Search the web for current, up-to-date information — news, recent events, prices, facts, anything that needs knowledge beyond what you already have. Returns a synthesized answer with sources.",
        parameters: z.object({
          query: z.string().min(1).describe("What to look up, as a natural-language query."),
          recency: z
            .enum(["day", "week", "month", "year"])
            .optional()
            .describe("Limit results to a recent time window. Omit unless freshness matters."),
        }),
        async execute(_id, params, _onUpdate, toolCtx, signal) {
          try {
            const result = await runSearchQuery(
              { query: params.query, recency: params.recency },
              {
                authStorage: ctx.runtime.authStorage,
                sessionId: toolCtx.sessionManager.getSessionId(),
                signal,
              },
            );
            ctx.logger.info("web search", { query: params.query, recency: params.recency });
            return { content: result.content } satisfies ToolReply;
          } catch (error) {
            ctx.logger.warn("web search failed", { query: params.query, error });
            return toolError("couldn't reach the web just now — mind trying again in a sec?");
          }
        },
      }),
    ];
  },
};
