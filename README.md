# poke-in-discord

A [Poke](https://poke.com)-style personal assistant, brought to Discord. It talks
like Poke does on iMessage — witty, warm, terse, human, never a corporate
chatbot — and runs entirely on the **Oh My Pi** agent SDK: it uses pi's own
authentication (no API keys here) and pi's agent/conversation system as the brain.

It's meant to be **self-hosted and personal**: you run your own copy on your own
machine, with your own Discord bot and your own accounts — not one shared bot that
everyone joins. Because it runs as you (your files, your shared app credentials),
lock it to yourself with `POKE_OWNER_ID` so it answers only you. See
[Make it yours](#make-it-yours).

It can reach your **files** (find something on the machine it runs on and send it
to you on Discord), **search the web**, and **remind you** later — nudging you in
its own voice when the time comes — all through pi with no extra keys. It also
connects to your **accounts**: Google Calendar and Gmail (users link their own
with `connect`), plus the popular apps built right in over MCP — **GitHub,
Notion, Linear, Stripe, Canva, Hugging Face** — the same kinds of apps Poke
integrates with. Each app loads only when its credential is configured, so the
bot never offers something it can't actually do — and anything else with an MCP
server can still be dropped in. Don't know how to wire one up? Just ask: if you
want an app that isn't set up yet, the bot recognizes it and walks you through
turning it on (where to get the credential, which variable to set, the restart),
so you don't need to read any of this first.

And if you explicitly turn it on, it can **run shell commands** on that machine —
the OpenClaw-style "actually do things on my computer" move (off by default).

## How it works

```
Discord message ─▶ DiscordBot ─▶ ConversationSessions ─▶ pi AgentSession
   (DM / @mention)   gating,        one serialized,         persona = Poke voice
                     typing,        persistent session       auth   = pi credentials
                     reset          per conversation         tools  = your integrations
                        ▲                                          │
                        └──────── Poke-style bubbles ◀─────────────┘
```

- **Auth is pi's.** `discoverAuthStorage()` + `ModelRegistry` resolve your
  existing pi/omp credentials (local vault or remote auth-broker). The bot never
  sees or stores provider API keys.
- **The brain is pi's.** Each conversation is a `createAgentSession()` whose
  system prompt is fully replaced with the Poke persona.
- **Memory is real.** Every Discord conversation maps to its own session file
  under `.sessions/`, so the bot remembers a chat across restarts and idle
  eviction. Say `reset` to wipe one.

## Prerequisites

1. **Bun** ≥ 1.3.14.
2. **pi credentials.** Be logged in so pi has at least one authenticated model,
   e.g. `omp auth-broker login anthropic` (or your normal omp/pi login). Verify
   with the optional smoke test below.
3. **A Discord bot.** Create an app at the
   [Discord Developer Portal](https://discord.com/developers/applications), add a
   Bot, copy its token, and **enable the "Message Content Intent"** toggle.
   Invite it to a server with the `bot` scope and "Send Messages" permission, or
   just DM it.

## Setup

```bash
bun install
cp .env.example .env      # then paste your DISCORD_TOKEN
bun start                 # or: bun dev  (watch mode)
```

## Make it yours

This is **your** bot on **your** machine. It runs as you — it can reach your files,
your reminders, and the app accounts you wire up (your GitHub token, your Gmail,
etc.) — so by default you don't want strangers talking to it.

Lock it to yourself in two minutes:

1. Start the bot and DM it **`whoami`** — it replies with your Discord user ID.
   (Or turn on Discord **Developer Mode** → right-click yourself → **Copy User ID**.)
2. Put that ID in `.env` as `POKE_OWNER_ID=<your-id>` and restart.
3. Now the bot ignores everyone except you. Add a few trusted IDs comma-separated
   (`POKE_OWNER_ID=111,222`) if you want to share it with specific people.

Leave `POKE_OWNER_ID` unset only on a machine and chat you fully control — the bot
logs a loud warning at startup when it's open to anyone who can reach it.

Other touches: set `POKE_BOT_NAME` to whatever you want it to call itself, and
`POKE_FILES_ROOT` to just the folder it may read from.

## Using it

- **DM the bot** — it always replies (to you; see [Make it yours](#make-it-yours)).
- **In a server** — it replies when you `@mention` it (set `POKE_RESPOND_TO=all`
  to answer everything in channels it can see). With `POKE_OWNER_ID` set it only
  ever answers you, mention or not.
- **`whoami`** — DM it `whoami` and it tells you your Discord user ID, ready to
  drop into `POKE_OWNER_ID`.
- **Send a photo** — attach an image (jpeg/png/gif/webp), in a DM or alongside an
  `@mention`, and the bot actually looks at it. Needs a vision-capable model
  (the default Claude models are).
- **Ask for a file** — "find my resume and send it", "what's in notes.txt?",
  "list my Downloads", "save these notes to ideas.md". The bot searches the
  machine it runs on, reads text files, writes/appends files, and uploads files
  straight into the chat. Scope it with `POKE_FILES_ROOT` and see the note below.
- **Ask it to look something up** — "what's the weather in Istanbul?", "search
  the news on X", "who won last night's game?". It searches the web through pi's
  own providers (whatever your pi login unlocks — Anthropic, OpenAI, …), so no
  separate search key is needed.
- **Connect your accounts** — `connect google-calendar`, `connect gmail`, or just
  `accounts` to see what's available. The bot DMs you a consent link; authorize
  once and it can check your calendar, draft and send mail, and so on.
  `disconnect <app>` unlinks.
- **Set a reminder** — one-off ("remind me to call mom in 20 minutes", "tomorrow
  at 9 ship the build") or recurring ("every weekday at 9 remind me to check
  standup", "every morning at 8 take my meds"). It nudges you in its own voice
  when it's due, recurring ones repeat on schedule, and they survive restarts.
  Ask what's pending or to cancel one too.
- **Run a command** (opt-in) — with `POKE_SHELL_ENABLED` set, it can actually do
  things on the box: "run git status", "what's using port 3000", "convert this
  with ffmpeg". Off by default; see the safety note.
- **`reset`** (also `new chat`, `start over`, `forget it`, `wipe`) — clears that
  conversation's memory.

### File access & safety

The file tools are real access to the machine the bot runs on. Everything is
confined to `POKE_FILES_ROOT` (default: your home folder) — paths that try to
escape it, including through symlinks, are refused — and reads/uploads are capped
by `POKE_FILES_MAX_MB`. But within that root the bot can read, **write**, and send
any file to whoever it's chatting with — which is exactly why you set
`POKE_OWNER_ID` so that "whoever" is just you. Point `POKE_FILES_ROOT` at only the
folder it should reach, and if you do leave the bot open, remember anyone it talks
to can ask for those files.

The **shell** integration goes further: with `POKE_SHELL_ENABLED` it runs
arbitrary commands as your user — that's the point, and exactly why it's off
unless you set that flag. Commands run in `POKE_SHELL_CWD`, are killed after
`POKE_SHELL_TIMEOUT_SECONDS`, and output is capped. Only enable it on a machine
and in a chat you trust.

### Connecting accounts (Google, MCP, …)

App integrations are **env-gated**: one only loads when its credentials are
present, so the bot never offers something it can't actually do. Once an app is
configured, you link your account from chat — the bot DMs a consent link, a small
local server catches the OAuth redirect, and the token is stored and refreshed
automatically. (Linking is per Discord user, so if you've shared the bot via
`POKE_OWNER_ID`, each person links their own.)

**Google (Calendar + Gmail).** Create an OAuth client at the
[Google Cloud Console](https://console.cloud.google.com) (Web application),
enable the Calendar and Gmail APIs, add `<POKE_OAUTH_REDIRECT_BASE>/oauth/callback`
as an authorized redirect URI, and set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
in `.env`. Then, in chat: `connect google-calendar` or `connect gmail`.

**Built-in apps (MCP, in the box).** The popular apps are wired in already — no
`.mcp.json` needed. Each connects only when you set its credential in `.env`, and
then its tools are live in your chats (these run on one shared token, so anyone
you've let in via `POKE_OWNER_ID` uses your account for them):

| App | Credential | How to get it |
| --- | --- | --- |
| GitHub | `GITHUB_MCP_TOKEN` | A Personal Access Token (github.com → Developer settings). |
| Notion | `NOTION_MCP_TOKEN` | An internal integration token (`ntn_…`); share the pages with it. Needs `npx`/Node on the host. |
| Linear | `LINEAR_MCP_TOKEN` | A personal API key (Linear → Settings → API keys). |
| Stripe | `STRIPE_MCP_TOKEN` | A restricted API key (`rk_…`), scoped to what the bot may touch. |
| Canva | `CANVA_MCP_TOKEN` | An OAuth access token — short-lived (~4h), so only useful while fresh (Canva's MCP has no long-lived keys). |
| Hugging Face | `HUGGINGFACE_MCP_TOKEN` | A user access token (`hf_…`). |

These run on a single credential you provide, so they act as your account — which
is the other reason to keep the bot locked to you with `POKE_OWNER_ID`. The names
are deliberately bot-scoped (`*_MCP_TOKEN`), not the providers' usual env vars, so
a stray `GITHUB_TOKEN` or `STRIPE_SECRET_KEY` in your shell never quietly switches
an app on.

Each built-in app also carries a short "how to turn it on" note (its `setup` field),
which the bot keeps as a knowledge bank: ask for an app whose credential isn't set
and it walks you through enabling it in chat instead of refusing. So you can install
the project, message it "can you do GitHub stuff?", and let it guide you from there.

**Everything else (the long tail).** Anything not built in can still come in via
MCP: drop a `.mcp.json` next to the bot (even `{}` works); pi then loads servers
from it **and** your global MCP config — the same `~/.claude.json` / marketplace
servers your other tools already use (Sentry, context7, …) come along for free.
No `.mcp.json`, no extra MCP. Verify yours with `bun run scripts/mcp-check.ts`.

Connect links bind to the requesting user, so the bot always sends them by DM.

## Configuration

All via `.env` (see `.env.example`):

| Var | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | — (required) | Bot token. |
| `POKE_BOT_NAME` | `Poke` | What the assistant calls itself. |
| `POKE_MODEL` | auto | `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5`). Auto-picks a good default from your authenticated models. |
| `POKE_THINKING` | `off` | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`auto`. `off` = snappiest. |
| `POKE_RESPOND_TO` | `mention` | In servers: `mention` or `all`. DMs always answer. |
| `POKE_OWNER_ID` | unset (open) | Discord user ID(s) allowed to use the bot, comma-separated. Unset ⇒ anyone who can reach it (warns at startup). DM `whoami` to get yours. |
| `POKE_SESSION_DIR` | `.sessions` | Where chat history is persisted. |
| `POKE_SESSION_IDLE_MINUTES` | `30` | Drop an idle chat from memory (history stays on disk). |
| `POKE_MAX_REPLY_MESSAGES` | `5` | Bubble target for splitting a reply. |
| `POKE_MAX_IMAGE_MB` | `8` | Largest image attachment downloaded and forwarded to a vision model. |
| `POKE_MAX_IMAGES` | `4` | Most images forwarded from a single message. |
| `POKE_FILES_ROOT` | home dir | Folder the file tools may browse, read, and send from. Paths are confined under it. |
| `POKE_FILES_MAX_MB` | `8` | Largest file the bot will read inline or upload to Discord. |
| `POKE_SHELL_ENABLED` | unset (off) | Set to anything to enable the shell integration (`run_command`). |
| `POKE_SHELL_CWD` | = `POKE_FILES_ROOT` | Working directory shell commands run in. |
| `POKE_SHELL_TIMEOUT_SECONDS` | `30` | A shell command is killed after this long. |
| `POKE_OAUTH_PORT` | `8787` | Port for the local OAuth callback server (account connect). |
| `POKE_OAUTH_REDIRECT_BASE` | `http://localhost:<port>` | Public base URL providers redirect back to; must match your registered redirect URI. |
| `POKE_CONNECTIONS_FILE` | `<session dir>/connections.db` | SQLite file of per-user linked-account tokens. |
| `POKE_REMINDERS_FILE` | `<session dir>/reminders.db` | SQLite file of scheduled reminders. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth client; set both to enable Google Calendar + Gmail. |
| `GITHUB_MCP_TOKEN` | — | GitHub PAT; enables the built-in GitHub app. |
| `NOTION_MCP_TOKEN` | — | Notion integration token; enables the built-in Notion app (needs `npx`/Node). |
| `LINEAR_MCP_TOKEN` | — | Linear API key; enables the built-in Linear app. |
| `STRIPE_MCP_TOKEN` | — | Stripe restricted key (`rk_…`); enables the built-in Stripe app. |
| `CANVA_MCP_TOKEN` | — | Canva OAuth access token (short-lived); enables the built-in Canva app. |
| `HUGGINGFACE_MCP_TOKEN` | — | Hugging Face access token; enables the built-in Hugging Face app. |
| `POKE_AGENT_DIR` | `~/.omp/agent` | Override pi's credential/model dir. |

## Extending it (the whole point)

Capability is packaged as an **Integration**: a name, an optional one-line
description that flows into the persona, and some model-callable tools. The
moment you enable one, the assistant truthfully advertises it and can call it.

1. Write an integration in its own folder — `src/integrations/<name>/index.ts`.
   One folder per integration keeps `integrations/` tidy as the set grows, and
   gives each one room for its own helpers and tests. Copy the working
   `src/integrations/filesystem/` or the `examples/clock.ts` template:

   ```ts
   import { z } from "zod/v4";
   import { type Integration, defineTool, toolText } from "../types.ts";

   export const googleCalendar: Integration = {
     name: "google-calendar",
     capability: "Check and create events on your Google Calendar",
     tools(ctx) {
       return [
         defineTool({
           name: "list_events",
           label: "List calendar events",
           description: "List upcoming Google Calendar events.",
           parameters: z.object({ days: z.number().int().min(1).max(30).default(7) }),
           async execute(_id, params) {
             // ...call the Google API...
             return toolText("...");
           },
         }),
       ];
     },
   };
   ```

2. Add it to the catalog in `src/integrations/index.ts`:

   ```ts
   import { googleCalendar } from "./google-calendar/index.ts";
   export const ALL_INTEGRATIONS: readonly Integration[] = [
     filesystemIntegration,
     webSearchIntegration,
     googleCalendar,
   ];
   ```

That's it — the persona's capability list, the agent's toolset, and tool-name
collision checks all update automatically. Tool params are authored with Zod v4
(pi accepts it natively); `defineTool` gives you fully-typed `params` in
`execute`. Tools get a `ctx` with the shared pi runtime, config, and a scoped
logger.

**Gating & connections.** An integration declares what it needs and the loader
enables it only when that's satisfied: `requires: ["SOME_API_KEY"]` for a plain
key, or a `connection` for OAuth apps (Google Calendar/Gmail show the pattern). A
`connection` both gates the integration on its client env and registers it for
`connect <provider>`; tools then call `currentToken(ctx, toolCtx, provider)` to
get the current user's token. No connect-flow plumbing leaks into the integration.
For a popular app you'd rather ship in the box, add a built-in MCP entry instead
of hand-writing tools: append it to `BUILTIN_MCP_SERVERS` in `src/mcp/catalog.ts`
(name, capability line, its token env var, and the HTTP/stdio transport) and it
loads whenever that credential is set. Give it a `setup` (where to get the
credential, plus any caveat) so the bot can guide users to turn it on when it's
off — that's the knowledge bank. OAuth integrations get the same by declaring a
`setup` alongside their `connection`. Anything more bespoke can still come in
through a `.mcp.json`.

**Conventions.** Tool results use the shared `toolText` / `toolError` helpers — no
per-integration reply boilerplate. Each module has a colocated `*.test.ts` named
after it, and tests share stubs from `src/test-support.ts` (`silentLogger`,
`textOf`, `fakeIntegrationContext`, `fakeToolContext`). Run `bun run check`
(typecheck + tests) before you ship.

## Project layout

```
src/
  config.ts                 env → typed, validated config
  logger.ts                 minimal leveled logger
  outbox.ts                 staged files → uploaded with the next reply
  actor.ts                  the current speaker + channel each turn (connections, reminders)
  test-support.ts           shared test stubs: silentLogger, textOf, fakes (not shipped)
  connections/              account-linking framework
    oauth.ts                OAuth 2.0 + PKCE helpers, ConnectionSpec, resolveProvider
    store.ts                per-user token store (SQLite)
    manager.ts              providers, in-flight connects, token refresh
    server.ts               OAuth callback HTTP server
    commands.ts             connect / disconnect / accounts parsing
  mcp/
    catalog.ts              built-in MCP apps (GitHub, Notion, Linear, …) + env-gated selection
    builtin.ts              connect the configured built-in apps → tools + capabilities
    bridge.ts               long-tail MCP: discover servers (.mcp.json + global config) → tools
  reminders/
    store.ts                scheduled reminders (SQLite, survives restarts)
    scheduler.ts            polls + fires due reminders (offline catch-up, fire-once)
    cron.ts                 tiny cron evaluator for recurring reminders
  pi/
    runtime.ts              pi auth + model discovery + model resolution
    persona.ts              Poke's own system prompt, Discord-adapted + capability-injected
  integrations/             core stays flat; each integration gets a folder
    types.ts                Integration / IntegrationContext / defineTool + toolText/toolError
    registry.ts             integrations → persona capabilities + deduped tools
    index.ts                the catalog (ALL_INTEGRATIONS)
    select.ts               env-gated selection (selectConfigured)
    filesystem/             browse / search / read / write / send files on the host
      index.ts              the integration
      filesystem.test.ts    its unit tests
    web-search/             search the web via pi's own providers (no extra key)
      index.ts              the integration
    reminders/              set / list / cancel; the bot nudges you when due
      index.ts              the integration
    shell/                  run_command — run shell commands (opt-in via env)
      index.ts              the integration
    google/                 shared Google OAuth + API helpers (Calendar, Gmail)
    google-calendar/        list / quick-add / create events (connect google-calendar)
    gmail/                  search / read / send mail (connect gmail)
    examples/clock.ts       a working integration template
  sessions/
    factory.ts              build/resume a session; registers MCP tools via refreshMCPTools
    store.ts                per-conversation serialization lanes + idle eviction
  discord/
    delivery.ts             Poke-style message splitting + file uploads (+ tests)
    attachments.ts          image-attachment selection + fetch (+ unit tests)
    bot.ts                  gateway wiring, gating, typing, reset, reminder delivery
  index.ts                  entrypoint (wires integrations, connections, MCP, bot)
scripts/
  smoke.ts                  optional live end-to-end check (no Discord needed)
  mcp-check.ts              optional live MCP check (needs MCP configured)
```

## Verify

```bash
bun run check    # typecheck + all tests, one command
bun test         # just the deterministic tests
bun run smoke    # optional: live check of auth + reply + memory + tools (needs pi login)
bun run mcp:check # optional: live MCP check (loads servers + proves the agent can call them)
```
