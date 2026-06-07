import { describe, expect, test } from "bun:test";
import { matchProvider, parseConnectCommand } from "./commands.ts";

describe("parseConnectCommand", () => {
  test("recognizes the list aliases", () => {
    for (const word of ["accounts", "connections", "/connections", "My Accounts"]) {
      expect(parseConnectCommand(word)).toEqual({ kind: "list" });
    }
  });

  test("parses connect with an app name", () => {
    expect(parseConnectCommand("connect google calendar")).toEqual({ kind: "connect", app: "google calendar" });
    expect(parseConnectCommand("/connect gmail")).toEqual({ kind: "connect", app: "gmail" });
  });

  test("parses a bare connect (no app yet)", () => {
    expect(parseConnectCommand("connect")).toEqual({ kind: "connect", app: undefined });
  });

  test("parses disconnect", () => {
    expect(parseConnectCommand("disconnect gmail")).toEqual({ kind: "disconnect", app: "gmail" });
  });

  test("ignores ordinary chat that merely contains 'connect'", () => {
    expect(parseConnectCommand("can you connect these ideas for me?")).toBeNull();
    expect(parseConnectCommand("hey what's up")).toBeNull();
  });
});

describe("matchProvider", () => {
  const known = ["google-calendar", "gmail"];

  test("normalizes spaces to hyphens", () => {
    expect(matchProvider("Google Calendar", known)).toBe("google-calendar");
  });

  test("matches an exact id", () => {
    expect(matchProvider("gmail", known)).toBe("gmail");
  });

  test("returns null for unknown or empty", () => {
    expect(matchProvider("notion", known)).toBeNull();
    expect(matchProvider(undefined, known)).toBeNull();
  });
});
