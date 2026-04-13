# Factory Agent

Autonomous Linear-to-PR agent. Delegate a Linear issue to it, get back a pull request with code, tests, and visual evidence. About a dollar per feature, about three minutes.

```
Linear ticket → webhook → Claude Managed Agents sandbox → GitHub PR
```

## How it works

1. You create a Linear issue and delegate it to "Factory Agent"
2. A webhook fires to this server
3. The server spawns a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/overview) session in an isolated Anthropic sandbox (container with bash, file tools, Chromium, GitHub CLI, unrestricted network)
4. The agent clones your repo, reads `CLAUDE.md` / `README.md` for conventions, implements the feature, browser-tests it with Puppeteer, commits evidence screenshots, pushes a branch, and opens a PR
5. Progress streams back to Linear as agent activities; the issue moves to Done with the PR link

The whole thing is ~700 lines of TypeScript split across two files:

- `src/server.ts` - webhook handler, OAuth callback, signature verification
- `src/agent.ts` - Managed Agent session lifecycle, task message, event streaming, Linear activity relay

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- An [Anthropic API key](https://console.anthropic.com/settings/keys) with Claude Managed Agents access
- A Linear workspace with admin access (to create an OAuth app)
- A public GitHub repo for the agent to work on, plus a [Personal Access Token](https://github.com/settings/tokens) with `repo` scope
- A public URL for the webhook (fly.io, Railway, ngrok, hookdeck, etc.)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-org/factory-agent.git
cd factory-agent
bun install
```

### 2. Create a Linear OAuth app

Go to https://linear.app/settings/api/applications/new and create an app with:

- **Name:** Factory Agent (or whatever you like)
- **Webhook URL:** `https://your-domain.com/webhook/linear`
- **Events:** enable **Agent session events** (this is the critical checkbox - without it the agent won't receive delegation events)
- **Scopes:** `read`, `write`, `app:assignable`, `app:mentionable`

Save the app. Copy the **Client ID** and **Client Secret**.

### 3. Install the app on your workspace (actor=app flow)

The app must be installed as an agent actor so it can be assigned to issues. Start the server locally, then visit `/install`:

```bash
cp .env.example .env
# Fill in at minimum: ANTHROPIC_API_KEY, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET,
# REPO_URL, GH_TOKEN. Leave LINEAR_ACCESS_TOKEN empty for now.

bun run dev
# In a browser: http://localhost:3457/install
```

This redirects you through Linear's OAuth flow with `actor=app`. After approval, the callback logs the access token to the console. Save it as `LINEAR_ACCESS_TOKEN` in `.env` and restart.

### 4. Make the webhook reachable

For local development:

```bash
# Option A: ngrok
ngrok http 3457

# Option B: hookdeck
hookdeck listen 3457 factory-agent
```

Update the webhook URL in your Linear OAuth app settings to the public URL.

For production, deploy to fly.io (see [Deployment](#deployment)).

### 5. Point the agent at a target repo

Set `REPO_URL` in `.env` to the GitHub URL of the repo you want the agent to work on. The agent will clone it fresh for every issue, so no state is shared between runs.

The target repo should ideally have a `CLAUDE.md` file describing conventions the agent should follow (code style, design patterns, testing approach). The agent will read it as part of step 4 in its workflow.

### 6. Delegate your first issue

In Linear, create an issue and delegate it to "Factory Agent". Watch the activities stream in on the issue detail page. A few minutes later, the issue moves to Done with a PR link attached.

## Environment variables

See [`.env.example`](.env.example) for the full list. Summary:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Managed Agents API access |
| `LINEAR_ACCESS_TOKEN` | Yes | App token (from OAuth install) |
| `REPO_URL` | Yes | Target repo to clone + modify |
| `GH_TOKEN` | Yes | GitHub PAT for clone/push/PR |
| `LINEAR_WEBHOOK_SECRET` | Recommended | HMAC signature verification |
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` | For `/install` | OAuth app credentials |
| `PROJECT_DESCRIPTION` | Optional | Human-readable context in task message |
| `PUBLIC_URL` | Optional | For OAuth callback (defaults to `http://localhost:$PORT`) |
| `PORT` | Optional | Server port (default 3457) |

## Deployment

### fly.io (recommended)

```bash
fly launch --no-deploy       # accept the generated config, edit fly.toml if needed
fly secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  LINEAR_ACCESS_TOKEN=lin_oauth_... \
  LINEAR_WEBHOOK_SECRET=... \
  REPO_URL=https://github.com/you/repo.git \
  GH_TOKEN=ghp_... \
  PUBLIC_URL=https://your-app.fly.dev
fly deploy
```

Update the webhook URL in your Linear OAuth app to `https://your-app.fly.dev/webhook/linear`.

### Docker

```bash
docker build -t factory-agent .
docker run -p 3457:3457 --env-file .env factory-agent
```

### Anywhere else

It's a Bun server with two dependencies. Any platform that runs Bun (or Node with a small runtime swap) will work.

## Cost

Per feature on a landing-page-sized repo:

- Tokens: ~300k input + 5k output on Sonnet 4.6 ≈ $1.00
- Sandbox runtime: ~$0.005 ($0.08/session-hour × 4 min)
- **Total: ~$1 per PR**

Larger codebases and more complex features will cost more. The tokens scale with how much of the codebase the agent reads before making changes.

## Security notes

- The `GH_TOKEN` is passed to the sandbox via the task message and redacted from Linear activity logs before relay
- The sandbox is an isolated Anthropic container; state is not shared between sessions
- `LINEAR_WEBHOOK_SECRET` enables HMAC verification - use it in production
- The app token (`LINEAR_ACCESS_TOKEN`) has write access to your Linear workspace - treat it like a password
- The `GH_TOKEN` has write access to your GitHub repo - use a fine-grained PAT scoped to just the target repo

## Architecture

```
┌──────────┐  webhook  ┌──────────────┐  sessions.create  ┌──────────────────┐
│  Linear  │──────────>│  This server │──────────────────>│  Claude Managed  │
│  (issue) │           │  (Bun HTTP)  │                   │  Agents sandbox  │
└──────────┘           └──────┬───────┘                   │  (bash, browser, │
     ▲                        │                           │   git, gh CLI)   │
     │                        │  activity relay           └────────┬─────────┘
     │  activities            │                                    │
     │                        ▼                                    │  git push
┌────┴─────┐           ┌──────────────┐                             │  gh pr create
│  agent   │           │  Agent       │                             ▼
│  session │           │  activities  │                       ┌──────────┐
│  detail  │           │  on issue    │                       │  GitHub  │
└──────────┘           └──────────────┘                       │  (PR)    │
                                                              └──────────┘
```

The server is stateless apart from an in-memory `activeSessions` set (deduplication). Crashing and restarting is safe - in-flight work in the Managed Agents sandbox will still run to completion; the server just won't relay the final events to Linear for that one issue.

## License

MIT. See [LICENSE](LICENSE).
