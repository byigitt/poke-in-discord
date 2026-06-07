/**
 * The Discord surface: gateway wiring, deciding what to answer, and routing each
 * message through its conversation's serialized session. Keeps the "feels like
 * texting" details (typing indicator, in-character errors, reset) here so the
 * core stays Discord-agnostic.
 */
import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import { type OutboundChannel, extractAssistantText, sendBubbles, sendFiles, toDiscordMessages } from "./delivery.ts";
import type { ConversationSessions } from "../sessions/store.ts";
import { fetchImages, selectImages, type SelectedImage } from "./attachments.ts";
import type { ReplyOutbox } from "../outbox.ts";
import type { ActorRegistry } from "../actor.ts";
import type { ConnectionManager } from "../connections/manager.ts";
import { matchProvider, parseConnectCommand } from "../connections/commands.ts";

/** Typed verbatim by the user to wipe a conversation's memory. */
const RESET_PHRASES = ["reset", "/reset", "new chat", "start over", "forget it", "wipe"] as const;

const TYPING_REFRESH_MS = 8_000;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

export class DiscordBot {
  private readonly client: Client;
  private readonly logger: Logger;
  private botId: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly conversations: ConversationSessions,
    /** Whether the resolved model accepts image input; gates attachment forwarding. */
    private readonly supportsImages: boolean,
    /** Files an integration staged this turn are uploaded after the reply. */
    private readonly outbox: ReplyOutbox,
    /** Account-linking: mints connect URLs and tracks who linked what. */
    private readonly connections: ConnectionManager,
    /** Records who is talking each turn so tools resolve that user's accounts. */
    private readonly actor: ActorRegistry,
    logger: Logger,
  ) {
    this.logger = logger.child("discord");
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // Channel/Message partials are required to receive DMs and uncached messages.
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once(Events.ClientReady, (ready) => {
      this.botId = ready.user.id;
      this.logger.info("connected", { tag: ready.user.tag, id: ready.user.id });
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.onMessage(message);
    });
    this.client.on(Events.Error, (error) => this.logger.error("client error", { error }));
  }

  async start(): Promise<void> {
    await this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /** Decide whether to engage, then strip the address tokens to the real text. */
  private intent(message: Message): { key: string; userId: string; text: string; images: SelectedImage[] } | null {
    if (message.author.bot) return null;
    if (!message.channel.isTextBased()) return null;

    const isDM = !message.inGuild();
    const mentioned = this.botId !== null && message.mentions.users.has(this.botId);

    const shouldRespond = isDM || this.config.respondTo === "all" || mentioned;
    if (!shouldRespond) return null;

    let text = message.content;
    if (this.botId) {
      text = text.replace(new RegExp(`<@!?${this.botId}>`, "g"), " ");
    }
    text = text.trim();

    const images = this.supportsImages
      ? selectImages(message.attachments.values(), {
          maxCount: this.config.maxImagesPerMessage,
          maxBytes: this.config.imageMaxBytes,
        })
      : [];

    // Nothing to go on: a bare ping ("@bot") or empty DM is just "hey"; an
    // unaddressed, content-less channel message is ignored. An image counts as content.
    if (!text && images.length === 0) {
      if (isDM || mentioned) text = "hey";
      else return null;
    }

    return { key: message.channelId, userId: message.author.id, text, images };
  }

  private async onMessage(message: Message): Promise<void> {
    const intent = this.intent(message);
    if (!intent) return;
    const { key, userId, text, images } = intent;
    const channel = message.channel as unknown as OutboundChannel;

    if (RESET_PHRASES.includes(text.toLowerCase() as (typeof RESET_PHRASES)[number])) {
      await this.handleReset(key, channel);
      return;
    }

    // Account linking ("connect google-calendar", "accounts", "disconnect …").
    // Only intercepted when something is actually connectable.
    if (this.connections.hasProviders() && (await this.handleConnections(message, text))) {
      return;
    }

    this.logger.debug("handling message", { key, length: text.length, images: images.length });

    try {
      await this.conversations.run(key, async (session) => {
        // Drop anything a previously-aborted turn left staged, so it can't leak
        // into this reply. Files staged during this turn are sent below.
        if (session.sessionFile) {
          this.outbox.drain(session.sessionFile);
          this.actor.enter(session.sessionFile, userId);
        }
        await channel.sendTyping().catch(() => {});
        const refresh = setInterval(() => void channel.sendTyping().catch(() => {}), TYPING_REFRESH_MS);
        let reply: string;
        try {
          // Fetch inside the lane so the typing indicator covers the download too.
          const attached =
            images.length > 0
              ? await fetchImages(images, {
                  maxBytes: this.config.imageMaxBytes,
                  timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
                  logger: this.logger,
                })
              : [];
          // `text` is only empty for an image-only message; if every image also
          // failed to download, there is nothing to send.
          if (!text && attached.length === 0) {
            this.logger.warn("nothing readable to send", { key, attachments: images.length });
            await channel.send("hmm, I couldn't open that image — mind sending it again?");
            return;
          }
          await session.prompt(text, attached.length > 0 ? { images: attached } : undefined);
          reply = extractAssistantText(session.getLastAssistantMessage());
        } finally {
          clearInterval(refresh);
          if (session.sessionFile) this.actor.leave(session.sessionFile);
        }

        const messages = toDiscordMessages(reply, this.config.maxReplyMessages);
        const files = session.sessionFile ? this.outbox.drain(session.sessionFile) : [];
        if (messages.length === 0 && files.length === 0) {
          this.logger.warn("empty reply from agent", { key });
          return;
        }
        if (messages.length > 0) await sendBubbles(channel, messages, this.logger);
        if (files.length > 0) await sendFiles(channel, files, this.logger);
      });
    } catch (error) {
      this.logger.error("turn failed", { key, error });
      await channel.send("ugh, my brain glitched for a sec. mind trying that again?").catch(() => {});
    }
  }

  private async handleReset(key: string, channel: OutboundChannel): Promise<void> {
    try {
      await this.conversations.reset(key);
      await channel.send("done — clean slate. what's up?");
      this.logger.info("conversation reset", { key });
    } catch (error) {
      this.logger.error("reset failed", { key, error });
      await channel.send("couldn't wipe that just now, try again in a sec").catch(() => {});
    }
  }

  /** Handle account-linking commands. Returns true if it consumed the message. */
  private async handleConnections(message: Message, text: string): Promise<boolean> {
    const command = parseConnectCommand(text);
    if (!command) return false;
    if (command.kind === "list") {
      await this.deliverPrivately(message, this.accountsSummary(message.author.id));
    } else if (command.kind === "connect") {
      await this.startConnect(message, command.app);
    } else {
      await this.endConnect(message, command.app);
    }
    return true;
  }

  private accountsSummary(userId: string): string {
    const linked = this.connections.connections(userId);
    const available = this.connections.catalog().map((c) => c.id);
    return [
      linked.length > 0 ? `connected: ${linked.join(", ")}` : "you haven't connected anything yet.",
      `available: ${available.join(", ")}`,
      "say `connect <name>` to link one, `disconnect <name>` to unlink.",
    ].join("\n");
  }

  private async startConnect(message: Message, appRaw: string | undefined): Promise<void> {
    const app = this.resolveApp(appRaw);
    if (!app) {
      const names = this.connections.catalog().map((c) => `\`${c.id}\``).join(", ");
      await this.deliverPrivately(
        message,
        appRaw ? `I can't connect "${appRaw}". I can connect: ${names}.` : `what should I connect? options: ${names}.`,
      );
      return;
    }
    const url = this.connections.beginConnect(message.author.id, app);
    if (!url) {
      await this.deliverPrivately(message, "that one isn't set up right now.");
      return;
    }
    const label = this.connections.label(app) ?? app;
    await this.deliverPrivately(message, `open this to connect ${label} (expires in ~10 min):\n${url}`);
    this.logger.info("connect started", { app });
  }

  private async endConnect(message: Message, appRaw: string | undefined): Promise<void> {
    const app = this.resolveApp(appRaw);
    if (!app) {
      await this.deliverPrivately(message, appRaw ? `I don't know "${appRaw}".` : "disconnect what? say `disconnect <name>`.");
      return;
    }
    const removed = this.connections.disconnect(message.author.id, app);
    await this.deliverPrivately(
      message,
      removed ? `disconnected ${this.connections.label(app) ?? app}.` : `you didn't have ${app} connected.`,
    );
  }

  /** Map free text ("google calendar") to a known connected-provider id, or null. */
  private resolveApp(raw: string | undefined): string | null {
    return matchProvider(raw, this.connections.catalog().map((c) => c.id));
  }

  /**
   * Send something only the requesting user should see (connect URLs bind to
   * them; in a shared channel, anyone could otherwise click). Always DMs; nudges
   * in-channel when the command came from a server.
   */
  private async deliverPrivately(message: Message, content: string): Promise<void> {
    try {
      await message.author.send(content);
      if (message.inGuild()) {
        await (message.channel as unknown as OutboundChannel).send("📬 sent you a DM").catch(() => {});
      }
    } catch {
      await (message.channel as unknown as OutboundChannel)
        .send("I couldn't DM you — enable DMs from server members so I can send that privately.")
        .catch(() => {});
    }
  }
}
