import { test, expect } from "@playwright/test";

async function join(page, name, pin) {
  await page.goto("/join/spectral-gap");
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("PIN or small password").fill(pin);
  await page.getByRole("button", { name: "Join workspace" }).click();
  await expect(page.locator("#joinGate")).toBeHidden();
  await expect(page.locator("#workspaceTitle")).toHaveText("Spectral Gap Program");
}

test("two mathematicians collaborate, receive MCP-style coaching, and validate a revision", async ({ browser, request }) => {
  const context = await browser.newContext();
  const ada = await context.newPage();
  const emmy = await context.newPage();
  try {
    await join(ada, "Ada Browser", "1234");
    await join(emmy, "Emmy Browser", "5678");
    await expect(ada.locator("#onlineCount")).toHaveText("2 online");
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
    await expect(emmy.getByText("Browser equality lemma", { exact: true })).toBeVisible();

    const resultId = await ada.evaluate(async () => {
      const token = sessionStorage.getItem("mathhive.token");
      const bootstrap = await fetch("/api/bootstrap", { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json());
      return bootstrap.results.find((item) => item.title === "Browser equality lemma").id;
    });

    await emmy.locator(`[data-node-id="${resultId}"] [data-star-id]`).click();
    await expect(ada.locator(`[data-node-id="${resultId}"] .star-button`)).toHaveClass(/starred/);

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
    await expect(ada.locator("#editorStatus")).toContainText("Validated");
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
  } finally {
    await context.close();
  }
});

test("a conjecture can be authored without a proof and receives a relevance review", async ({ browser, request }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await join(page, "Conjecture Browser", "4321");
    await page.getByRole("button", { name: "More contribution types" }).click();
    await page.getByRole("menuitem", { name: /New conjecture/ }).click();
    await expect(page.locator('input[name="resultKind"][value="conjecture"]')).toBeChecked();
    await expect(page.locator("#feedbackTitle")).toHaveText("Conjecture relevance check");
    await expect(page.locator("#submitResultLabel")).toHaveText("Submit conjecture for review");
    await expect(page.locator("#resultProof")).not.toHaveAttribute("required", "");

    await page.locator("#resultTitle").fill("LCM interval conjecture");
    await page.locator("#resultStatement").fill(String.raw`M(n,k) \neq M(m,k)`);
    await page.locator("#resultHypotheses").fill("n,k,m \\in \\mathbb{Z}_{\\ge 1}\nm \\ge n+k");
    await page.locator("#resultDependency").selectOption("result-main");
    await page.getByRole("button", { name: "Add relation" }).click();
    await page.getByRole("button", { name: "Submit conjecture for review" }).click();
    await expect(page.locator("#editorStatus")).toContainText("Pending review");

    const claimed = await (await request.post("/api/internal/work/next", { data: {} })).json();
    expect(claimed.work.type).toBe("review_conjecture");
    const workContext = await (await request.get(`/api/internal/work/${claimed.work.id}/context`)).json();
    expect(workContext.relatedCandidates.some((item) => item.id === "result-main")).toBe(true);
    expect(workContext.edges.some((edge) => edge.sourceResultId === "result-main" && edge.targetResultId === workContext.result.id)).toBe(true);
    await request.post(`/api/internal/work/${claimed.work.id}/conjecture-review`, { data: {
      submittedRevisionId: workContext.result.submittedRevisionId,
      decision: "relevant",
      summary: "This conjecture directly addresses the theorem space's root question.",
      relevanceExplanation: "It is linked to Main Theorem and proposes a concrete number-theoretic obstruction.",
      relatedResultIds: ["result-main"], issues: [], confidence: 93,
      notification: { title: "Conjecture is relevant", body: "Codex linked it to Main Theorem." }
    }});
    await expect(page.locator("#editorStatus")).toContainText("Conjecture · Relevant");
    await expect(page.locator("#codexFeedback")).toContainText("Conjecture relevance: relevant");
    await expect(page.locator("#codexFeedback")).toContainText("Related: Main Theorem");
    await expect(page.locator("#notificationsList")).toContainText("Conjecture is relevant");
    await page.locator("#closeEditor").click();
    const node = page.locator(".result-node.kind-conjecture").filter({ hasText: "LCM interval conjecture" });
    await expect(node.locator(".kind-pill")).toHaveText(/Conjecture/);
    await expect(node.locator(".status-pill")).toHaveText("Relevant");
  } finally {
    await context.close();
  }
});
