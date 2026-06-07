import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../test-support.ts";
import { ConnectionManager } from "./manager.ts";
import type { OAuthProvider } from "./oauth.ts";
import { OAuthCallbackServer } from "./server.ts";
import { TokenStore } from "./store.ts";


const provider: OAuthProvider = {
  id: "google-calendar",
  label: "Google Calendar",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["scope"],
  client: { clientId: "cid", clientSecret: "sec" },
};

let dir: string;
let store: TokenStore;
let server: OAuthCallbackServer;
let base: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "poke-srv-"));
  store = new TokenStore(join(dir, "connections.db"));
  const manager = new ConnectionManager(store, "http://localhost/oauth/callback", silentLogger);
  manager.registerProvider(provider);
  server = new OAuthCallbackServer(manager, 0, silentLogger); // port 0 → OS assigns a free port
  server.start();
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("OAuthCallbackServer", () => {
  test("shows a friendly page when the user denies consent", async () => {
    const res = await fetch(`${base}/oauth/callback?error=access_denied`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connection canceled");
  });

  test("rejects a callback missing code or state", async () => {
    const res = await fetch(`${base}/oauth/callback?code=only-code`);
    expect(res.status).toBe(400);
  });

  test("reports an expired/unknown link instead of crashing", async () => {
    const res = await fetch(`${base}/oauth/callback?code=x&state=never-issued`);
    expect(res.status).toBe(400);
    expect((await res.text()).toLowerCase()).toContain("expired");
  });

  test("answers other paths with a health ok", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
  });
});
