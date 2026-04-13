/**
 * Agent processor - uses Claude Managed Agents for sandboxed development.
 *
 * Each issue gets its own isolated container on Anthropic's infrastructure.
 * The agent can: bash, read/write files, git clone, npm install, run tests,
 * run headless Chromium. Network access is unrestricted.
 *
 * Lifecycle:
 *   1. Create Managed Agent (once, cached module-level)
 *   2. Create Environment (once, cached module-level)
 *   3. Per issue: create Session → send task → stream events → relay to Linear
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LinearClient } from "@linear/sdk";

const anthropic = new Anthropic();

const REPO_URL = process.env.REPO_URL ?? "";
const GH_TOKEN = process.env.GH_TOKEN ?? "";
const PROJECT_DESCRIPTION = process.env.PROJECT_DESCRIPTION ?? "the project";

if (!REPO_URL) {
  console.error("Missing REPO_URL (e.g., https://github.com/owner/repo.git)");
  process.exit(1);
}

let agentId: string | null = null;
let environmentId: string | null = null;

export interface ProcessIssueParams {
  linear: LinearClient;
  linearSessionId: string;
  issueId: string;
  title: string;
  description: string;
}

// ----------------------------------------------------------------------------
// Linear activity + plan helpers (use raw GraphQL - Linear SDK v37 has no
// typed methods for agent session mutations yet)
// ----------------------------------------------------------------------------

const STEPS = [
  "Provision sandbox environment",
  "Clone repository",
  "Develop feature",
  "Test and verify",
  "Create pull request",
] as const;

function planWithProgress(activeIndex: number) {
  return STEPS.map((content, i) => ({
    content,
    status:
      i < activeIndex ? "completed" :
      i === activeIndex ? "inProgress" : "pending",
  }));
}

async function emitActivity(
  linear: LinearClient,
  sessionId: string,
  content: Record<string, unknown>,
) {
  if (!sessionId) return;
  try {
    await linear.client.rawRequest(
      `mutation($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success }
      }`,
      { input: { agentSessionId: sessionId, content } },
    );
  } catch (err) {
    console.error(`[linear] emitActivity failed:`, err);
  }
}

async function updateSession(
  linear: LinearClient,
  sessionId: string,
  input: Record<string, unknown>,
) {
  if (!sessionId) return;
  try {
    await linear.client.rawRequest(
      `mutation($id: String!, $input: AgentSessionUpdateInput!) {
        agentSessionUpdate(id: $id, input: $input) { success }
      }`,
      { id: sessionId, input },
    );
  } catch (err) {
    console.error(`[linear] updateSession failed:`, err);
  }
}

/**
 * Move a Linear issue to a workflow state and assign it to the agent app.
 * Combines both mutations into a single API call.
 */
async function claimIssue(
  linear: LinearClient,
  issueId: string,
  stateType: "started" | "completed",
) {
  try {
    const issue = await linear.issue(issueId);
    const team = await issue.team;
    if (!team) return;
    const states = await team.states();
    const target = states.nodes.find((s) => s.type === stateType);
    if (!target) return;

    const update: { stateId: string; assigneeId?: string } = { stateId: target.id };
    if (stateType === "started") {
      const viewer = await linear.viewer;
      if (viewer?.id) update.assigneeId = viewer.id;
    }
    await issue.update(update);
    console.log(`[linear] ${issueId} → ${target.name}`);
  } catch (err) {
    console.error(`[linear] claimIssue failed:`, err);
  }
}

// ----------------------------------------------------------------------------
// Managed Agent + Environment singletons
// ----------------------------------------------------------------------------

