/**
 * The bridge between integrations that produce files and the Discord layer that
 * sends them. A tool can't reach the live Discord channel — it runs deep inside
 * pi's agent loop — so instead it *stages* a file here, keyed by the session it's
 * running in. After the turn, the bot drains that session's staged files and
 * uploads them alongside the reply.
 *
 * Transport-agnostic on purpose: it only knows "a path + a display name, parked
 * under a session key". The session key is whatever both sides agree on; here
 * it's the conversation's pi session-file path, which the tool reads from
 * `ctx.sessionManager.getSessionFile()` and the bot reads from
 * `session.sessionFile` — the same string for the same conversation.
 */

/** A file an integration wants attached to the current reply. */
export interface PendingFile {
  /** Absolute path to the file on the host machine. */
  readonly path: string;
  /** Filename Discord should show; defaults to the basename of `path`. */
  readonly name: string;
}

export class ReplyOutbox {
  /** sessionKey -> files staged during the in-flight turn for that session. */
  private readonly pending = new Map<string, PendingFile[]>();

  /** Queue a file to go out with the current turn's reply for `sessionKey`. */
  stage(sessionKey: string, file: PendingFile): void {
    const bucket = this.pending.get(sessionKey);
    if (bucket) bucket.push(file);
    else this.pending.set(sessionKey, [file]);
  }

  /** Take and clear everything staged for `sessionKey`. Empty array if nothing. */
  drain(sessionKey: string): PendingFile[] {
    const bucket = this.pending.get(sessionKey);
    if (!bucket) return [];
    this.pending.delete(sessionKey);
    return bucket;
  }
}
