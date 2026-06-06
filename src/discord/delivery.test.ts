import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { extractAssistantText, toDiscordMessages } from "./delivery.ts";

const LIMIT = 2000;

describe("toDiscordMessages", () => {
  test("returns nothing for empty/whitespace", () => {
    expect(toDiscordMessages("", 5)).toEqual([]);
    expect(toDiscordMessages("   \n\n  ", 5)).toEqual([]);
  });

  test("sends a few short paragraphs as separate bubbles (texting feel)", () => {
    const out = toDiscordMessages("one\n\ntwo\n\nthree", 5);
    expect(out).toEqual(["one", "two", "three"]);
  });

  test("packs into fewer messages when paragraphs exceed the bubble target", () => {
    const text = Array.from({ length: 9 }, (_, i) => `p${i}`).join("\n\n");
    const out = toDiscordMessages(text, 5);
    expect(out.length).toBeLessThan(9);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(LIMIT);
    // No content lost.
    for (let i = 0; i < 9; i++) expect(out.join("\n\n")).toContain(`p${i}`);
  });

  test("hard-splits an oversized block to respect the 2000-char limit", () => {
    const huge = "x".repeat(4500);
    const out = toDiscordMessages(huge, 5);
    expect(out.length).toBeGreaterThan(1);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(LIMIT);
    expect(out.join("").length).toBe(4500);
  });

  test("keeps a fenced code block intact even with blank lines inside", () => {
    const text = "here\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\ndone";
    const out = toDiscordMessages(text, 5);
    const codeMsg = out.find((m) => m.includes("```ts"));
    expect(codeMsg).toBeDefined();
    expect(codeMsg).toContain("const a = 1;");
    expect(codeMsg).toContain("const b = 2;");
    expect(codeMsg).toContain("```");
  });

  test("never emits a message longer than the limit", () => {
    const paragraphs = Array.from({ length: 6 }, () => "y".repeat(900)).join("\n\n");
    const out = toDiscordMessages(paragraphs, 5);
    for (const m of out) expect(m.length).toBeLessThanOrEqual(LIMIT);
  });
});

describe("extractAssistantText", () => {
  function msg(content: AssistantMessage["content"]): AssistantMessage {
    return { role: "assistant", content } as AssistantMessage;
  }

  test("returns empty string for undefined", () => {
    expect(extractAssistantText(undefined)).toBe("");
  });

  test("drops thinking/tool blocks and keeps only text", () => {
    const message = msg([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hello" },
      { type: "text", text: " there" },
    ] as AssistantMessage["content"]);
    expect(extractAssistantText(message)).toBe("hello there");
  });

  test("trims surrounding whitespace", () => {
    const message = msg([{ type: "text", text: "  hi  " }] as AssistantMessage["content"]);
    expect(extractAssistantText(message)).toBe("hi");
  });
});
