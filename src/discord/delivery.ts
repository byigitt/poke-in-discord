/**
 * Turns a finished agent turn into Discord messages, Poke-style: short replies
 * arrive as a few rapid-fire bubbles; long or code-bearing replies are packed
 * into as few messages as possible. Always respects Discord's 2000-char limit
 * and never splits a fenced code block.
 */
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import type { Logger } from "../logger.ts";
import type { PendingFile } from "../outbox.ts";

const DISCORD_LIMIT = 2000;

/** A file Discord can upload: a path (string `BufferResolvable`) plus its display name. */
export interface OutboundAttachment {
  attachment: string;
  name: string;
}

/**
 * Minimal surface we need from a Discord channel — keeps this module decoupled.
 * `send` mirrors discord.js: a plain string for text, or `{ files }` to upload.
 */
export interface OutboundChannel {
  send(payload: string | { files: OutboundAttachment[] }): Promise<unknown>;
  sendTyping(): Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Concatenate the visible text of an assistant message (drops thinking/tool blocks). */
export function extractAssistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

/**
 * Fence-aware segmentation: code blocks stay whole, prose is split on blank
 * lines. Used as the unit of "one texting bubble".
 */
function segments(text: string): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  for (const line of text.split("\n")) {
    const isFence = line.trimStart().startsWith("```");
    if (isFence) {
      if (!inFence) {
        if (buffer.length > 0) out.push(buffer.join("\n"));
        buffer = [line];
        inFence = true;
      } else {
        buffer.push(line);
        out.push(buffer.join("\n"));
        buffer = [];
        inFence = false;
      }
      continue;
    }
    if (!inFence && line.trim() === "") {
      if (buffer.length > 0) out.push(buffer.join("\n"));
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  if (buffer.length > 0) out.push(buffer.join("\n"));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Break one block into pieces that each fit Discord's limit, preferring line boundaries. */
function hardSplit(block: string, limit: number): string[] {
  if (block.length <= limit) return [block];
  const out: string[] = [];
  let current = "";
  for (const line of block.split("\n")) {
    if (line.length > limit) {
      if (current) {
        out.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      if (current) out.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Greedily merge atoms into the fewest messages that each fit the limit. */
function pack(atoms: string[], limit: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const atom of atoms) {
    const candidate = current ? `${current}\n\n${atom}` : atom;
    if (candidate.length > limit) {
      if (current) out.push(current);
      current = atom;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Split an agent reply into Discord messages. `maxMessages` is the texting-style
 * bubble target: a reply with up to that many segments is sent as separate
 * bubbles; anything larger is packed into the fewest limit-sized messages.
 */
export function toDiscordMessages(text: string, maxMessages: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const atoms = segments(trimmed).flatMap((s) => hardSplit(s, DISCORD_LIMIT));
  if (atoms.length === 0) return [];
  return atoms.length <= maxMessages ? atoms : pack(atoms, DISCORD_LIMIT);
}

/** Send messages as sequential bubbles with a brief, length-scaled typing pause. */
export async function sendBubbles(
  channel: OutboundChannel,
  messages: string[],
  logger: Logger,
): Promise<void> {
  for (let i = 0; i < messages.length; i++) {
    const body = messages[i]!;
    if (i > 0) {
      await channel.sendTyping().catch(() => {});
      await sleep(Math.min(1200, 350 + body.length * 6));
    }
    try {
      await channel.send(body);
    } catch (error) {
      logger.error("failed to send message", { error, index: i });
      throw error;
    }
  }
}

/**
 * Upload staged files after the text reply. One message per file: an oversized
 * or vanished file fails on its own without sinking the rest, and each keeps its
 * intended filename. A failure is reported in-character rather than thrown — the
 * model already told the user it was sending, so silence would be worse.
 */
export async function sendFiles(
  channel: OutboundChannel,
  files: PendingFile[],
  logger: Logger,
): Promise<void> {
  for (const file of files) {
    await channel.sendTyping().catch(() => {});
    try {
      await channel.send({ files: [{ attachment: file.path, name: file.name }] });
    } catch (error) {
      logger.error("failed to send file", { error, name: file.name });
      await channel.send(`couldn't get ${file.name} to upload — try asking again?`).catch(() => {});
    }
  }
}
