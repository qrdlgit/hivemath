#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = process.env.MATHHIVE_URL || "http://127.0.0.1:4173";

async function command(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${payload.error || response.status}: ${payload.message || "MathHive command failed"}`);
  return payload;
}

function result(payload) {
  const structuredContent = Array.isArray(payload) ? { items: payload } : payload;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent
  };
}

const server = new McpServer({ name: "mathhive-poc", version: "0.1.0" }, {
  instructions: [
    "You are the sole mathematical review and integration agent for the local MathHive POC.",
    "Poll get_next_work. For every claimed item, get its full context, reason through the mathematics yourself, then submit exactly one matching completion command.",
    "For validation, restate the claim, check hypotheses, dependencies, and every proof step. For Proof and Counterexample contributions, compare against relationTarget and return verificationEdge.id so the server can verify that exact edge. Explicitly decide whether linked task work is complete or should stay open.",
    "For conjectures, assess precision and relevance to the theorem space. Conjectures are not proofs and must never be marked validated.",
    "For current-status work, use the complete workspace snapshot and timestamped history. Produce accurate Markdown with valid LaTeX, preserve recorded validation distinctions, and use the supplied result/task link syntax.",
    "For integration work, search other spaces, inspect full proofs of promising candidates, identify affected active authors, and submit targeted notifications plus executable graph/import changes.",
    "Use inspect_projection after commands that change graph content. If work cannot be completed, call fail_work so its lease does not remain claimed."
  ].join(" ")
});

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const registerReadTool = (name, config, handler) => server.registerTool(name, { ...config, annotations: readAnnotations }, handler);
const registerWriteTool = (name, config, handler) => server.registerTool(name, { ...config, annotations: writeAnnotations }, handler);

registerReadTool("get_queue_status", {
  description: "Poll MathHive without claiming work. Use this to detect queued review, validation, or integration work.",
  inputSchema: {}
}, async () => result(await command("/api/internal/work/count")));

registerWriteTool("set_agent_status", {
  description: "Update the visible local agent state for operators. The polling worker uses this for idle, starting, and failed states.",
  inputSchema: {
    state: z.enum(["offline", "idle", "starting", "reviewing", "summarizing", "integrating", "failed"]),
    currentWorkType: z.string().nullable().default(null)
  }
}, async (body) => result(await command("/api/internal/agent-status", { method: "POST", body })));

registerWriteTool("get_next_work", {
  description: "Claim the highest-priority MathHive work item for five minutes. Validation outranks integration and draft coaching.",
  inputSchema: {}
}, async () => result(await command("/api/internal/work/next", { method: "POST", body: {} })));

registerReadTool("get_work_context", {
  description: "Load the complete context for claimed work. Result work includes the exact revision, mathematics, task, graph, and review context. Current-status work includes every current workspace entity, full publication history, and a compact timestamped activity/revision/task timeline.",
  inputSchema: { workId: z.string().uuid() }
}, async ({ workId }) => result(await command(`/api/internal/work/${workId}/context`)));

registerReadTool("search_research_context", {
  description: "For claimed integration work, search results in other theorem spaces. First search by tags; then request selected resultIds to receive their full proof text.",
  inputSchema: {
    workId: z.string().uuid(),
    tags: z.array(z.string()).max(20).default([]),
    resultIds: z.array(z.string()).max(10).default([]),
    limit: z.number().int().min(1).max(200).default(100)
  }
}, async ({ workId, ...query }) => result(await command(`/api/internal/work/${workId}/research-context`, { method: "POST", body: query })));

const issueSchema = z.object({
  severity: z.enum(["info", "warning", "error"]).default("warning"),
  location: z.string().optional(),
  message: z.string().min(1),
  suggestedFix: z.string().optional()
});

const statusSourceRefSchema = z.object({
  entityType: z.enum(["result", "task", "edge", "revision", "review", "current_status"]),
  entityId: z.string().min(1),
  label: z.string().max(160).default("")
});

registerWriteTool("submit_current_status_draft", {
  description: "Fill the lead's current-status draft from the complete claimed workspace context. Return one detailed Markdown note with valid $...$ or $$...$$ LaTeX, exact result/task links, and source references. The server notifies the lead and will not overwrite a concurrently changed draft.",
  inputSchema: {
    workId: z.string().uuid(),
    baseDraftRevision: z.number().int().min(0),
    markdown: z.string().min(1).max(50_000),
    summary: z.string().min(1).max(1000),
    sourceRefs: z.array(statusSourceRefSchema).max(100).default([]),
    notification: z.object({ title: z.string().min(1), body: z.string().min(1) })
  }
}, async ({ workId, ...body }) => result(await command(`/api/internal/work/${workId}/current-status-draft`, { method: "POST", body })));

registerWriteTool("submit_current_status_review", {
  description: "Review a lead-written current-status draft against the complete workspace context and return one proposed replacement. Preserve sound material, correct inaccuracies, add important omissions, use valid Markdown/LaTeX and exact workspace links, and cite source entities.",
  inputSchema: {
    workId: z.string().uuid(),
    baseDraftRevision: z.number().int().min(0),
    proposedMarkdown: z.string().min(1).max(50_000),
    rationale: z.string().min(1).max(2000),
    sourceRefs: z.array(statusSourceRefSchema).max(100).default([]),
    notification: z.object({ title: z.string().min(1), body: z.string().min(1) })
  }
}, async ({ workId, ...body }) => result(await command(`/api/internal/work/${workId}/current-status-review`, { method: "POST", body })));

registerWriteTool("submit_draft_review", {
  description: "Push realtime coaching for the exact draft revision. The server rejects stale targeting and notifies the draft author.",
  inputSchema: {
    workId: z.string().uuid(),
    draftRevision: z.number().int().min(1),
    summary: z.string().min(1),
    issues: z.array(issueSchema).max(12),
    relevantResultIds: z.array(z.string()).max(12).default([]),
    relevanceAssessment: z.object({
      verdict: z.enum(["relevant", "possibly_relevant", "not_relevant"]),
      explanation: z.string().min(1),
      relatedResultIds: z.array(z.string()).max(12).default([])
    }),
    taskAlignment: z.object({
      verdict: z.enum(["addresses_task", "partially_addresses_task", "outside_task"]),
      explanation: z.string().min(1)
    }).optional(),
    notification: z.object({ title: z.string().min(1), body: z.string().min(1) })
  }
}, async ({ workId, ...body }) => result(await command(`/api/internal/work/${workId}/draft-review`, { method: "POST", body })));

registerWriteTool("submit_conjecture_review", {
  description: "Submit Codex's manual precision and relevance review of a frozen conjecture. Relevant conjectures are published and queued for integration suggestions; conjectures are never proof-validated.",
  inputSchema: {
    workId: z.string().uuid(),
    submittedRevisionId: z.string().min(1),
    decision: z.enum(["relevant", "needs_clarification", "not_relevant"]),
    summary: z.string().min(1),
    relevanceExplanation: z.string().min(1),
    relatedResultIds: z.array(z.string()).max(12).default([]),
    issues: z.array(issueSchema).max(20),
    confidence: z.number().min(0).max(100),
    notification: z.object({ title: z.string().min(1), body: z.string().min(1) })
  }
}, async ({ workId, ...body }) => result(await command(`/api/internal/work/${workId}/conjecture-review`, { method: "POST", body })));

const checkSchema = z.object({
  subject: z.string().min(1),
  status: z.enum(["pass", "concern", "fail"]),
  explanation: z.string().min(1)
});

const stepCheckSchema = z.object({
  stepId: z.string().min(1),
  status: z.enum(["pass", "concern", "fail"]),
  explanation: z.string().min(1)
});

registerWriteTool("submit_validation", {
  description: "Submit Codex's manual review of a frozen revision and explicit task outcome. Proof/Counterexample validation verifies the exact edge and promotes the target conjecture to Proved/Refuted.",
  inputSchema: {
    workId: z.string().uuid(),
    submittedRevisionId: z.string().min(1),
    verificationEdgeId: z.string().uuid().nullable().default(null),
    provesEdgeId: z.string().uuid().nullable().default(null),
    refutesEdgeId: z.string().uuid().nullable().default(null),
    decision: z.enum(["validated", "needs_changes", "rejected"]),
    claimRestatement: z.string().min(1),
    summary: z.string().min(1),
    assumptionChecks: z.array(checkSchema).max(30),
    proofStepChecks: z.array(stepCheckSchema).max(80),
    counterexampleChecks: z.array(checkSchema).max(40).default([]),
    dependencyChecks: z.array(checkSchema).max(30),
    counterexampleRisks: z.array(z.string()).max(20),
    issues: z.array(issueSchema).max(20),
    confidence: z.number().min(0).max(100),
    taskId: z.string().uuid().nullable().default(null),
    taskOutcome: z.enum(["complete", "keep_open"]).nullable().default(null),
    taskRationale: z.string().default(""),
    notification: z.object({ title: z.string().min(1), body: z.string().min(1) })
  }
}, async ({ workId, ...body }) => result(await command(`/api/internal/work/${workId}/validation`, { method: "POST", body })));

const changeSchema = z.object({ type: z.enum(["create_edge", "create_imported_result"]) }).passthrough();

registerWriteTool("submit_integrations", {
  description: "Push targeted cross-space relevance suggestions, executable graph/import commands, and per-user notifications after manually comparing validated results.",
  inputSchema: {
    workId: z.string().uuid(),
    suggestions: z.array(z.object({
      type: z.enum(["relevance", "integration", "conflict"]).default("relevance"),
      title: z.string().min(1),
      explanation: z.string().min(1),
      confidence: z.number().min(0).max(100),
      taskId: z.string().uuid().nullable().default(null),
      scope: z.enum(["within_task", "blueprint_change"]).default("blueprint_change"),
      sourceResultIds: z.array(z.string()).max(10).default([]),
      targetResultIds: z.array(z.string()).max(10).default([]),
      audienceUserIds: z.array(z.string()).max(20).default([]),
      proposedChanges: z.array(changeSchema).max(10),
      evidence: z.array(z.string()).max(20)
    })).max(4),
    notifications: z.array(z.object({
      userId: z.string().uuid(),
      title: z.string().min(1),
      body: z.string().min(1),
      dedupeKey: z.string().optional()
    })).max(20)
  }
}, async ({ workId, ...body }) => result(await command(`/api/internal/work/${workId}/integrations`, { method: "POST", body })));

registerReadTool("inspect_projection", {
  description: "Run the minimal deterministic graph audit: dangling/duplicate edges, off-canvas nodes, counts, statuses, and open suggestions.",
  inputSchema: { spaceId: z.string().min(1) }
}, async ({ spaceId }) => result(await command(`/api/internal/projection/${encodeURIComponent(spaceId)}`)));

registerWriteTool("fail_work", {
  description: "Release claimed work with a clear error. Retryable failures return to the queue up to the attempt limit.",
  inputSchema: {
    workId: z.string().uuid(),
    error: z.string().min(1),
    retryable: z.boolean().default(true)
  }
}, async ({ workId, ...body }) => result(await command(`/api/internal/work/${workId}/fail`, { method: "POST", body })));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`MathHive MCP connected to ${baseUrl}`);
