/**
 * The brain of account-linking. Holds the registered OAuth providers, the
 * in-flight connect attempts (state -> PKCE verifier + who started it), and the
 * token store. Integrations never touch OAuth directly: they ask
 * `accessToken(userId, provider)` and get a fresh token, transparently refreshed.
 */
import type { Logger } from "../logger.ts";
import {
  buildAuthUrl,
  exchangeCode,
  generatePkce,
  type OAuthProvider,
  randomState,
  refreshTokens,
} from "./oauth.ts";
import type { TokenStore } from "./store.ts";

/** An authorization that's been started but not yet completed via callback. */
interface PendingConnect {
  readonly userId: string;
  readonly providerId: string;
  readonly verifier: string;
  readonly createdAt: number;
}

/** Outcome of a successful callback, used to tell the user what got linked. */
export interface CompletedConnect {
  readonly userId: string;
  readonly providerId: string;
  readonly label: string;
}

/** Refresh this many ms before the stored expiry, to absorb clock skew + latency. */
const EXPIRY_SKEW_MS = 60_000;
/** Drop a started-but-never-finished connect attempt after this long. */
const PENDING_TTL_MS = 10 * 60_000;

export class ConnectionManager {
  private readonly providers = new Map<string, OAuthProvider>();
  private readonly pending = new Map<string, PendingConnect>();

  constructor(
    private readonly store: TokenStore,
    /** Absolute callback URL registered with every provider, e.g. http://localhost:8787/oauth/callback. */
    private readonly redirectUri: string,
    private readonly logger: Logger,
  ) {}

  /** Make a provider connectable. Called once per OAuth integration at startup. */
  registerProvider(provider: OAuthProvider): void {
    this.providers.set(provider.id, provider);
  }

  hasProviders(): boolean {
    return this.providers.size > 0;
  }

  /** Connectable providers as `{ id, label }`, sorted, for connect prompts. */
  catalog(): { id: string; label: string }[] {
    return [...this.providers.values()]
      .map((p) => ({ id: p.id, label: p.label }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  label(providerId: string): string | undefined {
    return this.providers.get(providerId)?.label;
  }

  /** Begin a connect: returns the consent URL to send the user, or null if unknown. */
  beginConnect(userId: string, providerId: string): string | null {
    const provider = this.providers.get(providerId);
    if (!provider) return null;
    this.prunePending();
    const state = randomState();
    const { verifier, challenge } = generatePkce();
    this.pending.set(state, { userId, providerId, verifier, createdAt: Date.now() });
    return buildAuthUrl(provider, { redirectUri: this.redirectUri, state, codeChallenge: challenge });
  }

  /**
   * Complete a connect from the OAuth callback. Returns what got linked, or null
   * if the state is unknown/expired. Throws if the code exchange itself fails.
   */
  async completeConnect(state: string, code: string): Promise<CompletedConnect | null> {
    const pending = this.pending.get(state);
    if (!pending) return null;
    this.pending.delete(state);
    const provider = this.providers.get(pending.providerId);
    if (!provider) return null;
    const tokens = await exchangeCode(provider, {
      code,
      codeVerifier: pending.verifier,
      redirectUri: this.redirectUri,
    });
    this.store.set(pending.userId, pending.providerId, tokens);
    this.logger.info("connection linked", { providerId: pending.providerId });
    return { userId: pending.userId, providerId: pending.providerId, label: provider.label };
  }

  /**
   * A usable access token for this user's connection, or null if not linked (or
   * the refresh failed). Refreshes transparently when the stored token is stale.
   */
  async accessToken(userId: string, providerId: string): Promise<string | null> {
    const tokens = this.store.get(userId, providerId);
    if (!tokens) return null;

    const stale = tokens.expiresAt !== undefined && tokens.expiresAt - Date.now() <= EXPIRY_SKEW_MS;
    if (!stale) return tokens.accessToken;
    if (!tokens.refreshToken) return tokens.accessToken; // nothing to refresh with; let the caller try

    const provider = this.providers.get(providerId);
    if (!provider) return tokens.accessToken;
    try {
      const refreshed = await refreshTokens(provider, tokens.refreshToken);
      // Providers (Google) often omit a new refresh token on refresh — keep the old one.
      const merged = { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
      this.store.set(userId, providerId, merged);
      return merged.accessToken;
    } catch (error) {
      this.logger.warn("token refresh failed", { providerId, error });
      return null;
    }
  }

  /** Whether this user currently has a (possibly stale) token for the connection. */
  isConnected(userId: string, providerId: string): boolean {
    return this.store.get(userId, providerId) !== undefined;
  }

  /** Connection ids a user has linked. */
  connections(userId: string): string[] {
    return this.store.list(userId);
  }

  /** Forget a user's connection. Returns true if something was removed. */
  disconnect(userId: string, providerId: string): boolean {
    return this.store.delete(userId, providerId);
  }

  private prunePending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state);
    }
  }
}
