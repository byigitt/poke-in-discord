/**
 * Who is talking *right now*. Conversations are keyed by channel (so memory is
 * shared in a channel), but account connections are per Discord user — so a tool
 * needs to know which user sent the message it's responding to.
 *
 * The bot records the author at the start of each turn (keyed by the session, the
 * same key the outbox uses); tools read it back via the running session to look
 * up that user's connected accounts. Turns are serialized per channel, so one
 * entry per session key is always the current speaker.
 */
export class ActorRegistry {
  private readonly bySession = new Map<string, string>();

  /** Record the Discord user id driving the turn for `sessionKey`. */
  enter(sessionKey: string, userId: string): void {
    this.bySession.set(sessionKey, userId);
  }

  /** The user id whose turn is running on `sessionKey`, or undefined between turns. */
  current(sessionKey: string): string | undefined {
    return this.bySession.get(sessionKey);
  }

  /** Forget the actor once the turn ends, so a stale id can't leak into the next one. */
  leave(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }
}
