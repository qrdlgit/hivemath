import { test, expect } from "@playwright/test";

async function join(page, name, pin, slug = "spectral-gap") {
  await page.goto(`/join/${slug}`);
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("PIN or small password").fill(pin);
  await page.getByRole("button", { name: "Join workspace" }).click();
  await expect(page.locator("#joinGate")).toBeHidden();
  await expect(page.locator("#workspaceTitle")).toHaveText("Spectral Gap Program");
}

async function createSpace(page, name, rootTitle = "Root problem", rootStatement = "x=x") {
  const payload = await page.evaluate(async ({ name, rootTitle, rootStatement }) => {
    const token = sessionStorage.getItem("mathhive.token");
    return fetch("/api/spaces", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, rootTitle, rootStatement }) }).then((response) => response.json());
  }, { name, rootTitle, rootStatement });
  await page.goto(`/join/${payload.space.inviteSlug}`);
  await expect(page.locator("#workspaceTitle")).toHaveText(name);
  return payload;
}

async function emptyCanvasPoint(page) {
  return page.locator("#graphViewport").evaluate((viewport) => {
    const rect = viewport.getBoundingClientRect();
    for (let y = 90; y < rect.height - 70; y += 45) {
      for (let x = 40; x < rect.width - 40; x += 55) {
        const element = document.elementFromPoint(rect.left + x, rect.top + y);
        if (!element?.closest(".result-node, button, .minimap, .dependency-legend")) return { x: rect.left + x, y: rect.top + y };
      }
    }
    throw new Error("No empty canvas point found");
  });
}

