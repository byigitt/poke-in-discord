# poke-in-discord

A [Poke](https://poke.com)-style personal assistant, brought to Discord. It talks
like Poke does on iMessage — witty, warm, terse, human, never a corporate
chatbot — and runs entirely on the **Oh My Pi** agent SDK: it uses pi's own
authentication (no API keys here) and pi's agent/conversation system as the brain.

It can reach your **files**: ask it to find something on the machine it runs on
and send it to you on Discord, and it will. Beyond that it's built to grow —
adding Google Calendar, Gmail, web search, smart-home control, etc. is one small
file plus one line, no changes to the core.

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

## Using it

- **DM the bot** — it always replies.
- **In a server** — it replies when you `@mention` it (set `POKE_RESPOND_TO=all`
  to answer everything in channels it can see).
- **Send a photo** — attach an image (jpeg/png/gif/webp), in a DM or alongside an
  `@mention`, and the bot actually looks at it. Needs a vision-capable model
  (the default Claude models are).
- **Ask for a file** — "find my resume and send it", "what's in notes.txt?",
  "list my Downloads". The bot searches the machine it runs on, reads text files,
  and uploads files straight into the chat. Scope it with `POKE_FILES_ROOT` and
  see the security note below.
- **`reset`** (also `new chat`, `start over`, `forget it`, `wipe`) — clears that
  conversation's memory.

### File access & safety

The file tools are real access to the machine the bot runs on. Everything is
confined to `POKE_FILES_ROOT` (default: your home folder) — paths that try to
escape it, including through symlinks, are refused — and reads/uploads are capped
by `POKE_FILES_MAX_MB`. But within that root the bot can read and send **any**
file to whoever it's chatting with. So keep it in DMs or a private server, point
`POKE_FILES_ROOT` at just the folder you want it to reach, and remember that
anyone it talks to can ask for those files.

## Configuration

All via `.env` (see `.env.example`):

| Var | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | — (required) | Bot token. |
| `POKE_BOT_NAME` | `Poke` | What the assistant calls itself. |
| `POKE_MODEL` | auto | `provider/model-id` (e.g. `anthropic/claude-sonnet-4-5`). Auto-picks a good default from your authenticated models. |
| `POKE_THINKING` | `off` | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`auto`. `off` = snappiest. |
| `POKE_RESPOND_TO` | `mention` | In servers: `mention` or `all`. DMs always answer. |
| `POKE_SESSION_DIR` | `.sessions` | Where chat history is persisted. |
| `POKE_SESSION_IDLE_MINUTES` | `30` | Drop an idle chat from memory (history stays on disk). |
| `POKE_MAX_REPLY_MESSAGES` | `5` | Bubble target for splitting a reply. |
| `POKE_MAX_IMAGE_MB` | `8` | Largest image attachment downloaded and forwarded to a vision model. |
| `POKE_MAX_IMAGES` | `4` | Most images forwarded from a single message. |
| `POKE_FILES_ROOT` | home dir | Folder the file tools may browse, read, and send from. Paths are confined under it. |
| `POKE_FILES_MAX_MB` | `8` | Largest file the bot will read inline or upload to Discord. |
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
   import { type Integration, defineTool } from "../types.ts";

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
             return { content: [{ type: "text", text: "..." }] };
           },
         }),
       ];
     },
   };
   ```

2. Enable it in `src/integrations/index.ts`:

   ```ts
   import { googleCalendar } from "./google-calendar/index.ts";
   export function enabledIntegrations(): Integration[] {
     return [googleCalendar];
   }
   ```

That's it — the persona's capability list, the agent's toolset, and tool-name
collision checks all update automatically. Tool params are authored with Zod v4
(pi accepts it natively); `defineTool` gives you fully-typed `params` in
`execute`. Tools get a `ctx` with the shared pi runtime, config, and a scoped
logger.

## Project layout

```
src/
  config.ts                 env → typed, validated config
  logger.ts                 minimal leveled logger
  outbox.ts                 staged files → uploaded with the next reply
  pi/
    runtime.ts              pi auth + model discovery + model resolution
    persona.ts              the Poke voice (Discord-adapted), capability-injected
  integrations/             core stays flat; each integration gets a folder
    types.ts                Integration / IntegrationContext / defineTool
    registry.ts             integrations → persona capabilities + deduped tools
    index.ts                the enabled set (filesystem on; add more here)
    filesystem/             browse / search / read / send files from the host
      index.ts              the integration
      filesystem.test.ts    its unit tests
    examples/clock.ts       a working integration template
  sessions/
    factory.ts              build/resume/delete a per-conversation pi session
    store.ts                per-conversation serialization lanes + idle eviction
  discord/
    delivery.ts             Poke-style message splitting + file uploads (+ tests)
    attachments.ts          image-attachment selection + fetch (+ unit tests)
    bot.ts                  gateway wiring, gating, typing, reset
  index.ts                  entrypoint
scripts/
  smoke.ts                  optional live end-to-end check (no Discord needed)
```

## Verify

```bash
bun run typecheck
bun test                    # deterministic delivery tests
bun run scripts/smoke.ts    # optional: live check of auth + reply + memory + a tool call
```
