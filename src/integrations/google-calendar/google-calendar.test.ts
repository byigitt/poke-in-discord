import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Config } from "../../config.ts";
import type { Logger } from "../../logger.ts";
import type { PiRuntime } from "../../pi/runtime.ts";
import { ActorRegistry } from "../../actor.ts";
import { ConnectionManager } from "../../connections/manager.ts";
import { resolveProvider } from "../../connections/oauth.ts";
import { TokenStore } from "../../connections/store.ts";
import { ReplyOutbox } from "../../outbox.ts";
import type { CustomTool, IntegrationContext } from "../types.ts";
import { googleCalendarIntegration } from "./index.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function textOf(result: { content: { type: string }[] }): string {
  return result.content.map((c) => (c.type === "text" ? (c as TextContent).text : "")).join("");
}

const SESSION = "/sessions/chan.jsonl";
let dir: string;
let store: TokenStore;
let tools: Map<string, CustomTool>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "poke-gcal-"));
  store = new TokenStore(join(dir, "connections.db"));
  const connections = new ConnectionManager(store, "http://localhost/oauth/callback", silent);
  const actor = new ActorRegistry();
  actor.enter(SESSION, "u1"); // someone is talking, but hasn't linked their calendar
  const ctx: IntegrationContext = {
    runtime: undefined as unknown as PiRuntime,
    config: {} as unknown as Config,
    logger: silent,
    outbox: new ReplyOutbox(),
    connections,
    actor,
  };
  tools = new Map((await googleCalendarIntegration.tools(ctx)).map((t) => [t.name, t]));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const toolCtx = (): CustomToolContext =>
  ({ sessionManager: { getSessionFile: () => SESSION, getSessionId: () => "sid" } }) as unknown as CustomToolContext;

describe("google-calendar tools", () => {
  test("exposes list, quick-add, and create", () => {
    expect([...tools.keys()].sort()).toEqual([
      "create_calendar_event",
      "list_calendar_events",
      "quick_add_calendar_event",
    ]);
  });

  test("list tells the user to connect when no account is linked", async () => {
    const res = await tools.get("list_calendar_events")!.execute("c", { max_results: 10 }, undefined, toolCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("connect");
  });

  test("quick-add tells the user to connect when no account is linked", async () => {
    const res = await tools
      .get("quick_add_calendar_event")!
      .execute("c", { text: "lunch tomorrow at noon" }, undefined, toolCtx());
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain("connect");
  });
});

describe("google-calendar connection", () => {
  test("declares the shared Google OAuth client and the calendar scope", () => {
    const spec = googleCalendarIntegration.connection;
    expect(spec?.provider).toBe("google-calendar");
    expect(spec?.clientIdEnv).toBe("GOOGLE_CLIENT_ID");
    expect(spec?.clientSecretEnv).toBe("GOOGLE_CLIENT_SECRET");
    expect(spec?.endpoints.scopes).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  test("produces a real Google consent URL once the client is configured", () => {
    const provider = resolveProvider(googleCalendarIntegration.connection!, {
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_CLIENT_SECRET: "sec",
    });
    expect(provider).not.toBeNull();
    const manager = new ConnectionManager(store, "http://localhost:8787/oauth/callback", silent);
    manager.registerProvider(provider!);
    const parsed = new URL(manager.beginConnect("u1", "google-calendar")!);
    expect(parsed.host).toBe("accounts.google.com");
    expect(parsed.searchParams.get("client_id")).toBe("cid");
    expect(parsed.searchParams.get("scope")).toContain("calendar.events");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
  });
});
