/**
 * Pure parsing for the account-linking chat commands, split out from the Discord
 * layer so it's trivially testable: text in, intent out. The bot does the I/O
 * (DMing URLs, calling the manager); this just decides what the user asked for.
 */

/** What an account-linking message resolves to, or null when it isn't one. */
export type ConnectCommand =
  | { readonly kind: "list" }
  | { readonly kind: "connect"; readonly app?: string }
  | { readonly kind: "disconnect"; readonly app?: string };

const LIST_WORDS: Record<string, true> = {
  accounts: true,
  connections: true,
  "/connections": true,
  "my accounts": true,
};

/** Classify a (mention-stripped) message as a connect/disconnect/list command, or null. */
export function parseConnectCommand(text: string): ConnectCommand | null {
  const lower = text.toLowerCase().trim();
  if (LIST_WORDS[lower]) return { kind: "list" };

  const connect = lower.match(/^\/?connect(?:\s+(.+))?$/);
  if (connect) return { kind: "connect", app: connect[1]?.trim() || undefined };

  const disconnect = lower.match(/^\/?disconnect(?:\s+(.+))?$/);
  if (disconnect) return { kind: "disconnect", app: disconnect[1]?.trim() || undefined };

  return null;
}

/** Map free text ("Google Calendar") to a known provider id ("google-calendar"), or null. */
export function matchProvider(raw: string | undefined, knownIds: readonly string[]): string | null {
  if (!raw) return null;
  const normalized = raw.toLowerCase().trim().replace(/\s+/g, "-");
  return knownIds.includes(normalized) ? normalized : null;
}
