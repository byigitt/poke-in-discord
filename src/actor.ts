/**
 * Who is talking *right now*, and where. Conversations are keyed by channel (so
 * memory is shared in a channel), but tools often need the specific person and
 * place behind the current turn: account connections are per Discord user, and a
 * reminder must be delivered back to the channel it was set in.
 *
 * The bot records both at the start of each turn (keyed by the session, the same
 * key the outbox uses); tools read them back via the running session. Turns are
 * serialized per channel, so one entry per session key is always the current one.
 */
export interface TurnActor {
  /** Discord user id of whoever sent the message being handled. */
  readonly userId: string;
  /** Discord channel id the turn is running in (where replies/reminders go). */
  readonly channelId: string;
}

export class ActorRegistry {
  private readonly bySession = new Map<string, TurnActor>();

  /** Record who/where is driving the turn for `sessionKey`. */
  enter(sessionKey: string, actor: TurnActor): void {
    this.bySession.set(sessionKey, actor);
  }

  /** The actor whose turn is running on `sessionKey`, or undefined between turns. */
  current(sessionKey: string): TurnActor | undefined {
    return this.bySession.get(sessionKey);
  }

  /** Forget the actor once the turn ends, so it can't leak into the next one. */
  leave(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }
}
