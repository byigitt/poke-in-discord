/**
 * Gmail — search, read, and send mail from the connected user's inbox.
 *
 * Reuses the shared Google OAuth client (`GOOGLE_CLIENT_ID/SECRET`) with Gmail
 * scopes; users link with `connect gmail`. Like the calendar integration, the
 * auth + HTTP plumbing is `currentToken` + `googleApi`, so this file is just the
 * Gmail specifics: search syntax, pulling a readable body out of the MIME tree,
 * and building an RFC 2822 message to send.
 */
import { z } from "zod/v4";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { type Integration, currentToken, defineTool } from "../types.ts";
import { googleApi } from "../google/api.ts";
import { googleConnection } from "../google/oauth.ts";

const PROVIDER = "gmail";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const RECONNECT = "your Gmail connection expired — reconnect by saying `connect gmail`.";
const NOT_CONNECTED = "connect your Gmail first — say `connect gmail`.";

interface GmailReply {
  content: TextContent[];
  isError?: boolean;
}
function ok(text: string): GmailReply {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): GmailReply {
  return { content: [{ type: "text", text }], isError: true };
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id?: string;
  snippet?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
}
interface GmailList {
  messages?: { id: string }[];
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Walk the MIME tree for the first text/plain part and decode it; "" if none. */
function plainBody(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const sub of part.parts ?? []) {
    const found = plainBody(sub);
    if (found) return found;
  }
  return "";
}

/** RFC 2047-encode a header value only when it has non-ASCII (e.g. Turkish subjects). */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Build a base64url RFC 2822 message for the Gmail send endpoint. */
export function buildRawMessage(fields: { to: string; subject: string; body: string; cc?: string; bcc?: string }): string {
  const lines = [`To: ${fields.to}`];
  if (fields.cc) lines.push(`Cc: ${fields.cc}`);
  if (fields.bcc) lines.push(`Bcc: ${fields.bcc}`);
  lines.push(
    `Subject: ${encodeHeader(fields.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    fields.body,
  );
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export const gmailIntegration: Integration = {
  name: "gmail",
  capability: "Search, read, and send email from the user's Gmail (once they connect it)",
  connection: googleConnection(PROVIDER, "Gmail", [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]),
  tools(ctx) {
    return [
      defineTool({
        name: "search_emails",
        label: "Search emails",
        description:
          "Search the user's Gmail. `query` uses Gmail search syntax (e.g. 'from:amazon newer_than:7d', 'is:unread', 'subject:invoice'). Returns subjects, senders, and snippets.",
        parameters: z.object({
          query: z.string().optional().describe("Gmail search query. Omit for the most recent mail."),
          max_results: z.number().int().min(1).max(20).default(5).describe("How many messages to return."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const token = await currentToken(ctx, toolCtx, PROVIDER);
          if (!token) return fail(NOT_CONNECTED);

          const query = new URLSearchParams({ maxResults: String(params.max_results) });
          if (params.query) query.set("q", params.query);
          const list = await googleApi<GmailList>(token, `${API}/messages?${query}`);
          if (!list.ok) return fail(list.status === 401 ? RECONNECT : `couldn't search your mail (${list.status}).`);

          const ids = list.data.messages ?? [];
          if (ids.length === 0) return ok("no matching emails.");

          const messages = await Promise.all(
            ids.map((m) =>
              googleApi<GmailMessage>(
                token,
                `${API}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
              ),
            ),
          );
          const lines = messages.flatMap((result) => {
            if (!result.ok) return [];
            const message = result.data;
            return [`• ${header(message, "Subject") || "(no subject)"} — ${header(message, "From")} (id: ${message.id})\n  ${message.snippet ?? ""}`];
          });
          ctx.logger.info("searched emails", { count: lines.length });
          return ok(lines.join("\n\n"));
        },
      }),

      defineTool({
        name: "read_email",
        label: "Read an email",
        description: "Read one email's full text by its id (get the id from search_emails first).",
        parameters: z.object({
          id: z.string().min(1).describe("Gmail message id from search_emails."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const token = await currentToken(ctx, toolCtx, PROVIDER);
          if (!token) return fail(NOT_CONNECTED);

          const result = await googleApi<GmailMessage>(token, `${API}/messages/${params.id}?format=full`);
          if (!result.ok) return fail(result.status === 401 ? RECONNECT : `couldn't open that email (${result.status}).`);

          const message = result.data;
          const body = plainBody(message.payload) || message.snippet || "(no readable text)";
          return ok(
            [
              `From: ${header(message, "From")}`,
              `Subject: ${header(message, "Subject")}`,
              `Date: ${header(message, "Date")}`,
              "",
              body.slice(0, 4000),
            ].join("\n"),
          );
        },
      }),

      defineTool({
        name: "send_email",
        label: "Send an email",
        description:
          "Send an email from the user's Gmail. Confirm the recipient and content with the user before sending unless they were explicit.",
        parameters: z.object({
          to: z.string().min(1).describe("Recipient address(es), comma-separated."),
          subject: z.string().describe("Subject line."),
          body: z.string().describe("Plain-text body."),
          cc: z.string().optional(),
          bcc: z.string().optional(),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const token = await currentToken(ctx, toolCtx, PROVIDER);
          if (!token) return fail(NOT_CONNECTED);

          const raw = buildRawMessage(params);
          const result = await googleApi<{ id?: string }>(token, `${API}/messages/send`, {
            method: "POST",
            body: JSON.stringify({ raw }),
          });
          if (!result.ok) return fail(result.status === 401 ? RECONNECT : `couldn't send that email (${result.status}).`);

          ctx.logger.info("sent email");
          return ok(`sent to ${params.to}.`);
        },
      }),
    ];
  },
};
