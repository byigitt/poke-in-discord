/**
 * Filesystem access — lets the assistant browse, search, read, and *send* files
 * from the machine it runs on. The headline trick is `send_file`: it can't reach
 * the Discord channel directly (tools run deep inside pi's agent loop), so it
 * stages the file on `ctx.outbox`, keyed by the running session; the bot uploads
 * whatever was staged once the turn finishes.
 *
 * Everything is confined to one root directory (`POKE_FILES_ROOT`, default the
 * user's home). Inputs are resolved and checked to stay under that root, and
 * symlinks are followed and re-checked so a link inside the root can't point the
 * bot at something outside it. Reads and uploads are size-capped
 * (`POKE_FILES_MAX_MB`). This is real access to real files: scope the root and
 * keep the bot private if that matters to you.
 */
import { appendFile, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { type Integration, defineTool } from "../types.ts";

/** Default inline-read cap: enough to read a file, small enough to spare context. */
const READ_TEXT_CAP = 64 * 1024;
/** Hard ceiling on `read_text_file`'s `max_bytes`, even if asked for more. */
const READ_TEXT_MAX = 256 * 1024;
/** Most entries `list_directory` prints before truncating. */
const MAX_LIST_ENTRIES = 200;
/** Stop a search after visiting this many entries, so a deep tree can't run away. */
const SEARCH_VISIT_CAP = 20_000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;

/** What every file tool returns: plain text for the model, flagged on failure. */
interface FileToolReply {
  content: TextContent[];
  isError?: boolean;
}

function ok(text: string): FileToolReply {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): FileToolReply {
  return { content: [{ type: "text", text }], isError: true };
}

/** Expand a leading `~` to the home directory; leave every other path untouched. */
function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Resolve `input` (absolute, relative-to-root, or `~`-prefixed) and confine it
 * to `root`. Returns the absolute path, or null if it would escape. Purely
 * lexical — callers needing symlink safety re-check the realpath of existing
 * targets through this same function.
 */
function confine(root: string, input: string): string | null {
  const expanded = expandHome(input.trim());
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
  if (abs === root) return abs;
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/** Human-readable size. Names the 1024 ladder so call sites read cleanly. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Build a basename matcher: glob semantics when `query` has `*`/`?`, else a
 *  case-insensitive substring match. */
function buildMatcher(query: string): (name: string) => boolean {
  const q = query.trim();
  if (/[*?]/.test(q)) {
    const pattern =
      "^" + q.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
    const re = new RegExp(pattern, "i");
    return (name) => re.test(name);
  }
  const needle = q.toLowerCase();
  return (name) => name.toLowerCase().includes(needle);
}

/** Read up to `cap` bytes of a file as UTF-8 text. Returns null for binary
 *  (any NUL byte), plus a `truncated` flag when the file was longer than `cap`. */
async function readTextCapped(
  path: string,
  size: number,
  cap: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const length = Math.min(size, cap);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  try {
    await handle.read(buffer, 0, length, 0);
  } finally {
    await handle.close();
  }
  if (buffer.includes(0)) return null;
  return { text: buffer.toString("utf8"), truncated: size > cap };
}

export const filesystemIntegration: Integration = {
  name: "filesystem",
  capability: "Browse, search, read, write, and send files on the computer you run on",
  async tools(ctx) {
    // Realpath the root once so symlink checks compare like-for-like; if it's
    // missing, fall back to the lexical path and let per-call stats explain.
    let root = resolve(expandHome(ctx.config.filesRoot));
    try {
      root = await realpath(root);
    } catch {
      ctx.logger.warn("files root does not resolve; using it lexically", { root });
    }
    const uploadCap = ctx.config.fileMaxBytes;
    ctx.logger.info("filesystem access enabled", { root, uploadCap });

    /** Confine an input, following symlinks on existing targets so a link inside
     *  the root can't redirect the bot outside it. */
    const safePath = async (input: string): Promise<string | null> => {
      const abs = confine(root, input);
      if (abs === null) return null;
      try {
        return confine(root, await realpath(abs));
      } catch {
        return abs; // doesn't exist yet; the caller's stat will report it
      }
    };

    const denied = (input: string): FileToolReply =>
      fail(`"${input}" is outside the folder I'm allowed to touch (${root}).`);

    return [
      defineTool({
        name: "list_directory",
        label: "List a folder",
        description:
          "List the files and subfolders inside a folder on the computer. Pass an absolute path, a path relative to the accessible root, or a leading ~ for home; omit `path` for the root itself. Use it to browse before reading or sending a file.",
        parameters: z.object({
          path: z
            .string()
            .optional()
            .describe("Folder to list. Absolute, relative to the root, or ~-prefixed. Omit for the root."),
        }),
        async execute(_id, params) {
          const dir = await safePath(params.path ?? ".");
          if (dir === null) return denied(params.path ?? ".");
          let entries: Dirent[];
          try {
            const info = await stat(dir);
            if (!info.isDirectory()) {
              return fail(`${basename(dir)} is a file, not a folder — use read_text_file or send_file.`);
            }
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            return fail(`I couldn't open ${params.path ?? root} — does it exist?`);
          }
          if (entries.length === 0) return ok(`${dir} is empty.`);

          const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
          const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
          const lines: string[] = [`${dir}`];
          for (const d of dirs.slice(0, MAX_LIST_ENTRIES)) lines.push(`  📁 ${d.name}/`);
          const fileBudget = Math.max(0, MAX_LIST_ENTRIES - Math.min(dirs.length, MAX_LIST_ENTRIES));
          for (const f of files.slice(0, fileBudget)) {
            let size = "";
            try {
              size = ` (${formatBytes((await stat(join(dir, f.name))).size)})`;
            } catch {
              /* unreadable entry; list it without a size */
            }
            lines.push(`  📄 ${f.name}${size}`);
          }
          const shown = Math.min(dirs.length, MAX_LIST_ENTRIES) + Math.min(files.length, fileBudget);
          if (entries.length > shown) lines.push(`  …and ${entries.length - shown} more`);
          return ok(lines.join("\n"));
        },
      }),

      defineTool({
        name: "search_files",
        label: "Search for files",
        description:
          "Find files by name anywhere under a folder. `query` is a case-insensitive substring, or a glob with * and ? to match the filename. Search starts at the accessible root unless you pass `path`. Returns matching paths you can then read or send.",
        parameters: z.object({
          query: z.string().min(1).describe("Filename substring, or a glob like *.pdf or report-2024.*"),
          path: z
            .string()
            .optional()
            .describe("Folder to search under. Absolute, relative to the root, or ~-prefixed. Omit for the root."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(MAX_SEARCH_LIMIT)
            .default(DEFAULT_SEARCH_LIMIT)
            .describe("Maximum number of matches to return."),
        }),
        async execute(_id, params) {
          const base = await safePath(params.path ?? ".");
          if (base === null) return denied(params.path ?? ".");
          try {
            if (!(await stat(base)).isDirectory()) return fail(`${basename(base)} isn't a folder.`);
          } catch {
            return fail(`I couldn't open ${params.path ?? root} to search it.`);
          }

          const isMatch = buildMatcher(params.query);
          const matches: string[] = [];
          const queue: string[] = [base];
          let head = 0;
          let visited = 0;
          let exhausted = false;
          while (head < queue.length && matches.length < params.limit) {
            const dir = queue[head++]!;
            let entries: Dirent[];
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const entry of entries) {
              if (++visited > SEARCH_VISIT_CAP) {
                exhausted = true;
                break;
              }
              if (entry.isSymbolicLink()) continue; // don't follow links (escape/cycle safety)
              const full = join(dir, entry.name);
              if (entry.isDirectory()) {
                queue.push(full);
              } else if (entry.isFile() && isMatch(entry.name)) {
                let size = "";
                try {
                  size = ` (${formatBytes((await stat(full)).size)})`;
                } catch {
                  /* unreadable; report the path without a size */
                }
                matches.push(`${relative(root, full) || full}${size}`);
                if (matches.length >= params.limit) break;
              }
            }
            if (exhausted) break;
          }

          if (matches.length === 0) {
            return ok(
              `No files matching "${params.query}"${exhausted ? " in the part of the tree I scanned" : ""}.`,
            );
          }
          const header = `${matches.length} match${matches.length === 1 ? "" : "es"} for "${params.query}":`;
          const note = exhausted ? "\n(stopped early — the tree was large; narrow with `path` for more.)" : "";
          return ok(`${header}\n${matches.map((m) => `  ${m}`).join("\n")}${note}`);
        },
      }),

      defineTool({
        name: "read_text_file",
        label: "Read a text file",
        description:
          "Read the text contents of a file on the computer so you can answer questions about it. Text only — for binary files (images, PDFs, zips, etc.) use send_file instead.",
        parameters: z.object({
          path: z.string().min(1).describe("File to read. Absolute, relative to the root, or ~-prefixed."),
          max_bytes: z
            .number()
            .int()
            .min(1)
            .max(READ_TEXT_MAX)
            .optional()
            .describe(`How many bytes to read at most. Defaults to ${READ_TEXT_CAP}.`),
        }),
        async execute(_id, params) {
          const file = await safePath(params.path);
          if (file === null) return denied(params.path);
          let info: Stats;
          try {
            info = await stat(file);
          } catch {
            return fail(`I couldn't find ${params.path}.`);
          }
          if (info.isDirectory()) return fail(`${basename(file)} is a folder — use list_directory.`);
          if (!info.isFile()) return fail(`${basename(file)} isn't a regular file.`);

          const cap = Math.min(params.max_bytes ?? READ_TEXT_CAP, READ_TEXT_MAX);
          const result = await readTextCapped(file, info.size, cap);
          if (result === null) {
            return fail(
              `${basename(file)} looks binary (${formatBytes(info.size)}). If you want it sent, use send_file.`,
            );
          }
          const suffix = result.truncated
            ? `\n\n…truncated at ${formatBytes(cap)} of ${formatBytes(info.size)}.`
            : "";
          return ok(`${basename(file)} (${formatBytes(info.size)}):\n\n${result.text}${suffix}`);
        },
      }),

      defineTool({
        name: "send_file",
        label: "Send a file to Discord",
        description:
          "Upload a file from the computer and attach it to your reply in this chat. Use this when the user asks you to send, share, or get them a file. Find it first with search_files or list_directory if you don't have the exact path.",
        parameters: z.object({
          path: z.string().min(1).describe("File to upload. Absolute, relative to the root, or ~-prefixed."),
        }),
        async execute(_id, params, _onUpdate, toolCtx) {
          const sessionKey = toolCtx.sessionManager.getSessionFile();
          if (!sessionKey) return fail("I can't attach a file to this chat right now.");

          const file = await safePath(params.path);
          if (file === null) return denied(params.path);
          let info: Stats;
          try {
            info = await stat(file);
          } catch {
            return fail(`I couldn't find ${params.path} to send.`);
          }
          if (!info.isFile()) return fail(`${basename(file)} isn't a file I can send.`);
          if (info.size === 0) return fail(`${basename(file)} is empty, so there's nothing to send.`);
          if (info.size > uploadCap) {
            return fail(
              `${basename(file)} is ${formatBytes(info.size)} — too big to send (limit ${formatBytes(uploadCap)}).`,
            );
          }

          ctx.outbox.stage(sessionKey, { path: file, name: basename(file) });
          ctx.logger.info("file staged for upload", { name: basename(file), size: info.size });
          return ok(`Attaching ${basename(file)} (${formatBytes(info.size)}) to your reply.`);
        },
      }),

      defineTool({
        name: "write_file",
        label: "Write a file",
        description:
          "Create or overwrite a text file with the given content (parent folders are created as needed). Confined to the accessible root.",
        parameters: z.object({
          path: z.string().min(1).describe("File to write. Absolute, relative to the root, or ~-prefixed."),
          content: z.string().describe("Full text content to write; overwrites any existing file."),
        }),
        async execute(_id, params) {
          const file = await safePath(params.path);
          if (file === null) return denied(params.path);
          const bytes = Buffer.byteLength(params.content, "utf8");
          if (bytes > uploadCap) {
            return fail(`that's ${formatBytes(bytes)} — over the ${formatBytes(uploadCap)} write limit.`);
          }
          try {
            if ((await stat(file).catch(() => null))?.isDirectory()) return fail(`${basename(file)} is a folder.`);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, params.content, "utf8");
          } catch (error) {
            return fail(`couldn't write ${params.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
          ctx.logger.info("wrote file", { name: basename(file), bytes });
          return ok(`wrote ${formatBytes(bytes)} to ${basename(file)}.`);
        },
      }),

      defineTool({
        name: "append_file",
        label: "Append to a file",
        description: "Append text to the end of a file, creating it (and parent folders) if needed. Confined to the accessible root.",
        parameters: z.object({
          path: z.string().min(1).describe("File to append to. Absolute, relative to the root, or ~-prefixed."),
          content: z.string().describe("Text to append."),
        }),
        async execute(_id, params) {
          const file = await safePath(params.path);
          if (file === null) return denied(params.path);
          const bytes = Buffer.byteLength(params.content, "utf8");
          if (bytes > uploadCap) {
            return fail(`that's ${formatBytes(bytes)} — over the ${formatBytes(uploadCap)} write limit.`);
          }
          try {
            if ((await stat(file).catch(() => null))?.isDirectory()) return fail(`${basename(file)} is a folder.`);
            await mkdir(dirname(file), { recursive: true });
            await appendFile(file, params.content, "utf8");
          } catch (error) {
            return fail(`couldn't append to ${params.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
          ctx.logger.info("appended to file", { name: basename(file), bytes });
          return ok(`appended ${formatBytes(bytes)} to ${basename(file)}.`);
        },
      }),
    ];
  },
};
