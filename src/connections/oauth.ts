/**
 * OAuth 2.0 authorization-code + PKCE primitives, provider-agnostic.
 *
 * Everything here is pure or a single well-scoped fetch, so an integration only
 * has to declare endpoints + scopes (see `OAuthEndpoints`) to become connectable.
 * No provider-specific logic lives here — Google, Notion, GitHub, etc. all flow
 * through the same four functions.
 */
import { createHash, randomBytes } from "node:crypto";

/** Where a provider's OAuth lives and what we ask for. Declared by an integration. */
export interface OAuthEndpoints {
  /** Authorization endpoint the user is sent to (consent screen). */
  readonly authUrl: string;
  /** Token endpoint we POST to for code exchange and refresh. */
  readonly tokenUrl: string;
  /** Scopes requested at consent. */
  readonly scopes: readonly string[];
  /** Extra static auth-URL params, e.g. Google's `access_type=offline` + `prompt=consent`. */
  readonly authParams?: Readonly<Record<string, string>>;
}

/** Client credentials, resolved from env at startup. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** A fully-resolved provider: endpoints + the connection id/label + client creds. */
export interface OAuthProvider extends OAuthEndpoints {
  /** Connection id, e.g. "google-calendar"; also the token-store key and `connect <id>`. */
  readonly id: string;
  /** Human label shown in connect prompts, e.g. "Google Calendar". */
  readonly label: string;
  readonly client: OAuthClient;
}

/**
 * An integration's declaration that it needs a linked account. The framework
 * turns this + env into an {@link OAuthProvider}: the integration only names its
 * endpoints, scopes, and which env vars hold the OAuth client — nothing more.
 */
export interface ConnectionSpec {
  /** Connection id, e.g. "google-calendar". Used in `connect <id>` and as the token key. */
  readonly provider: string;
  readonly label: string;
  readonly endpoints: OAuthEndpoints;
  /** Env var holding the OAuth client id (its presence gates the integration). */
  readonly clientIdEnv: string;
  /** Env var holding the OAuth client secret. */
  readonly clientSecretEnv: string;
}

/** Resolve a spec against env into a usable provider, or null when unconfigured. */
export function resolveProvider(
  spec: ConnectionSpec,
  env: Record<string, string | undefined>,
): OAuthProvider | null {
  const clientId = env[spec.clientIdEnv]?.trim();
  const clientSecret = env[spec.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) return null;
  return { id: spec.provider, label: spec.label, ...spec.endpoints, client: { clientId, clientSecret } };
}

/** Tokens as we store them: access + (optional) refresh + absolute expiry. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms at which `accessToken` stops working; undefined when unknown. */
  readonly expiresAt?: number;
  readonly scope?: string;
  readonly tokenType?: string;
}

/** PKCE pair: keep `verifier` server-side, send `challenge` to the auth endpoint. */
export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** Generate a PKCE verifier and its S256 challenge (RFC 7636). */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** A random, URL-safe value to tie an auth request to its callback. */
export function randomState(): string {
  return randomBytes(24).toString("base64url");
}

/** Build the consent URL the user clicks to authorize the connection. */
export function buildAuthUrl(
  provider: OAuthProvider,
  params: { redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(provider.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.client.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(provider.authParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** POST to the token endpoint and normalize the response. Shared by exchange + refresh. */
async function requestTokens(
  provider: OAuthProvider,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: provider.client.clientId,
      client_secret: provider.client.clientSecret,
      ...body,
    }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${provider.label} token request failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text) as TokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    scope: data.scope,
    tokenType: data.token_type,
  };
}

/** Exchange an authorization code (with its PKCE verifier) for tokens. */
export function exchangeCode(
  provider: OAuthProvider,
  params: { code: string; codeVerifier: string; redirectUri: string },
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  return requestTokens(
    provider,
    {
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    },
    signal,
  );
}

/** Trade a refresh token for a fresh access token (providers may omit a new refresh token). */
export function refreshTokens(
  provider: OAuthProvider,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<OAuthTokens> {
  return requestTokens(provider, { grant_type: "refresh_token", refresh_token: refreshToken }, signal);
}