async function ensureAgent(): Promise<string> {
  if (agentId) return agentId;

  const agent = await anthropic.beta.agents.create({
    name: "Factory Developer",
    model: "claude-sonnet-4-6",
    system: `You are an autonomous software factory agent. You receive issue descriptions and develop features end-to-end.

Your workflow:
1. Clone the repository
2. Read the existing codebase (CLAUDE.md, README.md, and key source files) to understand conventions
3. Implement the requested feature
4. Verify the implementation (run tests if they exist)
5. Browser-test the result when applicable: open the page in headless Chromium, take a screenshot to verify it looks correct
6. Create a GIF or screenshot showing the implemented feature
7. Commit with a descriptive message
8. Push to a feature branch
9. Create a pull request using the gh CLI, attaching the screenshot/GIF as evidence

Browser testing steps (when the project is a web app):
- Use puppeteer-core (pre-installed) with system Chromium at /usr/bin/chromium
- Write a small Node.js script: launch Chromium (--no-sandbox --disable-gpu), open the local HTML file
- Take a full-page screenshot, save as evidence.png (also take mobile at 375px width as evidence-mobile.png)
- IMPORTANT: git add evidence.png evidence-mobile.png BEFORE committing so they are part of the pushed branch
- In the PR body, reference screenshots using raw.githubusercontent.com URLs pointing to the branch

Rules:
- Match existing code style and design patterns
- No bare TODO/FIXME without ticket references
- No console.log for debugging
- Mobile responsive design where applicable (breakpoint at 768px)
- Test your changes before committing
- Always include visual evidence (screenshot) in the PR when the feature is visual

You have bash, file operations, full network access, and headless Chromium. Use them.`,
    tools: [{ type: "agent_toolset_20260401" }],
  });

  agentId = agent.id;
  console.log(`[managed] Agent created: ${agentId}`);
  return agentId;
}

async function ensureEnvironment(): Promise<string> {
  if (environmentId) return environmentId;

  const environment = await anthropic.beta.environments.create({
    name: `factory-env-${Date.now()}`,
    config: {
      type: "cloud",
      packages: {
        apt: ["gh", "chromium", "fonts-liberation"],
        npm: ["puppeteer-core"],
      },
      networking: { type: "unrestricted" },
    },
  });

  environmentId = environment.id;
  console.log(`[managed] Environment created: ${environmentId}`);
  return environmentId;
}

// ----------------------------------------------------------------------------
// Task message builder
// ----------------------------------------------------------------------------

function buildTaskMessage(issueId: string, title: string, description: string): string {
  const ghAuthCmd = GH_TOKEN
    ? `echo "${GH_TOKEN}" | gh auth login --with-token 2>/dev/null && git config --global url."https://x-access-token:$(gh auth token)@github.com/".insteadOf "https://github.com/" 2>/dev/null && echo "GitHub auth configured"`
    : "# No GH_TOKEN - push/PR will require manual auth";

  return `Develop this feature for ${PROJECT_DESCRIPTION}.

ISSUE: ${issueId} - ${title}

DESCRIPTION:
${description}

STEPS:
1. First, set up GitHub auth:
   ${ghAuthCmd}

2. Clone the repo:
   git clone ${REPO_URL} /home/user/project && cd /home/user/project

3. Create a feature branch:
   git checkout -b feat/${issueId.toLowerCase()}-$(date +%s)

4. Read the existing code (CLAUDE.md, README.md, source files) to understand conventions

5. Implement the feature described above

6. Verify: run tests if they exist, check that your changes work

7. Browser test (if the project is a web app): take screenshots to verify the feature looks correct
   - Write a Node.js script using puppeteer-core with executablePath: '/usr/bin/chromium'
   - Launch with args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
   - Take desktop screenshot (1280px width) -> evidence.png
   - Take mobile screenshot (375px width) -> evidence-mobile.png
   - Run the script with: node screenshot.js

8. Commit (INCLUDE evidence screenshots if you took any):
   git add -A && git commit -m "feat(${issueId}): ${title}"

9. Push and create PR. Derive the repo owner/name dynamically:
   git push -u origin HEAD
   BRANCH=$(git rev-parse --abbrev-ref HEAD)
   REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   gh pr create --title "feat(${issueId}): ${title}" --body "Implements ${issueId}: ${title}

   ${description}

   ## Visual Evidence
   ### Desktop
   ![Desktop](https://raw.githubusercontent.com/$REPO_SLUG/$BRANCH/evidence.png)
   ### Mobile
   ![Mobile](https://raw.githubusercontent.com/$REPO_SLUG/$BRANCH/evidence-mobile.png)

   ---
   🤖 Developed autonomously by Factory Agent in Anthropic sandbox"

Report the PR URL when done.`;
}

