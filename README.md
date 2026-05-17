# 💡 Signal Buffet

**Your opportunity stream — every inbound signal, triaged before you wake up.**

> Welcome to Signal Buffet. Your daily, all-in-one view of signals pulled from
> **Slack, X, Gmail and GitHub**. We automatically categorize each item by
> type and rank it by priority, so your GTM team can spot what matters
> fastest and act on it.

Built for the Notion Developer Platform hackathon — entirely on `ntn workers`,
no external server.

---

## The problem

GTM teams don't lose deals because they're short on leads. They lose them
because high-intent inbound is scattered across Gmail, Slack, X, and GitHub —
and by the time someone notices, the buyer's gone cold.

CRMs assume the data is already structured. **The expensive part is the
triage layer above the CRM**, and nobody owns it.

## What Signal Buffet does

Every hour, Signal Buffet pulls signals from four channels into one Notion
inbox, runs each through a Claude-backed triage step, and surfaces them as a
sales-ready stream.

### 📡 Channels (one-click drill-down)

| Channel | How it gets in | What it's good for |
| :-- | :-- | :-- |
| 📧 **Gmail** | Email webhook → Anthropic triage | Cold inbound, support escalations |
| 💬 **Slack** | `/triage <text>` + right-click → *Triage this message* | Real-time team triage of any channel |
| 🐦 **X** | Scheduled `ntn` sync over saved searches | Brand mentions, competitive signals |
| 💻 **GitHub** | GitHub webhook (issues, stars, forks) | Dev-user signal, paid eval intent |

Each channel card on the Signal Buffet page is a hyperlink to a pre-filtered
saved view of `Opportunities` — one click to focus on a single source.

### 🤖 Custom Notion Agent

Three tools, scoped over the pipeline:

- `queryInbox` — natural-language search over Opportunities
  (`"high-priority partnership leads from Slack this week"`)
- `queryRadar` — search the X market-signals stream
- `promoteSignal` — turn a market signal into an Opportunity row

### ✅ Action List

A pinned section at the top of Signal Buffet, refreshed hourly, telling
sellers what to follow up on today — sourced directly from `Opportunities`
filtered by priority + age.

---

## Live demo

| Time | Demo step |
| :-- | :-- |
| 0:10 | Type `/triage Stripe wants enterprise demo for fraud team` in Slack → new Opportunity in Notion within 2 seconds, auto-tagged `enterprise-demo / high / AE — Mid-Market` |
| 0:25 | Right-click a teammate's message → *Triage this message* → new row, original author preserved |
| 0:40 | Click the Gmail channel card on Signal Buffet → jumps to the Gmail-only view |
| 0:50 | Ask the agent *"what's the highest-priority partnership lead this week?"* — answers with citation |

---

## Architecture

```
                    ┌─ Gmail Webhook      ──┐
                    ├─ GitHub Webhook     ──┤      ┌──────────────┐
                    ├─ Slack Webhook      ──┼──▶   │   triage.ts  │
                    └─ X Scheduled Sync   ──┘      │  (Claude SDK)│
                                                   └──────┬───────┘
                                                          │
                                                          ▼
                                          ┌────────────────────────────────┐
                                          │   Opportunities (Notion DB)    │
                                          │   Title · Source · Type ·      │
                                          │   Priority · Owner · Motion    │
                                          └────────┬───────────────────────┘
                                                   │
                                ┌──────────────────┼──────────────────┐
                                ▼                  ▼                  ▼
                       ┌───────────────┐  ┌────────────────┐  ┌───────────────┐
                       │ Channel cards │  │  Action List   │  │ Custom Agent  │
                       │ (filtered     │  │  (hourly       │  │ (queryInbox / │
                       │  saved views) │  │   refresh)     │  │  queryRadar / │
                       │               │  │                │  │  promoteSignal)│
                       └───────────────┘  └────────────────┘  └───────────────┘
```

### Why this is interesting technically

