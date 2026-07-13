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

async function requestFailure(baseUrl, path, { token, method = "GET", body, status }) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.status, status, JSON.stringify(payload));
  return payload;
}

test("join, author, coach, validate, notify, star, and preserve revision history", async () => {
  await withServer(async ({ baseUrl }) => {
    const ada = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Ada Test", pin: "1234" } });
    const emmy = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Emmy Test", pin: "5678" } });
    assert.notEqual(ada.token, emmy.token);
    assert.match(ada.profile.color, /^#[0-9a-f]{6}$/);
    assert.match(emmy.profile.color, /^#[0-9a-f]{6}$/);
    assert.notEqual(ada.profile.color, emmy.profile.color);
    const returningAda = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Ada Test", pin: "1234" } });
    assert.equal(returningAda.profile.color, ada.profile.color);
    const renamedSpace = await request(baseUrl, `/api/spaces/${ada.space.id}`, { token: ada.token, method: "PATCH", body: { name: "Spectral Test Program" } });
    assert.equal(renamedSpace.name, "Spectral Test Program");
    const initial = await request(baseUrl, `/api/bootstrap?spaceId=${ada.space.id}`, { token: ada.token });
    assert.equal(initial.space.name, "Spectral Test Program");
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
    const validationNotification = bootstrap.notifications.find((item) => item.type === "validation");
    assert.equal(validationNotification.readBy.includes(ada.profile.id), false);
    const [readNotification] = await request(baseUrl, "/api/notifications/read", { token: ada.token, method: "POST", body: { ids: [validationNotification.id] } });
    assert.equal(readNotification.id, validationNotification.id);
    assert.equal(readNotification.readBy.includes(ada.profile.id), true);
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

test("conjectures are reviewed for relevance without requiring a proof", async () => {
  await withServer(async ({ baseUrl }) => {
    const author = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Conjecture Author", pin: "8642" } });
    const initial = await request(baseUrl, `/api/bootstrap?spaceId=${author.space.id}`, { token: author.token });
    const root = initial.results.find((item) => item.id === "result-main");
    let conjecture = await request(baseUrl, "/api/results", { token: author.token, method: "POST", body: { spaceId: author.space.id, kind: "conjecture", title: "Nonnegative spectral gap" } });
    conjecture = await request(baseUrl, `/api/results/${conjecture.id}`, { token: author.token, method: "PATCH", body: {
      statementLatex: "\\lambda_1(G) \\ge 0",
      hypothesesLatex: ["G \\text{ is a finite graph}"],
      dependencyIds: [root.id], tags: ["spectral-gap", "conjecture"]
    }});
    assert.equal(conjecture.kind, "conjecture");
    assert.equal(conjecture.proofMarkdown, "");

    const submitted = await request(baseUrl, `/api/results/${conjecture.id}/submit`, { token: author.token, method: "POST", body: {} });
    assert.equal(submitted.work.type, "review_conjecture");
    const claimed = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    assert.equal(claimed.work.type, "review_conjecture");
    const context = await request(baseUrl, `/api/internal/work/${claimed.work.id}/context`);
    assert.equal(context.relatedCandidates.some((item) => item.id === root.id && item.statementLatex), true);

    await request(baseUrl, `/api/internal/work/${claimed.work.id}/conjecture-review`, { method: "POST", body: {
      submittedRevisionId: submitted.result.submittedRevisionId,
      decision: "relevant",
      summary: "The conjecture gives a foundational lower bound for the theorem-space target.",
      relevanceExplanation: "It concerns the same spectral quantity under compatible finite-graph hypotheses.",
      relatedResultIds: [root.id], issues: [], confidence: 91,
      notification: { title: "Conjecture is relevant", body: "Codex connected it to Main Theorem." }
    }});

    const bootstrap = await request(baseUrl, `/api/bootstrap?spaceId=${author.space.id}`, { token: author.token });
    const reviewed = bootstrap.results.find((item) => item.id === conjecture.id);
    assert.equal(reviewed.status, "conjecture");
    assert.equal(reviewed.relevanceStatus, "relevant");
    assert.equal(bootstrap.reviews.some((item) => item.resultId === conjecture.id && item.reviewType === "conjecture_relevance" && item.relatedResultIds.includes(root.id)), true);
    assert.equal(bootstrap.notifications.some((item) => item.type === "conjecture_review"), true);

    let proof = await request(baseUrl, "/api/results", { token: author.token, method: "POST", body: { spaceId: author.space.id, kind: "proof", title: "Proof of nonnegative spectral gap" } });
    proof = await request(baseUrl, `/api/results/${proof.id}`, { token: author.token, method: "PATCH", body: {
      statementLatex: conjecture.statementLatex,
      hypothesesLatex: conjecture.hypothesesLatex,
      proofMarkdown: "Let $L$ be the graph Laplacian. For every vector $v$, the quadratic form $v^T L v$ is a sum of squared edge differences and is therefore nonnegative. Hence $L$ is positive semidefinite, so all its eigenvalues, including $\\lambda_1(G)$, are nonnegative."
    }});
    const unlinkedSubmission = await fetch(`${baseUrl}/api/results/${proof.id}/submit`, { method: "POST", headers: { Authorization: `Bearer ${author.token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unlinkedSubmission.status, 400);
    assert.equal((await unlinkedSubmission.json()).error, "missing_proves_edge");
    const provesEdge = await request(baseUrl, "/api/edges", { token: author.token, method: "POST", body: { sourceResultId: proof.id, targetResultId: conjecture.id, relation: "proves" } });
    assert.equal(provesEdge.verificationStatus, "proposed");
    assert.equal(provesEdge.targetRevisionId, submitted.result.submittedRevisionId);

    const proofSubmission = await request(baseUrl, `/api/results/${proof.id}/submit`, { token: author.token, method: "POST", body: {} });
    const proofWork = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    assert.equal(proofWork.work.type, "validate_result");
    const proofContext = await request(baseUrl, `/api/internal/work/${proofWork.work.id}/context`);
    assert.equal(proofContext.provesEdge.id, provesEdge.id);
    assert.equal(proofContext.proofTarget.id, conjecture.id);
    assert.equal(proofContext.proofTargetRevision.id, submitted.result.submittedRevisionId);
    await request(baseUrl, `/api/internal/work/${proofWork.work.id}/validation`, { method: "POST", body: {
      submittedRevisionId: proofSubmission.result.submittedRevisionId,
      provesEdgeId: provesEdge.id,
      decision: "validated",
      claimRestatement: "The selected graph Laplacian eigenvalue is nonnegative.",
      summary: "The submitted proof establishes the exact linked conjecture.",
      assumptionChecks: [{ subject: "finite graph", status: "pass", explanation: "The finite graph Laplacian is a positive semidefinite matrix." }],
      proofStepChecks: [{ stepId: "step-1", status: "pass", explanation: "The nonnegative quadratic form proves positive semidefiniteness and the eigenvalue bound." }],
      dependencyChecks: [], counterexampleRisks: [], issues: [], confidence: 94,
      notification: { title: "Proof validated", body: "The proposed proves relationship is now verified." }
    }});

    const provedBootstrap = await request(baseUrl, `/api/bootstrap?spaceId=${author.space.id}`, { token: author.token });
    const provedConjecture = provedBootstrap.results.find((item) => item.id === conjecture.id);
    assert.equal(provedConjecture.status, "proved");
    assert.equal(provedConjecture.provedByProofIds.includes(proof.id), true);
    assert.equal(provedBootstrap.results.find((item) => item.id === proof.id).status, "validated");
    assert.equal(provedBootstrap.edges.find((item) => item.id === provesEdge.id).verificationStatus, "verified");
    assert.equal(provedBootstrap.notifications.some((item) => item.type === "conjecture_proved" && item.entityId === conjecture.id), true);
  });
});

test("lead blueprint, accepted volunteering, scoped work, proposals, and task completion", async () => {
  await withServer(async ({ baseUrl }) => {
    const lead = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Blueprint Lead", pin: "1111" } });
    const contributor = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Scoped Contributor", pin: "2222" } });
    const observer = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Observing Member", pin: "3333" } });
    assert.equal(lead.membership.role, "lead");
    assert.equal(contributor.membership.role, "contributor");

    const initial = await request(baseUrl, `/api/bootstrap?spaceId=${lead.space.id}`, { token: lead.token });
    const root = initial.results.find((item) => item.id === "result-main");
    await requestFailure(baseUrl, "/api/results", { token: contributor.token, method: "POST", status: 403, body: { spaceId: lead.space.id, title: "Unscoped result" } });

    const task = await request(baseUrl, "/api/tasks", { token: lead.token, method: "POST", body: {
      spaceId: lead.space.id, title: "Supply a supporting spectral lemma", goal: "Produce a checked lemma that directly supports the root theorem.",
      priority: "high", targetResultId: root.id, expectedRelation: "supports"
    } });
    await request(baseUrl, `/api/tasks/${task.id}/volunteer`, { token: contributor.token, method: "POST", body: {} });
    await requestFailure(baseUrl, "/api/results", { token: contributor.token, method: "POST", status: 403, body: { spaceId: lead.space.id, taskId: task.id, title: "Premature result" } });
    let leadView = await request(baseUrl, `/api/bootstrap?spaceId=${lead.space.id}`, { token: lead.token });
    assert.deepEqual(leadView.tasks.find((item) => item.id === task.id).pendingVolunteerIds, [contributor.profile.id]);

    await request(baseUrl, `/api/tasks/${task.id}/volunteers/respond`, { token: lead.token, method: "POST", body: { profileId: contributor.profile.id, decision: "accept", role: "primary" } });
    let result = await request(baseUrl, "/api/results", { token: contributor.token, method: "POST", body: { spaceId: lead.space.id, taskId: task.id, title: "Assigned spectral lemma" } });
    result = await request(baseUrl, `/api/results/${result.id}`, { token: contributor.token, method: "PATCH", body: {
      statementLatex: "\\lambda_1(G) \\ge 0",
      hypothesesLatex: ["G \\text{ is finite}"],
      proofMarkdown: "Since the finite graph Laplacian is positive semidefinite, every eigenvalue is nonnegative. Therefore the stated spectral lower bound follows and supplies supporting evidence for the root theorem."
    } });
    const edge = await request(baseUrl, "/api/edges", { token: contributor.token, method: "POST", body: { sourceResultId: result.id, targetResultId: root.id, relation: "supports" } });
    assert.equal(edge.sourceResultId, result.id);
    const submitted = await request(baseUrl, `/api/results/${result.id}/submit`, { token: contributor.token, method: "POST", body: {} });
    const claimed = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    assert.equal(claimed.work.type, "validate_result");
    const context = await request(baseUrl, `/api/internal/work/${claimed.work.id}/context`);
    assert.equal(context.task.id, task.id);
    assert.equal(context.rootProblem.id, root.id);
    await request(baseUrl, `/api/internal/work/${claimed.work.id}/validation`, { method: "POST", body: {
      submittedRevisionId: submitted.result.submittedRevisionId,
      decision: "validated", claimRestatement: "The finite graph Laplacian has nonnegative spectrum.",
      summary: "The positive-semidefinite argument establishes the assigned supporting lemma.",
      assumptionChecks: [{ subject: "finite graph", status: "pass", explanation: "The finite Laplacian is a positive semidefinite matrix." }],
      proofStepChecks: [{ stepId: "step-1", status: "pass", explanation: "Positive semidefiniteness implies the nonnegative eigenvalue bound." }],
      dependencyChecks: [], counterexampleRisks: [], issues: [], confidence: 97,
      taskId: task.id, taskOutcome: "complete", taskRationale: "The validated output has the task's required supports edge to the root theorem.",
      notification: { title: "Codex review complete", body: "The assigned spectral lemma is Codex-validated." }
    } });
    let contributorView = await request(baseUrl, `/api/bootstrap?spaceId=${lead.space.id}`, { token: contributor.token });
    assert.equal(contributorView.tasks.find((item) => item.id === task.id).status, "done");
    assert.equal(contributorView.results.find((item) => item.id === result.id).taskId, task.id);

    const proposal = await request(baseUrl, "/api/tasks", { token: contributor.token, method: "POST", body: {
      spaceId: lead.space.id, parentTaskId: task.id, title: "Check the equality case", goal: "Determine when the supporting lower bound is attained.", priority: "exploratory", targetResultId: result.id
    } });
    assert.equal(proposal.approvalState, "proposed");
    const observerView = await request(baseUrl, `/api/bootstrap?spaceId=${lead.space.id}`, { token: observer.token });
    assert.equal(observerView.tasks.some((item) => item.id === proposal.id), false);
    leadView = await request(baseUrl, `/api/bootstrap?spaceId=${lead.space.id}`, { token: lead.token });
    assert.equal(leadView.tasks.some((item) => item.id === proposal.id), true);
    await request(baseUrl, `/api/tasks/${proposal.id}/proposal/respond`, { token: lead.token, method: "POST", body: { accept: true } });
    const publishedView = await request(baseUrl, `/api/bootstrap?spaceId=${lead.space.id}`, { token: observer.token });
    assert.equal(publishedView.tasks.find((item) => item.id === proposal.id).approvalState, "official");

    await request(baseUrl, `/api/spaces/${lead.space.id}/lead-transfer`, { token: lead.token, method: "POST", body: { profileId: observer.profile.id } });
    await request(baseUrl, `/api/spaces/${lead.space.id}/lead-transfer/respond`, { token: observer.token, method: "POST", body: { accept: true } });
    await requestFailure(baseUrl, `/api/spaces/${lead.space.id}`, { token: lead.token, method: "PATCH", status: 403, body: { name: "Unauthorized rename" } });
    const renamed = await request(baseUrl, `/api/spaces/${lead.space.id}`, { token: observer.token, method: "PATCH", body: { name: "Transferred Spectral Program" } });
    assert.equal(renamed.name, "Transferred Spectral Program");
  });
});

test("accepted counterexample work verifies refutation and completes its task", async () => {
  await withServer(async ({ baseUrl }) => {
    const lead = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Refutation Lead", pin: "4444" } });
    const contributor = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Counterexample Author", pin: "5555" } });
    let conjecture = await request(baseUrl, "/api/results", { token: lead.token, method: "POST", body: { spaceId: lead.space.id, kind: "conjecture", title: "All integers are even" } });
    conjecture = await request(baseUrl, `/api/results/${conjecture.id}`, { token: lead.token, method: "PATCH", body: { statementLatex: "\\forall n \\in \\mathbb{Z},\\; 2 \\mid n", hypothesesLatex: ["n \\in \\mathbb{Z}"] } });
    const conjectureSubmission = await request(baseUrl, `/api/results/${conjecture.id}/submit`, { token: lead.token, method: "POST", body: {} });
    const conjectureWork = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    await request(baseUrl, `/api/internal/work/${conjectureWork.work.id}/conjecture-review`, { method: "POST", body: {
      submittedRevisionId: conjectureSubmission.result.submittedRevisionId, decision: "relevant",
      summary: "This precise conjecture can be resolved by a direct counterexample.", relevanceExplanation: "It provides a bounded refutation task for the workspace.",
      relatedResultIds: [], issues: [], confidence: 99, notification: { title: "Conjecture reviewed", body: "The conjecture is ready for resolution." }
    } });

    const task = await request(baseUrl, "/api/tasks", { token: lead.token, method: "POST", body: {
      spaceId: lead.space.id, title: "Find an odd integer", goal: "Construct an integer satisfying the hypothesis but falsifying the divisibility conclusion.",
      targetResultId: conjecture.id, expectedRelation: "refutes", priority: "normal"
    } });
    await request(baseUrl, `/api/tasks/${task.id}/invite`, { token: lead.token, method: "POST", body: { profileId: contributor.profile.id } });
    await request(baseUrl, `/api/tasks/${task.id}/invitations/respond`, { token: contributor.token, method: "POST", body: { accept: true } });
    let counterexample = await request(baseUrl, "/api/results", { token: contributor.token, method: "POST", body: { spaceId: lead.space.id, taskId: task.id, kind: "counterexample", title: "The integer 1" } });
    counterexample = await request(baseUrl, `/api/results/${counterexample.id}`, { token: contributor.token, method: "PATCH", body: {
      statementLatex: "n=1", hypothesesLatex: ["1 \\in \\mathbb{Z}"],
      proofMarkdown: "Take the integer $n=1$. It satisfies the target hypothesis because it is an integer. However, there is no integer $q$ with $1=2q$, so $2$ does not divide $1$. Thus the universal conclusion fails."
    } });
    const refutesEdge = await request(baseUrl, "/api/edges", { token: contributor.token, method: "POST", body: { sourceResultId: counterexample.id, targetResultId: conjecture.id, relation: "refutes" } });
    const submission = await request(baseUrl, `/api/results/${counterexample.id}/submit`, { token: contributor.token, method: "POST", body: {} });
    const work = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    const context = await request(baseUrl, `/api/internal/work/${work.work.id}/context`);
    assert.equal(context.refutesEdge.id, refutesEdge.id);
    assert.equal(context.relationTarget.id, conjecture.id);
    await request(baseUrl, `/api/internal/work/${work.work.id}/validation`, { method: "POST", body: {
      submittedRevisionId: submission.result.submittedRevisionId, verificationEdgeId: refutesEdge.id,
      decision: "validated", claimRestatement: "The integer 1 is not divisible by 2.", summary: "The example satisfies the integer hypothesis and falsifies the universal divisibility conclusion.",
      assumptionChecks: [{ subject: "integer hypothesis", status: "pass", explanation: "One is an integer." }], proofStepChecks: [],
      counterexampleChecks: [{ subject: "construction n=1", status: "pass", explanation: "No integer q satisfies 1=2q." }],
      dependencyChecks: [], counterexampleRisks: [], issues: [], confidence: 100,
      taskId: task.id, taskOutcome: "complete", taskRationale: "The Codex-validated refutes edge is the task's expected outcome.",
      notification: { title: "Counterexample validated", body: "The refutation is now recorded." }
    } });
    const final = await request(baseUrl, `/api/bootstrap?spaceId=${lead.space.id}`, { token: contributor.token });
    assert.equal(final.results.find((item) => item.id === conjecture.id).status, "refuted");
    assert.equal(final.results.find((item) => item.id === conjecture.id).refutedByCounterexampleIds.includes(counterexample.id), true);
    assert.equal(final.edges.find((item) => item.id === refutesEdge.id).verificationStatus, "verified");
    assert.equal(final.tasks.find((item) => item.id === task.id).status, "done");
    assert.equal(final.notifications.some((item) => item.type === "validation"), true);
  });
});

test("lead drafts, reviews, publishes, and Codex-fills a timestamped current status", async () => {
  await withServer(async ({ baseUrl }) => {
    const lead = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: "spectral-gap", displayName: "Status Lead", pin: "7311" } });
    const created = await request(baseUrl, "/api/spaces", { token: lead.token, method: "POST", body: {
      name: "Status Context Program", rootTitle: "Status root conjecture", rootStatement: "A \\Longrightarrow B"
    } });
    const contributor = await request(baseUrl, "/api/join", { method: "POST", body: { inviteSlug: created.space.inviteSlug, displayName: "Status Contributor", pin: "7312" } });
    const task = await request(baseUrl, "/api/tasks", { token: lead.token, method: "POST", body: {
      spaceId: created.space.id, title: "Establish the first implication", goal: "Prove the first step toward the root conjecture.",
      priority: "high", targetResultId: created.rootResult.id, expectedRelation: "supports"
    } });
    await requestFailure(baseUrl, `/api/spaces/${created.space.id}/current-status`, { token: contributor.token, method: "PATCH", status: 403, body: { markdown: "Unauthorized status", baseDraftRevision: 0 } });

    let status = await request(baseUrl, `/api/spaces/${created.space.id}/current-status`, { token: lead.token, method: "PATCH", body: {
      markdown: "We are working on the root implication.", baseDraftRevision: 0
    } });
    assert.equal(status.draftRevision, 1);
    await request(baseUrl, `/api/spaces/${created.space.id}/current-status/review`, { token: lead.token, method: "POST", body: {} });
    let claimed = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    assert.equal(claimed.work.type, "review_current_status");
    let context = await request(baseUrl, `/api/internal/work/${claimed.work.id}/context`);
    assert.equal(context.mode, "review");
    assert.equal(context.currentStatus.draftMarkdown, "We are working on the root implication.");
    assert.equal(context.results.some((item) => item.id === created.rootResult.id && item.statementLatex === "A \\Longrightarrow B"), true);
    assert.equal(context.tasks.some((item) => item.id === task.id && item.goal.includes("first step")), true);
    assert.equal(context.timestampedHistory.every((item) => Boolean(item.at && item.summary)), true);
    assert.equal(context.linkSyntax.results.some((item) => item.href === `#result:${created.rootResult.id}`), true);
    assert.equal(context.linkSyntax.tasks.some((item) => item.href === `#task:${task.id}`), true);

    const proposedMarkdown = `The program is reducing [Status root conjecture](#result:${created.rootResult.id}) to [Establish the first implication](#task:${task.id}).\n\nThe current target is $A \\Longrightarrow B$, and the linked task remains open.`;
    await request(baseUrl, `/api/internal/work/${claimed.work.id}/current-status-review`, { method: "POST", body: {
      baseDraftRevision: context.baseDraftRevision, proposedMarkdown,
      rationale: "The revision names the exact root problem and open task and preserves their recorded state.",
      sourceRefs: [{ entityType: "result", entityId: created.rootResult.id, label: "Root conjecture" }, { entityType: "task", entityId: task.id, label: "Open task" }],
      notification: { title: "Codex status suggestion ready", body: "Codex linked the status to the root and active task." }
    } });
    let leadView = await request(baseUrl, `/api/bootstrap?spaceId=${created.space.id}`, { token: lead.token });
    assert.equal(leadView.statusSuggestions.length, 1);
    assert.equal(leadView.notifications.some((item) => item.type === "current_status_review"), true);
    const applied = await request(baseUrl, `/api/current-status-suggestions/${leadView.statusSuggestions[0].id}/respond`, { token: lead.token, method: "POST", body: { accept: true } });
    assert.equal(applied.status.draftMarkdown, proposedMarkdown);
    const firstPublication = await request(baseUrl, `/api/spaces/${created.space.id}/current-status/publish`, { token: lead.token, method: "POST", body: { baseDraftRevision: applied.status.draftRevision } });
    assert.equal(firstPublication.status.version, 1);
    assert.equal(firstPublication.history.markdown, proposedMarkdown);

    const exportResponse = await fetch(`${baseUrl}/api/spaces/${created.space.id}/current-status/export`, { headers: { Authorization: `Bearer ${lead.token}` } });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get("content-type"), /^text\/markdown/);
    assert.match(exportResponse.headers.get("content-disposition"), /^attachment; filename="mathhive-status-context-program-codex-context-.+\.md"$/);
    const exportedMarkdown = await exportResponse.text();
    assert.match(exportedMarkdown, /^# MathHive Codex Context: Status Context Program/);
    assert.match(exportedMarkdown, /## Current Status/);
    assert.match(exportedMarkdown, /### Draft/);
    assert.match(exportedMarkdown, /### Published/);
    assert.match(exportedMarkdown, /## Complete Codex Context Payload/);
    assert.match(exportedMarkdown, /The current target is \$A \\Longrightarrow B\$/);
    const payloadMarker = "## Complete Codex Context Payload\n\n";
    const payloadHeading = exportedMarkdown.lastIndexOf(payloadMarker);
    const payloadStart = exportedMarkdown.indexOf("\n    {", payloadHeading) + 1;
    const indentedPayload = exportedMarkdown.slice(payloadStart).trimEnd();
    const exportedContext = JSON.parse(indentedPayload.split("\n").map((line) => line.slice(4)).join("\n"));
    assert.equal(exportedContext.currentStatus.draftMarkdown, proposedMarkdown);
    assert.equal(exportedContext.currentStatus.publishedMarkdown, proposedMarkdown);
    assert.equal(exportedContext.results.some((item) => item.id === created.rootResult.id && item.statementLatex === "A \\Longrightarrow B"), true);
    assert.equal(exportedContext.tasks.some((item) => item.id === task.id), true);
    assert.equal(exportedContext.statusHistory.some((item) => item.id === firstPublication.history.id), true);
    assert.equal(exportedContext.timestampedHistory.some((item) => item.type === "status_publication"), true);
    assert.equal(exportedMarkdown.includes("pinHash"), false);
    const memberExport = await fetch(`${baseUrl}/api/spaces/${created.space.id}/current-status/export`, { headers: { Authorization: `Bearer ${contributor.token}` } });
    assert.equal(memberExport.status, 200);
    const memberMarkdown = await memberExport.text();
    assert.match(memberMarkdown, /## Current Status/);
    assert.match(memberMarkdown, /The current target is \$A \\Longrightarrow B\$/);

    let contributorView = await request(baseUrl, `/api/bootstrap?spaceId=${created.space.id}`, { token: contributor.token });
    assert.equal(contributorView.currentStatus.publishedMarkdown, proposedMarkdown);
    assert.equal("draftMarkdown" in contributorView.currentStatus, false);
    assert.equal(contributorView.statusHistory.length, 1);
    assert.equal(contributorView.statusSuggestions.length, 0);
    assert.equal(contributorView.notifications.some((item) => item.type === "current_status_published"), true);

    await request(baseUrl, `/api/spaces/${created.space.id}/current-status/fill`, { token: lead.token, method: "POST", body: {} });
    claimed = await request(baseUrl, "/api/internal/work/next", { method: "POST", body: {} });
    assert.equal(claimed.work.type, "fill_current_status");
    context = await request(baseUrl, `/api/internal/work/${claimed.work.id}/context`);
    assert.equal(context.statusHistory.length, 1);
    assert.equal(context.statusHistory[0].publishedAt, firstPublication.history.publishedAt);
    const filledMarkdown = `The root remains $A \\Longrightarrow B$. [Establish the first implication](#task:${task.id}) is still the immediate open priority.`;
    const filled = await request(baseUrl, `/api/internal/work/${claimed.work.id}/current-status-draft`, { method: "POST", body: {
      baseDraftRevision: context.baseDraftRevision, markdown: filledMarkdown,
      summary: "Updated the note from the complete workspace and its published history.",
      sourceRefs: [{ entityType: "result", entityId: created.rootResult.id }, { entityType: "task", entityId: task.id }],
      notification: { title: "Current status draft ready", body: "Codex filled the status from the complete workspace context." }
    } });
    assert.equal(filled.stale, false);
    assert.equal(filled.status.draftMarkdown, filledMarkdown);
    status = filled.status;
    const secondPublication = await request(baseUrl, `/api/spaces/${created.space.id}/current-status/publish`, { token: lead.token, method: "POST", body: { baseDraftRevision: status.draftRevision } });
    assert.equal(secondPublication.status.version, 2);
    contributorView = await request(baseUrl, `/api/bootstrap?spaceId=${created.space.id}`, { token: contributor.token });
    assert.deepEqual(contributorView.statusHistory.map((item) => item.version), [2, 1]);
  });
});
