import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildAuthUrl,
  type ConnectionSpec,
  generatePkce,
  type OAuthProvider,
  resolveProvider,
} from "./oauth.ts";

const provider: OAuthProvider = {
  id: "google-calendar",
  label: "Google Calendar",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/calendar.events"],
  authParams: { access_type: "offline", prompt: "consent" },
  client: { clientId: "cid", clientSecret: "secret" },
};

describe("generatePkce", () => {
  test("challenge is the S256 (base64url) of the verifier", () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  test("each call produces a fresh verifier", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("buildAuthUrl", () => {
  test("carries all required OAuth + PKCE params", () => {
    const url = new URL(
      buildAuthUrl(provider, {
        redirectUri: "http://localhost:8787/oauth/callback",
        state: "st8",
        codeChallenge: "chal",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8787/oauth/callback");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // Static authParams flow through.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("resolveProvider", () => {
  const spec: ConnectionSpec = {
    provider: "google-calendar",
    label: "Google Calendar",
    endpoints: { authUrl: "a", tokenUrl: "t", scopes: ["s"] },
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  };

  test("builds a provider when both client env vars are present", () => {
    const resolved = resolveProvider(spec, { GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" });
    expect(resolved?.id).toBe("google-calendar");
    expect(resolved?.client).toEqual({ clientId: "x", clientSecret: "y" });
  });

  test("returns null when a client env var is missing or blank", () => {
    expect(resolveProvider(spec, {})).toBeNull();
    expect(resolveProvider(spec, { GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "   " })).toBeNull();
  });
});