test("two mathematicians collaborate, receive MCP-style coaching, and validate a revision", async ({ browser, request }, testInfo) => {
  const context = await browser.newContext();
  const ada = await context.newPage();
  const emmy = await context.newPage();
  try {
    await join(ada, "Ada Browser", "1234");
    await join(emmy, "Emmy Browser", "5678");
    await expect(ada.locator("#onlineCount")).toHaveText("2 online");
    const pointerPoint = await emptyCanvasPoint(ada);
    await ada.mouse.move(pointerPoint.x, pointerPoint.y);
    await ada.mouse.down();
    await expect(ada.locator("#pointerPlacement")).toBeVisible();
    await ada.screenshot({ path: testInfo.outputPath("work-pointer-dialog.png"), fullPage: true });
    await expect(emmy.locator(".live-cursor").filter({ hasText: "Ada Browser" })).toHaveCount(0);
    await ada.mouse.up();
    await ada.getByRole("button", { name: "Move my pointer here" }).click();
    await expect(ada.locator(".live-cursor").filter({ hasText: "Ada Browser" })).toBeVisible();
    await expect(emmy.locator(".live-cursor").filter({ hasText: "Ada Browser" })).toBeVisible();

    const noether = await context.newPage();
    await join(noether, "Noether Browser", "9012");
    await expect(noether.locator(".live-cursor").filter({ hasText: "Ada Browser" })).toBeVisible();
    await noether.close();
    await expect(ada.locator("#onlineCount")).toHaveText("2 online");

    const dragPoint = await emptyCanvasPoint(ada);
    await ada.mouse.move(dragPoint.x, dragPoint.y);
    await ada.mouse.down();
    await expect(ada.locator("#pointerPlacement")).toBeVisible();
    await ada.mouse.move(dragPoint.x + 18, dragPoint.y + 12);
    await expect(ada.locator("#pointerPlacement")).toBeHidden();
    await ada.mouse.up();
    await ada.locator("#workspaceNameButton").click();
    await ada.getByLabel("Theorem space name").fill("Spectral Collaboration Lab");
    await ada.getByLabel("Theorem space name").press("Enter");
    await expect(ada.locator("#workspaceTitle")).toHaveText("Spectral Collaboration Lab");
    await expect(emmy.locator("#workspaceTitle")).toHaveText("Spectral Collaboration Lab");
    await ada.locator("#workspaceNameButton").click();
    await ada.getByLabel("Theorem space name").fill("Spectral Gap Program");
    await ada.getByLabel("Theorem space name").press("Enter");
    await expect(emmy.locator("#workspaceTitle")).toHaveText("Spectral Gap Program");

    await ada.getByRole("button", { name: "New result" }).click();
    await ada.locator("#resultTitle").fill("Browser equality lemma");
    await ada.locator("#resultStatement").fill(String.raw`Let $M(n,k)=[n+1,\ldots,n+k]$
be the least common multiple of $\{n+1,\ldots,n+k\}$.
Is it true that for all $m\geq n+k$\[M(n,k) \neq M(m,k)?\]`);
    await expect(ada.locator("#statementPreview .katex")).toHaveCount(4);
    await expect(ada.locator("#statementPreview")).not.toContainText(String.raw`\[`);
    await expect(ada.locator("#saveStatus")).toContainText("draft");
    const expandedNode = ada.locator(".result-node").filter({ hasText: "Browser equality lemma" });
    await expect(expandedNode).toBeVisible();
    const expandedBounds = await expandedNode.boundingBox();
    expect(expandedBounds.width).toBeGreaterThan(188);
    expect(expandedBounds.width).toBeLessThan(360);
    const contentFits = await expandedNode.evaluate((node) => {
      const formula = node.querySelector(".formula");
      return node.scrollHeight <= node.clientHeight + 1 && formula.scrollHeight <= formula.clientHeight + 1;
    });
    expect(contentFits).toBe(true);
    await ada.locator("#resultStatement").fill("x = x");
    await ada.locator("#resultHypotheses").fill("x \\in X\nX \\neq \\varnothing");
    await ada.locator("#resultProof").fill("Assume that $x$ is an object of $X$. Since equality is reflexive, $x=x$ follows immediately. Therefore the displayed statement holds for every selected object.");
    await ada.locator("#resultTags").fill("equality, foundations");
    await expect(ada.locator("#statementPreview .katex")).toBeVisible();
    await expect(ada.locator("#hypothesesPreview .katex")).toHaveCount(2);
    const pairedFieldsAlign = await ada.locator(".math-field-grid").evaluateAll((grids) => grids.every((grid) => {
      const input = grid.querySelector("textarea");
      const preview = grid.querySelector(".math-preview, .proof-preview");
      const inputBounds = input.getBoundingClientRect();
      const previewBounds = preview.getBoundingClientRect();
      return Math.abs(inputBounds.top - previewBounds.top) <= 1 && Math.abs(inputBounds.bottom - previewBounds.bottom) <= 1;
    }));
    expect(pairedFieldsAlign).toBe(true);
    await expect(ada.locator("#saveStatus")).toContainText("draft");
    await expect(emmy.locator("#nodesLayer").getByText("Browser equality lemma", { exact: true })).toBeVisible();

    const resultId = await ada.evaluate(async () => {
      const token = sessionStorage.getItem("mathhive.token");
      const bootstrap = await fetch("/api/bootstrap", { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json());
      return bootstrap.results.find((item) => item.title === "Browser equality lemma").id;
    });

    await emmy.locator(`[data-node-id="${resultId}"] [data-star-id]`).click();
    await expect(emmy.locator(`[data-node-id="${resultId}"] .star-button`)).toHaveClass(/starred/);
    await expect(ada.locator(`[data-node-id="${resultId}"] .star-button`)).not.toHaveClass(/starred/);

    await ada.getByRole("button", { name: "Ask Codex now" }).click();
    await expect.poll(async () => (await (await request.get("/api/internal/work/count")).json()).pendingWorkCount).toBe(1);
    const nextResponse = await request.post("/api/internal/work/next", { data: {} });
    const next = await nextResponse.json();
    const contextResponse = await request.get(`/api/internal/work/${next.work.id}/context`);
    const workContext = await contextResponse.json();
    await request.post(`/api/internal/work/${next.work.id}/draft-review`, { data: {
      draftRevision: workContext.result.draftRevision,
      summary: "The reflexivity step establishes the claim. Keep the universal scope explicit.",
      issues: [{ severity: "info", location: "hypotheses", message: "The claim does not require extra structure on X." }],
      relevantResultIds: [],
      relevanceAssessment: { verdict: "relevant", explanation: "This result supplies a foundational equality step used by the active branch.", relatedResultIds: [] },
      notification: { title: "Draft coaching ready", body: "The reflexivity proof is sound." }
    }});
    await expect(ada.locator("#codexFeedback")).toContainText("reflexivity step establishes");
    await expect(ada.locator("#codexFeedback")).toContainText("Relevance: relevant");

    await ada.getByRole("button", { name: "Submit for AI validation" }).click();
    await expect(ada.locator("#editorStatus")).toContainText("Pending review");
    await expect.poll(async () => (await (await request.get("/api/internal/work/count")).json()).pendingWorkCount).toBe(1);
    const validationNext = await (await request.post("/api/internal/work/next", { data: {} })).json();
    const validationContext = await (await request.get(`/api/internal/work/${validationNext.work.id}/context`)).json();
    await request.post(`/api/internal/work/${validationNext.work.id}/validation`, { data: {
      submittedRevisionId: validationContext.result.submittedRevisionId,
      decision: "validated", claimRestatement: "Every object equals itself.",
      summary: "Reflexivity proves the submitted statement under no additional mathematical assumptions.",
      assumptionChecks: [{ subject: "object x", status: "pass", explanation: "Equality reflexivity applies to every object." }],
      proofStepChecks: [{ stepId: "step-1", status: "pass", explanation: "The proof invokes reflexivity directly." }],
      dependencyChecks: [], counterexampleRisks: [], issues: [], confidence: 99,
      notification: { title: "Result validated", body: "The reflexivity argument is valid." }
    }});
    await expect(ada.locator("#editorStatus")).toContainText("Codex-validated");
    await expect(ada.locator("#notificationsList")).toContainText("Result validated");
    await ada.getByRole("button", { name: /History/ }).click();
    await expect(ada.locator("#revisionList")).toContainText("Revision 1");

    await expect.poll(async () => (await (await request.get("/api/internal/work/count")).json()).pendingWorkCount).toBe(1);
    const integrationNext = await (await request.post("/api/internal/work/next", { data: {} })).json();
    expect(integrationNext.work.type).toBe("suggest_integrations");
    await request.post(`/api/internal/work/${integrationNext.work.id}/integrations`, { data: {
      suggestions: [{ type: "integration", title: "Connect the validated equality result", explanation: "This result can now be used by other active proofs.", confidence: 98, sourceResultIds: [resultId], targetResultIds: [resultId], audienceUserIds: [], proposedChanges: [], evidence: ["The result has a completed validation review."] }],
      notifications: []
    }});
    await ada.locator("#closeEditor").click();
    await expect(ada.locator("#suggestionsList")).toContainText("Connect the validated equality result");
    await ada.getByRole("button", { name: "Integrate" }).click();
    await expect(ada.locator("#suggestionsList")).not.toContainText("Connect the validated equality result");
    await ada.getByRole("button", { name: "Your profile" }).click();
    await expect(ada.locator("#profilePopover")).toContainText("Ada Browser");
    await ada.getByRole("menuitem", { name: "Log out" }).click();
    await expect(ada.locator("#joinGate")).toBeVisible();
    expect(await ada.evaluate(() => sessionStorage.getItem("mathhive.token"))).toBeNull();
    await expect(emmy.locator(".live-cursor").filter({ hasText: "Ada Browser" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a conjecture and its proof complete the verified proves lifecycle", async ({ browser, request }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await join(page, "Conjecture Browser", "4321");
    const isolated = await createSpace(page, "LCM Browser Program", "LCM root problem", String.raw`M(n,k) \neq M(m,k)`);
    const rootId = isolated.rootResult.id;
    await page.getByRole("button", { name: "More contribution types" }).click();
    await page.getByRole("menuitem", { name: /New conjecture/ }).click();
    await expect(page.locator('input[name="resultKind"][value="conjecture"]')).toBeChecked();
    await expect(page.locator("#feedbackTitle")).toHaveText("Conjecture relevance check");
    await expect(page.locator("#submitResultLabel")).toHaveText("Submit conjecture for review");
    await expect(page.locator("#resultProof")).not.toHaveAttribute("required", "");

    await page.locator("#resultTitle").fill("LCM conjecture for k = 1");
    await page.locator("#resultStatement").fill(String.raw`M(n,1) \neq M(m,1)`);
    await page.locator("#resultHypotheses").fill("n,m \\in \\mathbb{Z}_{\\ge 1}\nm \\ge n+1\nM(a,1)=a+1");
    await page.locator("#resultDependency").selectOption(rootId);
    await page.getByRole("button", { name: "Add relation" }).click();
    await page.getByRole("button", { name: "Submit conjecture for review" }).click();
    await expect(page.locator("#editorStatus")).toContainText("Pending review");

    const claimed = await (await request.post("/api/internal/work/next", { data: {} })).json();
    expect(claimed.work.type).toBe("review_conjecture");
    const workContext = await (await request.get(`/api/internal/work/${claimed.work.id}/context`)).json();
    expect(workContext.relatedCandidates.some((item) => item.id === rootId)).toBe(true);
    expect(workContext.edges.some((edge) => edge.sourceResultId === workContext.result.id && edge.targetResultId === rootId)).toBe(true);
    await request.post(`/api/internal/work/${claimed.work.id}/conjecture-review`, { data: {
      submittedRevisionId: workContext.result.submittedRevisionId,
      decision: "relevant",
      summary: "This conjecture isolates a concrete special case of the theorem space's root question.",
      relevanceExplanation: "The k=1 case is a bounded specialization that can anchor later proof branches.",
      relatedResultIds: [rootId], issues: [], confidence: 93,
      notification: { title: "Conjecture is relevant", body: "Codex linked it to the LCM root problem." }
    }});
    await expect(page.locator("#editorStatus")).toContainText("Conjecture · Relevant");
    await expect(page.locator("#codexFeedback")).toContainText("Conjecture relevance: relevant");
    await expect(page.locator("#codexFeedback")).toContainText("Related: LCM root problem");
    await expect(page.locator("#notificationsList")).toContainText("Conjecture is relevant");
    await page.locator("#closeEditor").click();
    const node = page.locator(".result-node.kind-conjecture").filter({ hasText: "LCM conjecture for k = 1" });
    await expect(node.locator(".kind-pill")).toHaveText(/Conjecture/);
    await expect(node.locator(".status-pill")).toHaveText("Relevant");

    await page.getByRole("button", { name: "More contribution types" }).click();
    await page.getByRole("menuitem", { name: /New proof/ }).click();
    await expect(page.locator('input[name="resultKind"][value="proof"]')).toBeChecked();
    await expect(page.locator("#feedbackTitle")).toHaveText("Proof verification");
    await expect(page.locator("#submitResultLabel")).toHaveText("Submit proof for validation");
    await expect(page.locator("#resultRelation")).toHaveValue("proves");
    await expect(page.locator("#resultRelation")).toBeDisabled();
    await page.locator("#resultTitle").fill("Proof of the k = 1 case");
    await page.locator("#resultDependency").selectOption(workContext.result.id);
    await expect(page.locator("#resultStatement")).toHaveValue(String.raw`M(n,1) \neq M(m,1)`);
    await page.locator("#resultProof").fill("For $k=1$, the interval contains one number, so $M(n,1)=n+1$ and $M(m,1)=m+1$. Since $m\\ge n+1$, we have $m+1>n+1$. Therefore $M(m,1)>M(n,1)$, which proves the linked conjecture.");
    await page.getByRole("button", { name: "Add relation" }).click();
    await expect(page.locator(".edge-label.proves.proposed")).toHaveText("proves?");
    await page.getByRole("button", { name: "Submit proof for validation" }).click();
    await expect(page.locator("#editorStatus")).toContainText("Proof · Pending review");

    const proofWork = await (await request.post("/api/internal/work/next", { data: {} })).json();
    expect(proofWork.work.type).toBe("validate_result");
    const proofContext = await (await request.get(`/api/internal/work/${proofWork.work.id}/context`)).json();
    expect(proofContext.result.kind).toBe("proof");
    expect(proofContext.proofTarget.id).toBe(workContext.result.id);
    expect(proofContext.provesEdge.verificationStatus).toBe("proposed");
    await request.post(`/api/internal/work/${proofWork.work.id}/validation`, { data: {
      submittedRevisionId: proofContext.result.submittedRevisionId,
      provesEdgeId: proofContext.provesEdge.id,
      decision: "validated",
      claimRestatement: "For k=1 and m at least n+1, the two one-term interval LCMs differ.",
      summary: "The strict inequality between m+1 and n+1 proves the exact linked conjecture.",
      assumptionChecks: [{ subject: "m at least n+1", status: "pass", explanation: "This gives m+1 greater than n+1." }],
      proofStepChecks: [{ stepId: "step-1", status: "pass", explanation: "The one-term LCM identities and strict inequality establish the claim." }],
      dependencyChecks: [], counterexampleRisks: [], issues: [], confidence: 99,
      notification: { title: "Proof validated", body: "The k=1 proof is valid and its proves edge is verified." }
    }});
    await expect(page.locator("#editorStatus")).toContainText("Proof · Codex-validated");
    await expect(page.locator("#notificationsList")).toContainText("Conjecture proved");
    await page.locator("#closeEditor").click();
    await expect(node.locator(".status-pill")).toHaveText("Proved");
    const proofNode = page.locator(".result-node.kind-proof").filter({ hasText: "Proof of the k = 1 case" });
    await expect(proofNode.locator(".status-pill")).toHaveText("Codex-validated");
    await expect(page.locator(".edge-label.proves.verified")).toHaveText("proves");
    await page.screenshot({ path: testInfo.outputPath("verified-proof-graph.png"), fullPage: true });
  } finally {
    await context.close();
  }
});

test("lead publishes official work and an accepted volunteer contributes within scope", async ({ browser }) => {
  const leadContext = await browser.newContext();
  const contributorContext = await browser.newContext();
  const lead = await leadContext.newPage();
  const contributor = await contributorContext.newPage();
  try {
    await join(lead, "Delegation Lead", "6101");
    const created = await createSpace(lead, "Delegated Number Theory", "Root divisibility question", String.raw`a \mid b`);
    await join(contributor, "Delegated Contributor", "6102", created.space.inviteSlug);

    await contributor.getByRole("button", { name: "New result" }).click();
    await expect(contributor.locator("#toastRegion")).toContainText("wait for lead acceptance");
    await expect(lead.locator(".result-node.root-problem")).toContainText("Root divisibility question");

    await lead.getByRole("button", { name: "Add official task" }).click();
    await lead.getByLabel("Task title").fill("Prove the first divisibility case");
    await lead.getByLabel("Mathematical goal").fill("Produce a complete checked argument for the first case of the root divisibility question.");
    await lead.getByLabel("Target node").selectOption(created.rootResult.id);
    await lead.getByLabel("Expected outcome").selectOption("supports");
    await lead.locator("#taskModal").getByRole("button", { name: "Add official task", exact: true }).click();
    const contributorTask = contributor.locator(".task-row").filter({ hasText: "Prove the first divisibility case" });
    await expect(contributorTask).toBeVisible();
    await contributorTask.getByRole("button", { name: "Volunteer" }).click();
    await expect(contributorTask).toContainText("Volunteer request pending");

    const leadTask = lead.locator(".task-row").filter({ hasText: "Prove the first divisibility case" });
    await expect(leadTask).toContainText("Delegated Contributor");
    await leadTask.getByRole("button", { name: "Primary" }).click();
    await expect(contributorTask).toContainText("Delegated Contributor");
    await contributorTask.getByRole("button", { name: /Start contribution/ }).click();
    await expect(contributor.locator("#resultTask")).toHaveValue(/.+/);
    await contributor.locator("#resultTitle").fill("First divisibility case");
    await contributor.locator("#resultStatement").fill(String.raw`1 \mid b`);
    await contributor.locator("#resultHypotheses").fill(String.raw`b \in \mathbb{Z}`);
    await contributor.locator("#resultProof").fill("Since $b$ is an integer, we have $b=1\cdot b$. Therefore the integer $1$ divides $b$, which establishes the assigned first divisibility case.");
    await expect(contributor.locator("#saveStatus")).toContainText("draft");
    await contributor.locator("#closeEditor").click();

    await contributorTask.getByRole("button", { name: "Propose subtask" }).click();
    await contributor.getByLabel("Task title").fill("Check the negative case");
    await contributor.getByLabel("Mathematical goal").fill("Determine how the argument changes when the target integer is negative.");
    await contributor.getByRole("button", { name: "Send proposal" }).click();
    const proposal = lead.locator(".task-row").filter({ hasText: "Check the negative case" });
    await expect(proposal).toContainText("Proposed");
    await proposal.getByRole("button", { name: "Approve" }).click();
    await expect(contributor.locator(".task-row").filter({ hasText: "Check the negative case" })).toContainText("Open");
  } finally {
    await leadContext.close();
    await contributorContext.close();
  }
});