// ----------------------------------------------------------------------------
// Main pipeline
// ----------------------------------------------------------------------------

const TOKEN_REDACTIONS: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9_]+/g, "ghp_***"],
  [/gho_[A-Za-z0-9_]+/g, "gho_***"],
  [/x-access-token:[^@]+@/g, "x-access-token:***@"],
];

function redact(text: string): string {
  return TOKEN_REDACTIONS.reduce((acc, [re, replacement]) => acc.replace(re, replacement), text);
}

export async function processIssue(params: ProcessIssueParams): Promise<void> {
  const { linear, linearSessionId, issueId, title, description } = params;

  try {
    await claimIssue(linear, issueId, "started");
    await updateSession(linear, linearSessionId, { plan: planWithProgress(0) });

    const [aId, eId] = await Promise.all([ensureAgent(), ensureEnvironment()]);

    await emitActivity(linear, linearSessionId, {
      type: "action",
      action: "Provisioning sandbox",
      parameter: "Anthropic Managed Agent (isolated container)",
    });

    const session = await anthropic.beta.sessions.create({
      agent: aId,
      environment_id: eId,
      title: `${issueId}: ${title}`,
    });
    console.log(`[managed] Session created: ${session.id}`);

    await updateSession(linear, linearSessionId, { plan: planWithProgress(1) });

    const stream = await anthropic.beta.sessions.events.stream(session.id);
    await anthropic.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: buildTaskMessage(issueId, title, description) }] }],
    });
    console.log(`[managed] Task sent, streaming events...`);

    await emitActivity(linear, linearSessionId, {
      type: "action",
      action: "Developing",
      parameter: `${issueId}: ${title}`,
    });
    await updateSession(linear, linearSessionId, { plan: planWithProgress(2) });

    let prUrl = "";
    try {
      for await (const event of stream) {
        if (event.type === "agent.tool_use") {
          console.log(`[managed] Tool: ${event.name}`);
          if (["bash", "write", "edit"].includes(event.name)) {
            const raw = String(event.input?.command ?? event.input?.file_path ?? "");
            await emitActivity(linear, linearSessionId, {
              type: "action",
              action: event.name === "bash" ? "Running command" : "Editing code",
              parameter: redact(raw),
            });
          }
        } else if (event.type === "agent.message") {
          const text = event.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (text) {
            console.log(`[managed] Message: ${text.slice(0, 200)}`);
            const prMatch = text.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
            if (prMatch) {
              prUrl = prMatch[0];
              console.log(`[managed] PR found: ${prUrl}`);
            }
          }
        } else if (event.type === "session.status_idle") {
          console.log(`[managed] Session idle - agent finished`);
          break;
        }
      }
    } finally {
      // Best-effort cleanup if the stream holds an open HTTP connection
      await (stream as { controller?: { abort?: () => void } }).controller?.abort?.();
    }

    await updateSession(linear, linearSessionId, { plan: planWithProgress(5) });

    if (prUrl) {
      await updateSession(linear, linearSessionId, {
        addedExternalUrls: [{ label: "Pull Request", url: prUrl }],
      });
      await claimIssue(linear, issueId, "completed");
      await emitActivity(linear, linearSessionId, {
        type: "response",
        body: `✅ Development complete for ${issueId}.\n\n**Pull Request:** ${prUrl}\n\nDeveloped in an isolated Anthropic sandbox. The agent cloned the repo, implemented the feature, ran verification, and created a PR - all inside a sandboxed container.`,
      });
    } else {
      await emitActivity(linear, linearSessionId, {
        type: "response",
        body: `Development finished for ${issueId}. The agent worked in a sandboxed environment but could not confirm PR creation. Check the repository for a new branch.`,
      });
    }

    console.log(`[agent] ✅ Pipeline complete for ${issueId}`);
  } catch (err) {
    console.error(`[agent] Pipeline error:`, err);
    await emitActivity(linear, linearSessionId, {
      type: "error",
      body: `Pipeline failed: ${(err as Error).message}`,
    });
  }
}
