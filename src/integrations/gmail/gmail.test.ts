import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActorRegistry } from "../../actor.ts";
import { ConnectionManager } from "../../connections/manager.ts";
import { TokenStore } from "../../connections/store.ts";
import type { CustomTool } from "../types.ts";
import { fakeIntegrationContext, fakeToolContext, silentLogger, textOf } from "../../test-support.ts";
import { buildRawMessage, gmailIntegration } from "./index.ts";

const SESSION = "/sessions/chan.jsonl";
let dir: string;
let store: TokenStore;
let tools: Map<string, CustomTool>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "poke-gmail-"));
  store = new TokenStore(join(dir, "connections.db"));
  const connections = new ConnectionManager(store, "http://localhost/oauth/callback", silentLogger);
  const actor = new ActorRegistry();
  actor.enter(SESSION, { userId: "u1", channelId: "c1" });
  const ctx = fakeIntegrationContext({ connections, actor });
  tools = new Map((await gmailIntegration.tools(ctx)).map((t) => [t.name, t]));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const toolCtx = () => fakeToolContext({ sessionFile: SESSION, sessionId: "sid" });

describe("gmail tools", () => {
  test("exposes search, read, and send", () => {
    expect([...tools.keys()].sort()).toEqual(["read_email", "search_emails", "send_email"]);
  });

  test("search tells the user to connect when no account is linked", async () => {
    const res = await tools.get("search_emails")!.execute("c", { max_results: 5 }, undefined, toolCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("connect");
  });

  test("send tells the user to connect when no account is linked", async () => {
    const res = await tools
      .get("send_email")!
      .execute("c", { to: "a@b.com", subject: "hi", body: "yo" }, undefined, toolCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("connect");
  });
});

describe("gmail connection", () => {
  test("declares the Google client and gmail scopes", () => {
    const spec = gmailIntegration.connection;
    expect(spec?.provider).toBe("gmail");
    expect(spec?.clientIdEnv).toBe("GOOGLE_CLIENT_ID");
    expect(spec?.endpoints.scopes).toContain("https://www.googleapis.com/auth/gmail.send");
  });
});

describe("buildRawMessage", () => {
  test("produces a base64url RFC822 message with headers and body", () => {
    const decoded = Buffer.from(
      buildRawMessage({ to: "a@b.com", subject: "Hello", body: "line one", cc: "c@d.com" }),
      "base64url",
    ).toString("utf8");
    expect(decoded).toContain("To: a@b.com");
    expect(decoded).toContain("Cc: c@d.com");
    expect(decoded).toContain("Subject: Hello");
    expect(decoded).toContain("line one");
  });

  test("RFC2047-encodes a non-ASCII subject (e.g. Turkish)", () => {
    const decoded = Buffer.from(
      buildRawMessage({ to: "a@b.com", subject: "Görüşürüz", body: "x" }),
      "base64url",
    ).toString("utf8");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    expect(decoded).not.toContain("Subject: Görüşürüz");
  });
});
