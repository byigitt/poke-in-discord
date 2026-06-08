import { describe, expect, test } from "bun:test";
import { ALL_INTEGRATIONS } from "./index.ts";
import { integrationSetupGuide, selectConfigured } from "./select.ts";
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

describe("integrationSetupGuide", () => {
  const oauthWithSetup: Integration = {
    ...oauth,
    capability: "Do OAuthy things",
    setup: { credential: "an OAuthy app at oauthy.test/apps" },
  };
  const requiresWithSetup: Integration = {
    name: "keyed",
    capability: "Do keyed things",
    requires: ["KEYED_API_KEY"],
    setup: { credential: "a key at keyed.test", note: "read-only is enough" },
    tools: noTools,
  };

  test("returns null for an integration that declares no setup", () => {
    expect(integrationSetupGuide(plain)).toBeNull();
    expect(integrationSetupGuide(oauth)).toBeNull();
  });

  test("an OAuth app's guide names the credential, both client vars, restart, and the connect step", () => {
    const guide = integrationSetupGuide(oauthWithSetup);
    expect(guide).toContain("Do OAuthy things");
    expect(guide).toContain("an OAuthy app at oauthy.test/apps");
    expect(guide).toContain("X_ID and X_SECRET");
    expect(guide).toContain("restart");
    expect(guide).toContain("connect oauthy");
  });

  test("states the exact redirect URI when given, and omits it otherwise", () => {
    const withUri = integrationSetupGuide(oauthWithSetup, "https://bot.example.com/oauth/callback") ?? "";
    expect(withUri).toContain("https://bot.example.com/oauth/callback");
    expect(withUri).toContain("authorized redirect URI");
    expect(integrationSetupGuide(oauthWithSetup)).not.toContain("redirect URI");
  });

  test("a requires-only app's guide names its env var and skips the connect step", () => {
    const guide = integrationSetupGuide(requiresWithSetup) ?? "";
    expect(guide).toContain("KEYED_API_KEY");
    expect(guide).not.toContain("connect");
    expect(guide).toContain("(read-only is enough)");
  });

  test("real catalog: Google Calendar guides to the OAuth client vars and `connect google-calendar`", () => {
    const calendar = ALL_INTEGRATIONS.find((i) => i.name === "google-calendar");
    const guide = integrationSetupGuide(calendar!, "http://localhost:8787/oauth/callback") ?? "";
    expect(guide).toContain("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    expect(guide).toContain("connect google-calendar");
    expect(guide).toContain("console.cloud.google.com");
    expect(guide).toContain("http://localhost:8787/oauth/callback");
  });

  test("real catalog: always-on and shell apps declare no setup guide", () => {
    for (const name of ["filesystem", "web-search", "reminders", "shell"]) {
      const integration = ALL_INTEGRATIONS.find((i) => i.name === name);
      expect(integrationSetupGuide(integration!)).toBeNull();
    }
  });
});
