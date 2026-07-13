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
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const ada = await firstContext.newPage();
  const emmy = await secondContext.newPage();
  try {
    await join(ada, "Ada Browser", "1234");
    await join(emmy, "Emmy Browser", "5678");
    await expect(ada.locator("#onlineCount")).toHaveText("2 online");

    await ada.getByRole("button", { name: "New result" }).click();
    await ada.locator("#resultTitle").fill("Browser equality lemma");
    await ada.locator("#resultStatement").fill("x = x");
    await ada.locator("#resultHypotheses").fill("x \\in X");
    await ada.locator("#resultProof").fill("Assume that $x$ is an object of $X$. Since equality is reflexive, $x=x$ follows immediately. Therefore the displayed statement holds for every selected object.");
    await ada.locator("#resultTags").fill("equality, foundations");
    await expect(ada.locator("#statementPreview .katex")).toBeVisible();
    await expect(ada.locator("#saveStatus")).toContainText("draft");
    await expect(emmy.getByText("Browser equality lemma", { exact: true })).toBeVisible();

    const resultId = await ada.evaluate(async () => {
      const token = localStorage.getItem("mathhive.token");
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
      relevantResultIds: [], notification: { title: "Draft coaching ready", body: "The reflexivity proof is sound." }
    }});
    await expect(ada.locator("#codexFeedback")).toContainText("reflexivity step establishes");

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
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});
