/**
 * Factory Agent Server
 *
 * Webhook relay. Receives Linear agent session events, spawns Claude Managed
 * Agent sessions in Anthropic's sandboxed infrastructure, streams progress back.
 *
 * Flow:
 *   Linear delegates issue → webhook → 200 OK < 10s
 *   → processIssue (async) creates Managed Agent session → streams events
 *   → on completion: update Linear issue
 */

import crypto from "node:crypto";
import { LinearClient } from "@linear/sdk";
import { processIssue } from "./agent.ts";

const PORT = Number(process.env.PORT ?? 3457);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET ?? "";
const LINEAR_CLIENT_ID = process.env.LINEAR_CLIENT_ID ?? "";
const LINEAR_CLIENT_SECRET = process.env.LINEAR_CLIENT_SECRET ?? "";

if (!process.env.LINEAR_ACCESS_TOKEN) {
  console.error("Missing LINEAR_ACCESS_TOKEN");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

let linear = new LinearClient({ apiKey: process.env.LINEAR_ACCESS_TOKEN });
const activeSessions = new Set<string>();

function verifySignature(rawBody: string, signature: string): boolean {
  if (!LINEAR_WEBHOOK_SECRET) return true;
  const computed = crypto
    .createHmac("sha256", LINEAR_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(signature, "hex")
    );
  } catch {
    return false;
  }
}

function finish(issueId: string, sessionId: string) {
  activeSessions.delete(issueId);
  if (sessionId) activeSessions.delete(sessionId);
}

async function handleWebhook(req: Request): Promise<Response> {
  const rawBody = await req.text();

  const signature = req.headers.get("linear-signature") ?? "";
  if (LINEAR_WEBHOOK_SECRET && !verifySignature(rawBody, signature)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  const { action, type } = payload;
  console.log(`[webhook] ${type} ${action}`);

  // Issue created in Todo state - create agent session, then process
  if (type === "Issue" && action === "create") {
    const issue = payload.data;
    if (!issue) return new Response("OK", { status: 200 });

    const issueId = issue.identifier ?? issue.id;
    if (issue.state?.type !== "unstarted") {
      console.log(`[skip] Issue ${issueId} not in Todo state`);
      return new Response("OK", { status: 200 });
    }
    if (activeSessions.has(issueId)) return new Response("OK", { status: 200 });
    activeSessions.add(issueId);

    console.log(`[agent] New issue: ${issueId} - ${issue.title}`);

    // Fire-and-forget: session creation + processing happen after we return 200.
    // Webhook must respond within 10s; Linear session creation can be slow.
    (async () => {
      let sessionId = "";
      try {
        const result = await linear.client.rawRequest<
          { agentSessionCreateOnIssue: { agentSession: { id: string } } },
          { input: { issueId: string } }
        >(
          `mutation($input: AgentSessionCreateOnIssue!) {
            agentSessionCreateOnIssue(input: $input) { success agentSession { id } }
          }`,
          { input: { issueId: issue.id } }
        );
        sessionId = result.data?.agentSessionCreateOnIssue?.agentSession?.id ?? "";
        if (sessionId) {
          console.log(`[linear] Agent session created: ${sessionId}`);
          activeSessions.add(sessionId);
        }
      } catch (err) {
        console.log(`[linear] Could not create agent session: ${(err as Error).message?.slice(0, 150)}`);
      }

      await processIssue({
        linear,
        linearSessionId: sessionId,
        issueId,
        title: issue.title ?? "",
        description: issue.description ?? "",
      }).catch((err) => console.error(`[agent] Error:`, err))
        .finally(() => finish(issueId, sessionId));
    })();

    return new Response("OK", { status: 200 });
  }

  // Issue delegated to this agent app - process directly
  if (type === "AgentSessionEvent" && action === "created") {
    const session = payload.data?.agentSession ?? payload.agentSession;
    if (!session) return new Response("OK", { status: 200 });

    const sessionId = session.id;
    const issue = session.issue;
    if (activeSessions.has(sessionId)) return new Response("OK", { status: 200 });
    activeSessions.add(sessionId);

    console.log(`[agent] Delegation: ${issue?.identifier} - ${issue?.title}`);

    processIssue({
      linear,
      linearSessionId: sessionId,
      issueId: issue?.identifier ?? issue?.id,
      title: issue?.title ?? "",
      description: issue?.description ?? "",
    }).catch((err) => console.error(`[agent] Error:`, err))
      .finally(() => finish(issue?.identifier ?? issue?.id, sessionId));

    return new Response("OK", { status: 200 });
  }

  return new Response("OK", { status: 200 });
}

/**
 * OAuth callback - exchanges code for app token after actor=app installation.
 * Linear SDK doesn't expose OAuth token exchange, so this is hand-rolled.
 */
async function handleOAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (!code) return new Response("Missing code", { status: 400 });

  const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: LINEAR_CLIENT_ID,
      client_secret: LINEAR_CLIENT_SECRET,
      redirect_uri: `${PUBLIC_URL}/oauth/callback`,
    }),
  });

  const tokenData = await tokenResponse.json() as { access_token?: string; error?: string };

  if (!tokenData.access_token) {
    console.error(`[oauth] Token exchange failed:`, tokenData);
    return new Response(`OAuth failed: ${JSON.stringify(tokenData)}`, { status: 500 });
  }

  linear = new LinearClient({ apiKey: tokenData.access_token });
  console.log(`[oauth] ✅ App installed. Token: ${tokenData.access_token.slice(0, 15)}...`);
  console.log(`[oauth] SAVE THIS TOKEN to your environment as LINEAR_ACCESS_TOKEN`);

  try {
    const viewer = await linear.viewer;
    console.log(`[oauth] App ID: ${viewer.id}, Name: ${viewer.name}`);
  } catch (err) {
    console.log(`[oauth] Viewer lookup failed:`, (err as Error).message);
  }

  return new Response(`
    <html><body style="font-family:system-ui;text-align:center;padding:4rem">
      <h1>✅ Factory Agent Installed</h1>
      <p>The agent is now active in your Linear workspace.</p>
      <p>Delegate issues to "Factory Agent" and watch them get developed automatically.</p>
      <p><a href="https://linear.app">Back to Linear</a></p>
    </body></html>
  `, { headers: { "Content-Type": "text/html" } });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/webhook/linear" && req.method === "POST") {
      return handleWebhook(req);
    }
    if (url.pathname === "/oauth/callback") {
      return handleOAuthCallback(req);
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", active: activeSessions.size });
    }
    if (url.pathname === "/install") {
      const authUrl = `https://linear.app/oauth/authorize?client_id=${LINEAR_CLIENT_ID}&redirect_uri=${PUBLIC_URL}/oauth/callback&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app`;
      return Response.redirect(authUrl, 302);
    }
    return new Response("Factory Agent 🏭", { status: 200 });
  },
});

console.log(`🏭 Factory Agent on ${PUBLIC_URL}`);
console.log(`   Webhook: /webhook/linear`);
console.log(`   Health:  /health`);
console.log(`   Install: /install (OAuth with actor=app)`);
