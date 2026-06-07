/**
 * The tiny HTTP server that catches the OAuth redirect. The provider sends the
 * user's browser to `${redirectBase}/oauth/callback?code&state`; we hand that to
 * the ConnectionManager, store the tokens, and show a "you're connected, go back
 * to Discord" page. Started only when at least one OAuth integration is enabled.
 */
import type { Server } from "bun";
import type { Logger } from "../logger.ts";
import type { ConnectionManager } from "./manager.ts";

const CALLBACK_PATH = "/oauth/callback";

export class OAuthCallbackServer {
  private server: Server<undefined> | null = null;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly listenPort: number,
    private readonly logger: Logger,
  ) {}

  /** Begin listening. Logs and degrades (connect won't work) if the port is taken. */
  start(): void {
    try {
      this.server = Bun.serve({ port: this.listenPort, fetch: (req) => this.handle(req) });
      this.logger.info("oauth callback server listening", { port: this.port, path: CALLBACK_PATH });
    } catch (error) {
      this.logger.error("oauth callback server failed to start; account connect disabled", {
        port: this.listenPort,
        error,
      });
    }
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** The port actually bound (useful when started on port 0). */
  get port(): number | undefined {
    return this.server?.port;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== CALLBACK_PATH) return new Response("ok", { status: 200 });

    const denied = url.searchParams.get("error");
    if (denied) return this.page("Connection canceled", `Access wasn't granted (${denied}). Nothing was linked.`);

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return this.page("Invalid request", "That callback was missing its code or state.", 400);

    try {
      const result = await this.manager.completeConnect(state, code);
      if (!result) {
        return this.page("Link expired", "This connect link expired or was already used — start again from Discord.", 400);
      }
      return this.page(`${result.label} connected`, "You're all set. Head back to Discord and keep chatting.");
    } catch (error) {
      this.logger.error("oauth callback failed", { error });
      return this.page("Something went wrong", "Couldn't finish connecting. Try again from Discord.", 500);
    }
  }

  private page(title: string, body: string, status = 200): Response {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0b0b0f;color:#e7e7ea;display:grid;place-items:center;height:100vh;margin:0}main{max-width:28rem;text-align:center;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#a0a0a8;line-height:1.5}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
    return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  }
}
