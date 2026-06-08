import { describe, expect, test } from "bun:test";
import { isOwner, parseOwnerIds } from "./config.ts";

describe("parseOwnerIds", () => {
  test("blank or unset yields an empty list", () => {
    expect(parseOwnerIds(undefined)).toEqual([]);
    expect(parseOwnerIds("")).toEqual([]);
    expect(parseOwnerIds("   ")).toEqual([]);
  });

  test("splits on commas and whitespace, trimming and dropping blanks", () => {
    expect(parseOwnerIds("123")).toEqual(["123"]);
    expect(parseOwnerIds("123,456")).toEqual(["123", "456"]);
    expect(parseOwnerIds("  123 , 456 ")).toEqual(["123", "456"]);
    expect(parseOwnerIds("123 456\n789")).toEqual(["123", "456", "789"]);
    expect(parseOwnerIds("123,,456,")).toEqual(["123", "456"]);
  });
});

describe("isOwner", () => {
  test("with no owners configured, everyone is allowed (open mode)", () => {
    expect(isOwner([], "anyone")).toBe(true);
  });

  test("with owners configured, only listed IDs are allowed", () => {
    const owners = ["123", "456"];
    expect(isOwner(owners, "123")).toBe(true);
    expect(isOwner(owners, "456")).toBe(true);
    expect(isOwner(owners, "999")).toBe(false);
    expect(isOwner(owners, "")).toBe(false);
  });
});