- **Real-time + batch in the same database.** Slack and GitHub stream in over
  webhooks; Gmail and X are pulled on schedule. All four converge on one
  `Opportunities` data source with a unified schema — same row shape, same
  triage step, same downstream views.
- **Async-202 webhooks done right.** Notion's webhook runtime acknowledges
  with 202 immediately. We use Slack's `response_url` to send the ephemeral
  ack back to the user while the worker keeps running, so a slash command
  feels instant but the actual write happens asynchronously.
- **Same URL, two payload shapes.** The Slack webhook handles both
  `application/x-www-form-urlencoded` slash commands and the
  `payload=<json>` Interactive Components POST that message-action shortcuts
  use — one route, two parsers.
- **Triage is AI-driven, not keyword-matched.** `src/triage.ts` calls Claude
  via the Anthropic SDK with a tool-shaped schema (`report_triage`), so the
  classification is structured JSON straight out of the model.
- **Notion is both the storage and the UI.** No separate dashboard. Rollups
  and saved views are configured on the database itself; the workspace home
  page is just blocks that link into those views.

---

## Repo layout

```
.
├── src/                       # Main worker (Gmail, GitHub, X, Custom Agent)
│   ├── index.ts               # Worker capabilities (webhooks, syncs, tools)
│   ├── triage.ts              # Claude-driven classification
│   ├── notion.ts              # Write to Opportunities database
│   ├── radar.ts               # X market-signals sync target
│   ├── github.ts              # GitHub event normalization + signature verify
│   ├── x.ts                   # X/Twitter search + parse
│   ├── tools.ts               # Custom Agent tools (queryInbox / queryRadar / promoteSignal)
│   ├── handler/email.ts       # Gmail webhook handler
│   └── webhooks/              # Webhook plumbing
│
├── slack-worker/              # Slack /triage + message-action worker
│   └── src/index.ts           # Slack signature verify → Opportunities write
│
├── slack/                     # Legacy Node/Bolt prototype (kept for reference)
└── test/                      # End-to-end test scripts
```

## Tech stack

- **Notion Workers** (`@notionhq/workers`) — entire runtime hosted on Notion
- **Notion API** (`@notionhq/client`) — `context.notion` writes
- **Anthropic SDK** (`@anthropic-ai/sdk`) — Claude-driven triage
- **TypeScript** strict mode, Node 22+
- **`ntn` CLI** for deploy / logs / sync state

## Quickstart

```bash
# Install Notion CLI
curl -fsSL https://ntn.dev | bash

# Auth + deploy the main worker
ntn login
ntn workers deploy

# Auth + deploy the Slack triage worker
cd slack-worker
cp .env.example .env  # then fill in SLACK_SIGNING_SECRET, NOTION_API_TOKEN, OPPORTUNITIES_DATABASE_ID
ntn workers env push
ntn workers deploy
ntn workers webhooks list   # grab the Slack /triage URL
```

Point your Slack app's **Slash Commands → `/triage`** and
**Interactivity & Shortcuts → Request URL** at the webhook URL printed by
`ntn workers webhooks list`. Add a message shortcut with callback ID
`triage_message`. Done.

## Judging notes

| Criterion | Where it shows up |
| :-- | :-- |
| **Technical demo (35%)** | Live slash-command → 2-second Notion write; right-click shortcut; agent query — all in 60 sec |
| **Implementation difficulty (25%)** | 4 inbound channels, two webhook payload shapes, AI-driven triage, Custom Agent — not prompt-stitching |
| **Creativity (25%)** | Slack message shortcut as primary trigger; Notion as storage + UI; real-time + batch in one DB; agent grounded in typed columns |
| **Impact potential (15%)** | Multi-channel inbound is universal GTM pain — deployable to any Notion workspace in ten minutes |

## Team

Built during the Notion Developer Platform hackathon by
[@icecreamlun](https://github.com/icecreamlun) and Georgia Lyu.
