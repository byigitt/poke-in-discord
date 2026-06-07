/**
 * The built-in MCP catalog — the popular apps a Poke-style assistant integrates
 * with (GitHub, Notion, Linear, …), shipped in the box so they're available out
 * of the gate instead of making every operator hand-write a `.mcp.json`. Same
 * philosophy as the rest of the bot: an app loads ONLY when its credential is
 * present in the environment, so an unconfigured app simply isn't there — no
 * half-wired tools, no capability the bot can't honor.
 *
 * Each entry is pure data: where the server lives, which env var(s) hold its
 * token, and how that token authenticates — a `Authorization: Bearer <token>`
 * header for the remote HTTP servers, or the child's own env var for the stdio
 * ones. `selectBuiltinServers` turns the catalog + env into ready-to-connect MCP
 * configs; `builtin.ts` dials them through the same pi MCP machinery `bridge.ts`
 * uses for the long tail. Anything not curated here can still come in via a
 * `.mcp.json`.
 */
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp";

/** How a built-in server is reached, and how its env token gets attached. */
export type BuiltinTransport =
  | {
      /** Remote Streamable-HTTP server; the token rides as `Authorization: Bearer <token>`. */
      readonly type: "http";
      readonly url: string;
    }
  | {
      /** Locally-spawned stdio server; the token is handed to the child as `env[tokenVar]`. */
      readonly type: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      /** Env var name the child process reads its token from. */
      readonly tokenVar: string;
    };

/** One curated MCP app: identity, persona line, where its credential lives, and how to reach it. */
export interface BuiltinMcpServer {
  /** Server id — also the MCP server name and the `mcp__<name>_…` tool prefix (e.g. "github"). */
  readonly name: string;
  /** Human label for logs and `.env` docs (e.g. "GitHub"). */
  readonly label: string;
  /**
   * One human line describing what this unlocks, written for the user (e.g.
   * "Manage the user's Linear issues"). Injected verbatim into the persona's
   * capability list — exactly like an Integration's `capability` — so the
   * assistant truthfully advertises it once it's connected.
   */
  readonly capability: string;
  /**
   * Env var(s) that supply this server's credential, in priority order. The
   * server loads only when the first present one has a non-blank value, and that
   * value is the token. The catalog uses one intentional, bot-scoped name per app
   * (`<APP>_MCP_TOKEN`) so a stray `GITHUB_TOKEN`/`STRIPE_SECRET_KEY` in the host
   * environment never silently exposes tools; the array stays open for aliases.
   */
  readonly tokenEnv: readonly string[];
  /**
   * The knowledge-bank entry: how an operator turns this app on. Surfaced to the
   * assistant (via {@link builtinSetupGuide}) so that when someone asks for an app
   * whose credential isn't set, the bot can recognize it and walk them through
   * enabling it instead of just refusing — the whole point of shipping these.
   */
  readonly setup: {
    /** What credential to create and where, e.g. "a GitHub personal access token (github.com/settings/tokens)". */
    readonly credential: string;
    /** Optional caveat worth telling the user, e.g. "needs npx/Node on the host". */
    readonly note?: string;
  };
  readonly transport: BuiltinTransport;
}

