import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMathHiveServer } from "../server/app.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

function parsed(response) {
  assert.notEqual(response.isError, true, response.content?.[0]?.text);
  return response.structuredContent || JSON.parse(response.content.find((item) => item.type === "text").text);
}

test("MCP polls, claims context, and pushes draft feedback into MathHive", async () => {
  const runtime = await createMathHiveServer({ port: 0, storeFile: `/tmp/mathhive-mcp-${randomUUID()}.json`, reset: true });
  const address = await runtime.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const joinResponse = await fetch(`${baseUrl}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inviteSlug: "spectral-gap", displayName: "MCP Author", pin: "2468" }) });
  const joined = await joinResponse.json();
  const headers = { Authorization: `Bearer ${joined.token}`, "Content-Type": "application/json" };
  const created = await (await fetch(`${baseUrl}/api/results`, { method: "POST", headers, body: JSON.stringify({ spaceId: joined.space.id, title: "MCP lemma" }) })).json();
  const draft = await (await fetch(`${baseUrl}/api/results/${created.id}`, { method: "PATCH", headers, body: JSON.stringify({ statementLatex: "x=x", proofMarkdown: "By reflexivity of equality, every mathematical object is equal to itself, so the stated equality follows immediately." }) })).json();
  await fetch(`${baseUrl}/api/results/${created.id}/draft-review`, { method: "POST", headers, body: "{}" });

  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(rootDir, "mcp/server.mjs")], cwd: rootDir, env: { ...process.env, MATHHIVE_URL: baseUrl }, stderr: "pipe" });
  const client = new Client({ name: "mathhive-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "submit_validation"), true);
    const status = parsed(await client.callTool({ name: "get_queue_status", arguments: {} }));
    assert.equal(status.pendingWorkCount, 1);
    const next = parsed(await client.callTool({ name: "get_next_work", arguments: {} }));
    assert.equal(next.work.type, "review_draft");
    const context = parsed(await client.callTool({ name: "get_work_context", arguments: { workId: next.work.id } }));
    assert.equal(context.result.id, created.id);
    const completed = parsed(await client.callTool({ name: "submit_draft_review", arguments: {
      workId: next.work.id, draftRevision: draft.draftRevision,
      summary: "The reflexivity argument proves the statement.", issues: [], relevantResultIds: [],
      notification: { title: "MCP review ready", body: "The argument is valid as written." }
    } }));
    assert.equal(completed.stale, false);
    const bootstrap = await (await fetch(`${baseUrl}/api/bootstrap?spaceId=${joined.space.id}`, { headers: { Authorization: `Bearer ${joined.token}` } })).json();
    assert.equal(bootstrap.draftFeedback.some((item) => item.summary.includes("reflexivity")), true);
    assert.equal(bootstrap.notifications.some((item) => item.title === "MCP review ready"), true);

    const submitted = await (await fetch(`${baseUrl}/api/results/${created.id}/submit`, { method: "POST", headers, body: "{}" })).json();
    const validationWork = parsed(await client.callTool({ name: "get_next_work", arguments: {} }));
    assert.equal(validationWork.work.type, "validate_result");
    parsed(await client.callTool({ name: "submit_validation", arguments: {
      workId: validationWork.work.id, submittedRevisionId: submitted.result.submittedRevisionId,
      decision: "validated", claimRestatement: "Every object equals itself.", summary: "Reflexivity establishes the claim.",
      assumptionChecks: [{ subject: "object x", status: "pass", explanation: "Reflexivity applies to every object." }],
      proofStepChecks: [{ stepId: "step-1", status: "pass", explanation: "The sole step invokes equality reflexivity." }],
      dependencyChecks: [], counterexampleRisks: [], issues: [], confidence: 99,
      notification: { title: "MCP validation ready", body: "The proof is valid." }
    } }));
    const integrationWork = parsed(await client.callTool({ name: "get_next_work", arguments: {} }));
    assert.equal(integrationWork.work.type, "suggest_integrations");
    const research = parsed(await client.callTool({ name: "search_research_context", arguments: { workId: integrationWork.work.id, tags: ["equality"], resultIds: [], limit: 20 } }));
    assert.equal(Array.isArray(research.items), true);
    parsed(await client.callTool({ name: "submit_integrations", arguments: { workId: integrationWork.work.id, suggestions: [], notifications: [] } }));
    const projection = parsed(await client.callTool({ name: "inspect_projection", arguments: { spaceId: joined.space.id } }));
    assert.deepEqual(projection.warnings, []);
  } finally {
    await client.close().catch(() => {});
    await runtime.stop();
  }
});
