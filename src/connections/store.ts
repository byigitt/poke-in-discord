/**
 * Per-user, per-provider OAuth token storage, backed by SQLite (built into Bun).
 * One row per (Discord user, connection) — so a user can link, say, Google
 * Calendar and Gmail independently, and each Discord user has their own tokens.
 *
 * SQLite gives us atomic writes and crash safety for free; the file holds refresh
 * tokens, so it is created 0600 and lives wherever `POKE_CONNECTIONS_FILE` points
 * (default: alongside the session history).
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OAuthTokens } from "./oauth.ts";

interface TokenRow {
  data: string;
}

export class TokenStore {
  private readonly db: Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS tokens (
         user TEXT NOT NULL,
         provider TEXT NOT NULL,
         data TEXT NOT NULL,
         PRIMARY KEY (user, provider)
       )`,
    );
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* best effort: refresh tokens live here, but a failed chmod shouldn't crash startup */
    }
  }

  /** Tokens for a user's connection, or undefined if they haven't linked it. */
  get(userId: string, provider: string): OAuthTokens | undefined {
    const row = this.db
      .query<TokenRow, [string, string]>("SELECT data FROM tokens WHERE user = ? AND provider = ?")
      .get(userId, provider);
    return row ? (JSON.parse(row.data) as OAuthTokens) : undefined;
  }

  /** Insert or replace a user's tokens for a connection. */
  set(userId: string, provider: string, tokens: OAuthTokens): void {
    this.db.run("INSERT OR REPLACE INTO tokens (user, provider, data) VALUES (?, ?, ?)", [
      userId,
      provider,
      JSON.stringify(tokens),
    ]);
  }

  /** Remove a connection. Returns true if a row was actually deleted. */
  delete(userId: string, provider: string): boolean {
    return this.db.run("DELETE FROM tokens WHERE user = ? AND provider = ?", [userId, provider]).changes > 0;
  }

  /** Connection ids a user has linked, sorted for stable output. */
  list(userId: string): string[] {
    return this.db
      .query<{ provider: string }, [string]>("SELECT provider FROM tokens WHERE user = ? ORDER BY provider")
      .all(userId)
      .map((r) => r.provider);
  }

  close(): void {
    this.db.close();
  }
}