/** The configured token (first non-blank `tokenEnv`) for a server, or null when none is set. */
export function builtinToken(server: BuiltinMcpServer, env: Record<string, string | undefined>): string | null {
  for (const name of server.tokenEnv) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Render the one-line "how to turn this on" guide the assistant uses when a user
 * wants an app whose credential isn't set. Fact-dense on purpose — the model
 * rephrases it in character, so accuracy (exact env var, where to get the
 * credential, the restart) matters more than prose.
 */
export function builtinSetupGuide(server: BuiltinMcpServer): string {
  const envVar = server.tokenEnv[0] ?? "its token variable";
  const note = server.setup.note ? ` (${server.setup.note})` : "";
  return `${server.capability}. Not set up yet — create ${server.setup.credential}, put it in ${envVar} in the bot's .env, and restart.${note}`;
}

/** Catalog apps with no credential configured — the ones the bot can offer to help set up. */
export function dormantBuiltins(
  catalog: readonly BuiltinMcpServer[],
  env: Record<string, string | undefined>,
): BuiltinMcpServer[] {
  return catalog.filter((server) => builtinToken(server, env) === null);
}

/** Turn a built-in server + its resolved token into a connect-ready MCP config. */
export function toServerConfig(server: BuiltinMcpServer, token: string): MCPServerConfig {
  const { transport } = server;
  if (transport.type === "http") {
    return { type: "http", url: transport.url, headers: { Authorization: `Bearer ${token}` } };
  }
  return {
    command: transport.command,
    args: [...transport.args],
    env: { [transport.tokenVar]: token },
  };
}

/** A configured built-in server, ready to hand to the MCP manager. */
export interface SelectedBuiltinServer {
  readonly name: string;
  readonly label: string;
  readonly capability: string;
  readonly config: MCPServerConfig;
}

/** One built-in app left off, and the env var names that would turn it on. */
export interface SkippedBuiltinServer {
  readonly name: string;
  readonly tokenEnv: readonly string[];
}

export interface BuiltinSelection {
  /** Servers whose credential is present, with their connect-ready configs. */
  readonly enabled: SelectedBuiltinServer[];
  /** Servers left off for lack of a credential. */
  readonly skipped: SkippedBuiltinServer[];
}

/** Split the catalog into configured (with configs) vs not (with the env vars that would enable them). */
export function selectBuiltinServers(
  catalog: readonly BuiltinMcpServer[],
  env: Record<string, string | undefined>,
): BuiltinSelection {
  const enabled: SelectedBuiltinServer[] = [];
  const skipped: SkippedBuiltinServer[] = [];
  for (const server of catalog) {
    const token = builtinToken(server, env);
    if (token) {
      enabled.push({
        name: server.name,
        label: server.label,
        capability: server.capability,
        config: toServerConfig(server, token),
      });
    } else {
      skipped.push({ name: server.name, tokenEnv: server.tokenEnv });
    }
  }
  return { enabled, skipped };
}

/**
 * The curated set of built-in MCP apps. Endpoints and token auth verified against
 * each provider's official MCP docs (2026-06): GitHub, Linear, Stripe, and
 * Hugging Face expose remote HTTP servers that accept a bearer token / API key;
 * Notion's remote server is OAuth-only, so its official token-auth path is the
 * `@notionhq/notion-mcp-server` stdio server (needs `npx`/Node on the host).
 *
 * Canva's remote server takes a bearer token too, but that token is a short-lived
 * OAuth access token (it has no long-lived API keys), so `CANVA_MCP_TOKEN` only
 * works while fresh — see `.env.example`.
 */
export const BUILTIN_MCP_SERVERS: readonly BuiltinMcpServer[] = [
  {
    name: "github",
    label: "GitHub",
    capability: "Work with the user's GitHub — search code, manage issues and pull requests, read repos",
    tokenEnv: ["GITHUB_MCP_TOKEN"],
    setup: {
      credential: "a GitHub personal access token (github.com → Settings → Developer settings → Personal access tokens)",
    },
    transport: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
  },
  {
    name: "notion",
    label: "Notion",
    capability: "Search and edit the user's Notion pages and databases",
    tokenEnv: ["NOTION_MCP_TOKEN"],
    setup: {
      credential:
        "a Notion internal integration token at notion.so/my-integrations, then share the pages/databases you want it to reach with that integration",
      note: "needs npx/Node available on the host",
    },
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      tokenVar: "NOTION_TOKEN",
    },
  },
  {
    name: "linear",
    label: "Linear",
    capability: "Track the user's Linear issues, projects, and cycles",
    tokenEnv: ["LINEAR_MCP_TOKEN"],
    setup: {
      credential: "a Linear personal API key (Linear → Settings → Security & access → API keys)",
    },
    transport: { type: "http", url: "https://mcp.linear.app/mcp" },
  },
  {
    name: "stripe",
    label: "Stripe",
    capability: "Look up Stripe payments, customers, and subscriptions",
    tokenEnv: ["STRIPE_MCP_TOKEN"],
    setup: {
      credential: "a Stripe restricted API key at dashboard.stripe.com/apikeys, scoped to only what the bot may touch",
    },
    transport: { type: "http", url: "https://mcp.stripe.com" },
  },
  {
    name: "canva",
    label: "Canva",
    capability: "Create and browse the user's Canva designs",
    tokenEnv: ["CANVA_MCP_TOKEN"],
    setup: {
      credential: "a Canva access token (see canva.dev/docs/connect)",
      note: "Canva has no long-lived keys, so the token expires after ~4h and must be refreshed",
    },
    transport: { type: "http", url: "https://mcp.canva.com/mcp" },
  },
  {
    name: "huggingface",
    label: "Hugging Face",
    capability: "Explore Hugging Face models, datasets, and Spaces",
    tokenEnv: ["HUGGINGFACE_MCP_TOKEN"],
    setup: {
      credential: "a Hugging Face access token at huggingface.co/settings/tokens",
    },
    transport: { type: "http", url: "https://huggingface.co/mcp" },
  },
];
