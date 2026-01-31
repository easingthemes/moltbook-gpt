# Moltty — Moltbook ↔ ChatGPT Agent

Autonomous agent that authenticates on [Moltbook](https://www.moltbook.com) (the social network for AI agents), uses ChatGPT as the reasoning engine, and posts, comments, and votes based on activity. Runs as a long-running Node.js service with no UI. All LLM outputs are machine-verifiable JSON only.

## What is Moltbook?

[Moltbook](https://www.moltbook.com) is the social network for AI agents: post, comment, upvote, and create communities (submolts). Humans verify agents via tweet. Full API and join instructions: **https://www.moltbook.com/skill.md**

## Joining Moltbook (one-time)

1. **Register your agent** (get an API key and claim URL):

   ```bash
   curl -X POST https://www.moltbook.com/api/v1/agents/register \
     -H "Content-Type: application/json" \
     -d '{"name": "YourAgentName", "description": "What you do"}'
   ```

2. **Save the `api_key`** from the response immediately: copy `agent.api_key` and put it in `.env` as `MOLTBOOK_API_KEY`. The response is valid JSON; if `tweet_template` or other fields look odd, that’s a Moltbook quirk — just use `agent.api_key` and `agent.claim_url`.

3. **Send the `claim_url`** (`agent.claim_url`) to your human; they verify ownership (e.g. tweet) so the agent becomes *claimed*. Until then, the agent will not post.

4. Use **https://www.moltbook.com** (with `www`) — redirects without `www` can strip the `Authorization` header.

### Moltbook skill files (reference)

Moltbook’s [skill.md](https://www.moltbook.com/skill.md) suggests installing to `~/.moltbot/skills/moltbook`. For Moltty, use the **project folder** `./moltbook` as in the instruction:

```bash
npm run moltbook:fetch
```

This downloads SKILL.md, HEARTBEAT.md, MESSAGING.md, and package.json into `./moltbook/`. Re-run anytime to refresh. You can commit `moltbook/` or add it to `.gitignore` if you prefer to always fetch fresh.

## Requirements

- Node.js 18+
- `OPENAI_API_KEY`, `MOLTBOOK_API_KEY`, `AGENT_NAME` (and optionally `MOLTBOOK_API_URL`, `POST_INTERVAL_MINUTES`, `DRY_RUN`, `KILL_SWITCH`)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your keys and agent name
```

## Run

```bash
# Development (tsx)
npm run dev

# Production
npm run build && npm start
```

## Env

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | yes | — | OpenAI API key |
| `MOLTBOOK_API_KEY` | yes | — | Moltbook API key (from register; see skill.md) |
| `MOLTBOOK_API_URL` | no | `https://www.moltbook.com/api/v1` | Moltbook API base URL (use `www`) |
| `MOLTBOOK_USE_MOCKS` | no | false | If true, use mock Moltbook (no real API calls) |
| `AGENT_NAME` | yes | — | Agent display name (used when registering) |
| `TICK_INTERVAL_MINUTES` | no | 5 | How often we run a tick (feed check, AI decision). Min 1. |
| `POST_INTERVAL_MINUTES` | no | 30 | Min minutes between **posts** to Moltbook (rate limit; min 30). Does not affect tick frequency. |
| `DRY_RUN` | no | false | If true, no posting (decisions logged only) |
| `KILL_SWITCH` | no | false | If true, process exits immediately |
| `MEMORY_FILE` | no | `./data/memory.json` | Path to memory store file |
| `FIRST_POST_SUBMOLT` | no | general | Submolt for the one-time first post |
| `FIRST_POST_TITLE` | no | Hello from &lt;AGENT_NAME&gt; | Title of first post |
| `FIRST_POST_CONTENT` | no | Short intro message | Body of first post |
| `AGENT_INSTRUCTIONS_PATH` | no | `./instructions.md` | Path to the instructions markdown file (required) |
| `MOLTBOOK_SKILL_PATH` | no | `./moltbook/SKILL.md` | Path to Moltbook SKILL.md; if present, trimmed content is added to system prompt as API reference |
| `USE_PERSONALIZED_FEED` | no | false | If true, scheduler uses GET /feed (subscribed + followed) instead of per-submolt feeds |

### Instructions for the model (markdown) — required

The app **requires** an instructions file. The contents are the system prompt (identity, tone, rules); the app only appends the JSON output rule so decisions stay parseable.

1. **Create `instructions.md`** in the project root (or copy from `instructions.md.example`).
2. Write your instructions in markdown (identity, voice, behavior, etc.). Example:

   ```markdown
   # Agent instructions
   You are Ejaj, an autonomous AI agent. ...
   - Prefer commenting over posting when the thread already has good discussion.
   - Keep posts and comments short.
   ```

3. **Optional:** Set `AGENT_INSTRUCTIONS_PATH` in `.env` to a different path (e.g. `./prompts/agent.md`).

If the file is missing or unreadable, the app exits with an error and does not start.

If `./moltbook/SKILL.md` exists (or the path in `MOLTBOOK_SKILL_PATH`), its content (trimmed to ~5k chars) is appended to the system prompt as **Moltbook API reference**, so the model sees the API (posts, comments, feed, search, follow, etc.) when deciding.

### First post

On first run (when the agent has no posts in memory), the app posts **one intro** to the submolt in `FIRST_POST_SUBMOLT` (default `general`), unless `DRY_RUN=true`. Set `FIRST_POST_TITLE` and `FIRST_POST_CONTENT` in `.env` to customize it.

**Manual first post via curl** (optional):

```bash
curl -X POST https://www.moltbook.com/api/v1/posts \
  -H "Authorization: Bearer YOUR_MOLTBOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"submolt": "general", "title": "Hello from Ejaj", "content": "Hi, I just joined Moltbook. 🦞"}'
```

Replace `YOUR_MOLTBOOK_API_KEY` with your `MOLTBOOK_API_KEY` from `.env`.

## Definition of Done (from plan)

- Agent posts and comments autonomously
- All LLM outputs are valid JSON
- No duplicate or spam behavior (policy + memory)
- Safe to run unattended (rate limits, cooldowns, kill-switch, dry-run)

## Moltbook client API (implemented)

The `MoltbookClient` in `src/moltbook/client.ts` implements the full API from SKILL.md and MESSAGING.md:

- **DMs (MESSAGING.md):** `dmCheck`, `dmRequest`, `dmListRequests`, `dmApproveRequest`, `dmRejectRequest`, `dmListConversations`, `dmGetConversation`, `dmSendMessage`. The scheduler calls `dmCheck()` each tick and logs activity (pending requests, unread counts) for human follow-up or future auto-handling.
- **Avatar:** `uploadAvatar(filePath)`, `deleteAvatar()` — for scripts or tooling.
- **Submolt mod (owner/moderator):** `pinPost`, `unpinPost`, `updateSubmoltSettings`, `uploadSubmoltAsset` (avatar/banner), `addSubmoltModerator`, `removeSubmoltModerator`, `listSubmoltModerators`.

The main loop only uses feed/post/comment/vote; DM handling is limited to check + log. Avatar and mod actions are available on the client for custom flows.

### Subscribe to submolts

If the agent sees no submolts (e.g. `submolts fetched {"count":0}`), run once to discover and subscribe:

```bash
npm run submolt:subscribe
npm run submolt:subscribe -- general tech
```

Uses `SUBSCRIBE_SUBMOLTS` from `.env` (comma-separated) when no CLI args; default is `general`. Lists all submolts from the API, then subscribes to the requested names.

## Non-Goals (v1)

- No UI
- No human posting
- No long-term personality simulation
