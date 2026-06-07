import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger.ts";
import { ConnectionManager } from "./manager.ts";
import type { OAuthProvider } from "./oauth.ts";
import { TokenStore } from "./store.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const provider: OAuthProvider = {
  id: "google-calendar",
  label: "Google Calendar",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["scope"],
  client: { clientId: "cid", clientSecret: "sec" },
};

const HOUR = 3_600_000;
let dir: string;
let store: TokenStore;
let manager: ConnectionManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-mgr-"));
  store = new TokenStore(join(dir, "connections.db"));
  manager = new ConnectionManager(store, "http://localhost:8787/oauth/callback", silent);
  manager.registerProvider(provider);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ConnectionManager", () => {
  test("exposes a registered provider in the catalog", () => {
    expect(manager.hasProviders()).toBe(true);
    expect(manager.catalog()).toEqual([{ id: "google-calendar", label: "Google Calendar" }]);
    expect(manager.label("google-calendar")).toBe("Google Calendar");
  });

  test("beginConnect mints a consent URL bound to a fresh state", () => {
    const url = manager.beginConnect("u1", "google-calendar");
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.host).toBe("accounts.google.com");
    expect(parsed.searchParams.get("client_id")).toBe("cid");
    expect(parsed.searchParams.get("state")).toBeTruthy();
  });

  test("beginConnect returns null for an unregistered provider", () => {
    expect(manager.beginConnect("u1", "nope")).toBeNull();
  });

  test("completeConnect rejects an unknown/expired state", async () => {
    expect(await manager.completeConnect("bogus-state", "code")).toBeNull();
  });

  test("accessToken returns a fresh stored token without refreshing", async () => {
    store.set("u1", "google-calendar", { accessToken: "fresh", expiresAt: Date.now() + HOUR });
    expect(await manager.accessToken("u1", "google-calendar")).toBe("fresh");
  });

  test("accessToken returns null when the user hasn't connected", async () => {
    expect(await manager.accessToken("u1", "google-calendar")).toBeNull();
  });

  test("accessToken returns a no-expiry token as-is", async () => {
    store.set("u1", "google-calendar", { accessToken: "noexp" });
    expect(await manager.accessToken("u1", "google-calendar")).toBe("noexp");
  });

  test("accessToken returns a stale token as-is when there is nothing to refresh with", async () => {
    store.set("u1", "google-calendar", { accessToken: "stale", expiresAt: Date.now() - 1000 });
    expect(await manager.accessToken("u1", "google-calendar")).toBe("stale");
  });

  test("isConnected and disconnect track linkage", () => {
    store.set("u1", "google-calendar", { accessToken: "a" });
    expect(manager.isConnected("u1", "google-calendar")).toBe(true);
    expect(manager.connections("u1")).toEqual(["google-calendar"]);
    expect(manager.disconnect("u1", "google-calendar")).toBe(true);
    expect(manager.isConnected("u1", "google-calendar")).toBe(false);
  });
});
