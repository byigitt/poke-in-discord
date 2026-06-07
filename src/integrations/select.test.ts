import { describe, expect, test } from "bun:test";
import { ALL_INTEGRATIONS, selectConfigured } from "./index.ts";
import type { Integration } from "./types.ts";

const noTools: Integration["tools"] = () => [];

const plain: Integration = { name: "plain", tools: noTools };
const needsKey: Integration = { name: "needs-key", requires: ["FOO_KEY"], tools: noTools };
const oauth: Integration = {
  name: "oauthy",
  connection: {
    provider: "oauthy",
    label: "OAuthy",
    endpoints: { authUrl: "a", tokenUrl: "t", scopes: [] },
    clientIdEnv: "X_ID",
    clientSecretEnv: "X_SECRET",
  },
  tools: noTools,
};

describe("selectConfigured", () => {
  test("always enables integrations with no requirements", () => {
    expect(selectConfigured([plain], {}).enabled.map((i) => i.name)).toEqual(["plain"]);
  });

  test("skips an integration missing a required env var, naming what's missing", () => {
    const { enabled, skipped } = selectConfigured([needsKey], {});
    expect(enabled).toEqual([]);
    expect(skipped).toEqual([{ name: "needs-key", missing: ["FOO_KEY"] }]);
  });

  test("enables a required-env integration once the var is set", () => {
    expect(selectConfigured([needsKey], { FOO_KEY: "v" }).enabled.map((i) => i.name)).toEqual(["needs-key"]);
  });

  test("gates an OAuth integration on both client env vars", () => {
    expect(selectConfigured([oauth], {}).skipped[0]?.missing).toEqual(["X_ID", "X_SECRET"]);
    expect(selectConfigured([oauth], { X_ID: "a" }).skipped[0]?.missing).toEqual(["X_SECRET"]);
    expect(selectConfigured([oauth], { X_ID: "a", X_SECRET: "b" }).enabled.map((i) => i.name)).toEqual(["oauthy"]);
  });

  test("blank env values do not count as configured", () => {
    expect(selectConfigured([needsKey], { FOO_KEY: "   " }).enabled).toEqual([]);
  });

  test("real catalog: filesystem + web-search always load; Google apps gate on Google creds", () => {
    const bare = selectConfigured(ALL_INTEGRATIONS, {});
    expect(bare.enabled.map((i) => i.name)).toEqual(["filesystem", "web-search", "reminders"]);
    const skippedNames = bare.skipped.map((s) => s.name);
    expect(skippedNames).toContain("google-calendar");
    expect(skippedNames).toContain("gmail");
    expect(skippedNames).toContain("shell"); // off unless POKE_SHELL_ENABLED is set

    const withGoogle = selectConfigured(ALL_INTEGRATIONS, {
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    const enabledNames = withGoogle.enabled.map((i) => i.name);
    expect(enabledNames).toContain("google-calendar");
    expect(enabledNames).toContain("gmail");

    expect(selectConfigured(ALL_INTEGRATIONS, { POKE_SHELL_ENABLED: "1" }).enabled.map((i) => i.name)).toContain(
      "shell",
    );
  });
});
