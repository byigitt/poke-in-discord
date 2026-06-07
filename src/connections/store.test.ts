import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "./store.ts";

let dir: string;
let store: TokenStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-tok-"));
  store = new TokenStore(join(dir, "connections.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("TokenStore", () => {
  test("set then get round-trips the tokens", () => {
    store.set("u1", "google-calendar", { accessToken: "a", refreshToken: "r", expiresAt: 123 });
    expect(store.get("u1", "google-calendar")).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
  });

  test("get is undefined for an unlinked connection", () => {
    expect(store.get("u1", "gmail")).toBeUndefined();
  });

  test("set replaces the existing row", () => {
    store.set("u1", "gmail", { accessToken: "old" });
    store.set("u1", "gmail", { accessToken: "new" });
    expect(store.get("u1", "gmail")?.accessToken).toBe("new");
  });

  test("list returns a user's providers, sorted", () => {
    store.set("u1", "gmail", { accessToken: "a" });
    store.set("u1", "google-calendar", { accessToken: "a" });
    expect(store.list("u1")).toEqual(["gmail", "google-calendar"]);
  });

  test("isolates one user's tokens from another's", () => {
    store.set("u1", "gmail", { accessToken: "a" });
    expect(store.list("u2")).toEqual([]);
    expect(store.get("u2", "gmail")).toBeUndefined();
  });

  test("delete removes the row and reports whether it existed", () => {
    store.set("u1", "gmail", { accessToken: "a" });
    expect(store.delete("u1", "gmail")).toBe(true);
    expect(store.delete("u1", "gmail")).toBe(false);
    expect(store.get("u1", "gmail")).toBeUndefined();
  });

  test("persists across reopen (refresh tokens survive a restart)", () => {
    store.set("u1", "gmail", { accessToken: "a", refreshToken: "r" });
    store.close();
    const reopened = new TokenStore(join(dir, "connections.db"));
    expect(reopened.get("u1", "gmail")).toEqual({ accessToken: "a", refreshToken: "r" });
    reopened.close();
  });
});
