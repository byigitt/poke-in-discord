import { describe, expect, test } from "bun:test";
import type { Logger } from "../logger.ts";
import { type AttachmentLike, fetchImages, selectImages, type SelectedImage } from "./attachments.ts";

function makeNullLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: makeNullLogger };
}

const LIMITS = { maxCount: 4, maxBytes: 1_000 };

function att(overrides: Partial<AttachmentLike>): AttachmentLike {
  return { url: "https://cdn/x.png", name: "x.png", size: 100, contentType: "image/png", ...overrides };
}

describe("selectImages", () => {
  test("keeps supported image types and drops everything else", () => {
    const out = selectImages(
      [
        att({ name: "a.png", contentType: "image/png" }),
        att({ name: "b.jpg", contentType: "image/jpeg" }),
        att({ name: "c.gif", contentType: "image/gif" }),
        att({ name: "d.webp", contentType: "image/webp" }),
        att({ name: "doc.pdf", contentType: "application/pdf" }),
        att({ name: "photo.heic", contentType: "image/heic" }),
      ],
      LIMITS,
    );
    expect(out.map((i) => i.mimeType)).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  });

  test("normalizes casing and strips media-type parameters", () => {
    const out = selectImages([att({ name: "a", contentType: "IMAGE/PNG; charset=binary" })], LIMITS);
    expect(out).toHaveLength(1);
    expect(out[0]?.mimeType).toBe("image/png");
  });

  test("falls back to the file extension when content type is missing", () => {
    const out = selectImages(
      [
        att({ name: "snap.JPEG", contentType: null }),
        att({ name: "anim.GIF", contentType: null }),
        att({ name: "mystery.bin", contentType: null }),
        att({ name: "noext", contentType: null }),
      ],
      LIMITS,
    );
    expect(out.map((i) => i.mimeType)).toEqual(["image/jpeg", "image/gif"]);
  });

  test("drops attachments larger than the byte cap", () => {
    const out = selectImages(
      [att({ name: "small.png", size: 999 }), att({ name: "big.png", size: 1_001 })],
      LIMITS,
    );
    expect(out.map((i) => i.name)).toEqual(["small.png"]);
  });

  test("honors the count cap, keeping the first images", () => {
    const out = selectImages(
      Array.from({ length: 6 }, (_, i) => att({ name: `${i}.png` })),
      { maxCount: 2, maxBytes: 1_000 },
    );
    expect(out.map((i) => i.name)).toEqual(["0.png", "1.png"]);
  });

  test("returns nothing when there are no attachments", () => {
    expect(selectImages([], LIMITS)).toEqual([]);
  });
});

describe("fetchImages", () => {
  const logger = makeNullLogger();
  const image = (name: string, url: string): SelectedImage => ({ url, name, size: 4, mimeType: "image/png" });

  function fetchReturning(map: Record<string, Response>): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      const res = map[url];
      if (!res) throw new Error(`unexpected url ${url}`);
      return res;
    }) as unknown as typeof fetch;
  }

  test("base64-encodes a successful download with its declared mime type", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const out = await fetchImages([image("a.png", "https://cdn/a")], {
      maxBytes: 1_000,
      timeoutMs: 1_000,
      logger,
      fetchImpl: fetchReturning({ "https://cdn/a": new Response(bytes) }),
    });
    expect(out).toEqual([{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" }]);
  });

  test("skips a non-ok response without throwing", async () => {
    const out = await fetchImages([image("a.png", "https://cdn/a")], {
      maxBytes: 1_000,
      timeoutMs: 1_000,
      logger,
      fetchImpl: fetchReturning({ "https://cdn/a": new Response("nope", { status: 404 }) }),
    });
    expect(out).toEqual([]);
  });

  test("skips a body that exceeds the cap after download", async () => {
    const out = await fetchImages([image("a.png", "https://cdn/a")], {
      maxBytes: 8,
      timeoutMs: 1_000,
      logger,
      fetchImpl: fetchReturning({ "https://cdn/a": new Response(new Uint8Array(16)) }),
    });
    expect(out).toEqual([]);
  });

  test("a thrown fetch (e.g. timeout) is swallowed and skipped", async () => {
    const out = await fetchImages([image("a.png", "https://cdn/a")], {
      maxBytes: 1_000,
      timeoutMs: 1_000,
      logger,
      fetchImpl: (() => Promise.reject(new Error("timed out"))) as unknown as typeof fetch,
    });
    expect(out).toEqual([]);
  });

  test("returns the successes when some images fail", async () => {
    const ok = Uint8Array.from([9, 9]);
    const out = await fetchImages([image("a.png", "https://cdn/a"), image("b.png", "https://cdn/b")], {
      maxBytes: 1_000,
      timeoutMs: 1_000,
      logger,
      fetchImpl: fetchReturning({
        "https://cdn/a": new Response("boom", { status: 500 }),
        "https://cdn/b": new Response(ok),
      }),
    });
    expect(out).toEqual([{ type: "image", data: Buffer.from(ok).toString("base64"), mimeType: "image/png" }]);
  });

  test("returns nothing for an empty selection", async () => {
    expect(await fetchImages([], { maxBytes: 1_000, timeoutMs: 1_000, logger })).toEqual([]);
  });
});
