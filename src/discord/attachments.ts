/**
 * Turning a Discord message's image attachments into the base64 `ImageContent`
 * blocks pi forwards to a vision model. Kept out of the gateway so the rules —
 * which formats are forwardable, the size/count caps, the graceful "skip a bad
 * download" behavior — are unit-testable without a live Discord connection.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Logger } from "../logger.ts";

/**
 * Media types we forward, restricted to the set every current vision provider
 * accepts (notably Anthropic, the default). Anything else is dropped rather than
 * risking a provider 400 on an exotic format.
 */
const SUPPORTED_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/gif": true,
  "image/webp": true,
};

/** Fallback media type by file extension, for attachments Discord leaves untyped. */
const EXTENSION_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** The subset of a discord.js `Attachment` we depend on — keeps this module decoupled. */
export interface AttachmentLike {
  readonly url: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string | null;
}

/** A forwardable image: where to fetch it and the media type to tag its bytes with. */
export interface SelectedImage {
  readonly url: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
}

export interface SelectLimits {
  /** Most images forwarded from a single message. */
  readonly maxCount: number;
  /** Skip attachments whose declared size exceeds this many bytes. */
  readonly maxBytes: number;
}

/** Lowercase and strip any `; charset=…` parameters from a media type. */
function normalizeType(raw: string): string {
  const semi = raw.indexOf(";");
  return (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
}

/** Resolve a supported media type from the declared content type, else the file extension. */
function resolveMimeType(attachment: AttachmentLike): string | null {
  if (attachment.contentType) {
    const declared = normalizeType(attachment.contentType);
    if (SUPPORTED_TYPES[declared]) return declared;
  }
  const dot = attachment.name.lastIndexOf(".");
  if (dot !== -1) {
    const byExt = EXTENSION_TYPES[attachment.name.slice(dot + 1).toLowerCase()];
    if (byExt) return byExt;
  }
  return null;
}

/**
 * Filter a message's attachments down to forwardable images, honoring the format
 * allowlist and the size/count caps. Unsupported or oversized files are dropped
 * silently; order is preserved so the first images win the count cap.
 */
export function selectImages(attachments: Iterable<AttachmentLike>, limits: SelectLimits): SelectedImage[] {
  const selected: SelectedImage[] = [];
  for (const attachment of attachments) {
    if (selected.length >= limits.maxCount) break;
    if (attachment.size > limits.maxBytes) continue;
    const mimeType = resolveMimeType(attachment);
    if (!mimeType) continue;
    selected.push({ url: attachment.url, name: attachment.name, size: attachment.size, mimeType });
  }
  return selected;
}

export interface FetchOptions {
  /** Hard cap on downloaded bytes — defense in depth against a lying `size`. */
  readonly maxBytes: number;
  /** Per-image download timeout. */
  readonly timeoutMs: number;
  readonly logger: Logger;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Download each selected image and base64-encode it into an `ImageContent`. A
 * failed, timed-out, or oversized download is logged and skipped, never thrown:
 * the turn proceeds with whatever images succeeded (plus the user's text).
 */
export async function fetchImages(images: SelectedImage[], options: FetchOptions): Promise<ImageContent[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const results = await Promise.all(
    images.map(async (image): Promise<ImageContent | null> => {
      try {
        const response = await fetchImpl(image.url, { signal: AbortSignal.timeout(options.timeoutMs) });
        if (!response.ok) {
          options.logger.warn("image download failed", { name: image.name, status: response.status });
          return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > options.maxBytes) {
          options.logger.warn("image exceeded size cap after download", {
            name: image.name,
            bytes: buffer.byteLength,
          });
          return null;
        }
        return { type: "image", data: buffer.toString("base64"), mimeType: image.mimeType };
      } catch (error) {
        options.logger.warn("image download errored", { name: image.name, error });
        return null;
      }
    }),
  );
  return results.filter((image): image is ImageContent => image !== null);
}
