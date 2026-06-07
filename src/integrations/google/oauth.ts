/**
 * Shared Google OAuth wiring. Every Google app (Calendar, Gmail, …) uses the
 * same OAuth client (one `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) and the same
 * endpoints — only the scopes differ. `googleConnection` stamps out the per-app
 * ConnectionSpec so an integration just names its scopes.
 */
import type { ConnectionSpec } from "../../connections/oauth.ts";

/** Env vars holding the shared Google OAuth client. Presence gates every Google app. */
export const GOOGLE_CLIENT_ID_ENV = "GOOGLE_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV = "GOOGLE_CLIENT_SECRET";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// `offline` + `consent` are what actually get us a refresh token back from Google.
const GOOGLE_AUTH_PARAMS = { access_type: "offline", prompt: "consent" } as const;

/** Build a Google ConnectionSpec for one app: same client, app-specific scopes. */
export function googleConnection(provider: string, label: string, scopes: readonly string[]): ConnectionSpec {
  return {
    provider,
    label,
    endpoints: { authUrl: GOOGLE_AUTH_URL, tokenUrl: GOOGLE_TOKEN_URL, scopes, authParams: GOOGLE_AUTH_PARAMS },
    clientIdEnv: GOOGLE_CLIENT_ID_ENV,
    clientSecretEnv: GOOGLE_CLIENT_SECRET_ENV,
  };
}
