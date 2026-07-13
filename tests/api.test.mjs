import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMathHiveServer } from "../server/app.mjs";

async function withServer(run) {
  const runtime = await createMathHiveServer({ port: 0, storeFile: `/tmp/mathhive-api-${randomUUID()}.json`, reset: true });
  const address = await runtime.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try { await run({ runtime, baseUrl }); } finally { await runtime.stop(); }
}

async function request(baseUrl, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

test("join, author, coach, validate, notify, star, and preserve revision history", async () => {
  await withServer(async ({ baseUrl }) => {
    const ada = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Ada Test", pin: "1234" } });
    const emmy = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Emmy Test", pin: "5678" } });
    assert.notEqual(ada.token, emmy.token);
    const initial = await request(baseUrl, `/api/bootstrap?spaceId=${ada.space.id}`, { token: ada.token });
    const geometry = initial.spaces.find((space) => space.inviteSlug === "algebraic-geometry");
    await request(baseUrl, "/api/profiles/me", { token: emmy.token, method: "PATCH", body: { activeSpaceId: geometry.id } });
    const emmyDraft = await request(baseUrl, "/api/results", { token: emmy.token, method: "POST", body: { spaceId: geometry.id, title: "Geometric equality application", tags: ["equality"] } });

    let result = await request(baseUrl, "/api/results", { token: ada.token, method: "POST", body: { spaceId: ada.space.id, title: "Test spectral lemma" } });
    result = await request(baseUrl, `/api/results/${result.id}`, { token: ada.token, method: "PATCH", body: {
      statementLatex: "\\lambda_1(G) \\ge 0",
      hypothesesLatex: ["G \\text{ is finite}"],
      proofMarkdown: "Since the graph Laplacian is positive semidefinite, every eigenvalue is nonnegative. Therefore the first eigenvalue satisfies the claimed lower bound.",
      tags: ["spectral-gap"]
    }});
    const draftRevision = result.draftRevision;

    await request(baseUrl, `/api/results/${result.id}/star`, { token: emmy.token, method: "POST", body: {} });
    await request(baseUrl, `/api/results/${result.id}/draft-review`, { token: ada.token, method: "POST", body: {} });
    let claimed = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    assert.equal(claimed.work.type, "review_draft");
    const context = await request(baseUrl, `/api/internal/work/${claimed.work.id}/context`);
    assert.equal(context.result.id, result.id);
    await request(baseUrl, `/api/internal/work/${claimed.work.id}/draft-review`, { method: "POST", body: {
      draftRevision,
      summary: "The positivity argument is appropriate; define which eigenvalue indexing convention is used.",
      issues: [{ severity: "warning", location: "statement", message: "Clarify whether lambda_1 includes the zero eigenvalue." }],
      relevantResultIds: [],
      notification: { title: "Draft feedback ready", body: "Clarify the eigenvalue convention." }
    }});

    const submitted = await request(baseUrl, `/api/results/${result.id}/submit`, { token: ada.token, method: "POST", body: {} });
    claimed = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    assert.equal(claimed.work.type, "validate_result");
    await request(baseUrl, `/api/internal/work/${claimed.work.id}/validation`, { method: "POST", body: {
      submittedRevisionId: submitted.result.submittedRevisionId,
      decision: "validated",
      claimRestatement: "The selected Laplacian eigenvalue is nonnegative.",
      summary: "The claim follows directly from positive semidefiniteness under the stated finite-graph hypothesis.",
      assumptionChecks: [{ subject: "finite graph", status: "pass", explanation: "The finite Laplacian is a positive semidefinite matrix." }],
      proofStepChecks: [{ stepId: "step-1", status: "pass", explanation: "Positive semidefiniteness implies all eigenvalues are nonnegative." }],
      dependencyChecks: [], counterexampleRisks: ["Eigenvalue indexing convention should remain explicit."], issues: [], confidence: 96,
      notification: { title: "Result validated", body: "The proof establishes the nonnegative lower bound." }
    }});

    const bootstrap = await request(baseUrl, `/api/bootstrap?spaceId=${ada.space.id}`, { token: ada.token });
    const final = bootstrap.results.find((item) => item.id === result.id);
    assert.equal(final.status, "validated");
    assert.deepEqual(final.starredBy, [emmy.profile.id]);
    assert.equal(bootstrap.draftFeedback.some((item) => item.resultId === result.id), true);
    assert.equal(bootstrap.revisions.some((item) => item.id === final.submittedRevisionId), true);
    assert.equal(bootstrap.notifications.some((item) => item.type === "validation"), true);
    claimed = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    assert.equal(claimed.work.type, "suggest_integrations");
    const research = await request(baseUrl, `/api/internal/work/${claimed.work.id}/research-context`, { method: "POST", body: { tags: ["equality"] } });
    assert.equal(research.some((item) => item.id === emmyDraft.id), true);
    await request(baseUrl, `/api/internal/work/${claimed.work.id}/integrations`, { method: "POST", body: {
      suggestions: [{
        type: "integration", title: "Use the validated equality lemma", explanation: "The active geometry draft uses the same equality hypothesis.", confidence: 97,
        sourceResultIds: [result.id], targetResultIds: [emmyDraft.id], audienceUserIds: [emmy.profile.id],
        proposedChanges: [{ type: "create_imported_result", sourceResultId: result.id, x: 520, y: 260 }],
        evidence: ["Both results use the equality tag and compatible hypotheses."]
      }],
      notifications: [{ userId: emmy.profile.id, title: "Relevant validated result", body: "A validated equality lemma can support your geometry draft." }]
    }});
    let emmyBootstrap = await request(baseUrl, `/api/bootstrap?spaceId=${geometry.id}`, { token: emmy.token });
    assert.equal(emmyBootstrap.suggestions.length, 1);
    assert.equal(emmyBootstrap.notifications.some((item) => item.type === "relevance"), true);
    await request(baseUrl, `/api/suggestions/${emmyBootstrap.suggestions[0].id}/accept`, { token: emmy.token, method: "POST", body: {} });
    emmyBootstrap = await request(baseUrl, `/api/bootstrap?spaceId=${geometry.id}`, { token: emmy.token });
    assert.equal(emmyBootstrap.results.some((item) => item.sourceResultId === result.id && item.status === "imported"), true);
    const projection = await request(baseUrl, `/api/internal/projection/${ada.space.id}`);
    assert.deepEqual(projection.warnings, []);
    await request(baseUrl, "/api/logout", { token: ada.token, method: "POST", body: {} });
    const loggedOut = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Authorization: `Bearer ${ada.token}` } });
    assert.equal(loggedOut.status, 401);
  });
});
