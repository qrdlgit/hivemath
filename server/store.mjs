import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const PRIORITY = {
  validate_result: 100,
  suggest_integrations: 70,
  review_draft_manual: 30,
  review_draft: 10
};

const EDITABLE_FIELDS = new Set([
  "title", "statementLatex", "hypothesesLatex", "proofMarkdown", "tags",
  "dependencyIds", "citation", "bibtex", "x", "y"
]);

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const normalizeName = (value) => String(value || "").trim().toLocaleLowerCase();
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const contentLength = (result) => [
  result.title,
  result.statementLatex,
  ...(result.hypothesesLatex || []),
  result.proofMarkdown
].join(" ").replace(/\s/g, "").length;

export class StoreError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class MathHiveStore extends EventEmitter {
  constructor({ rootDir, storeFile = "data/store.json", seedFile = "data/seed.json" }) {
    super();
    this.rootDir = rootDir;
    this.storePath = path.resolve(rootDir, storeFile);
    this.seedPath = path.resolve(rootDir, seedFile);
    this.data = null;
    this.writeChain = Promise.resolve();
    this.draftTimers = new Map();
  }

  async init({ reset = false } = {}) {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    try {
      if (reset) throw new Error("reset");
      this.data = JSON.parse(await readFile(this.storePath, "utf8"));
    } catch {
      this.data = JSON.parse(await readFile(this.seedPath, "utf8"));
      this.#hydrateSeedRevisions();
      await this.#save();
    }
    this.#normalizeData();
    return this;
  }

  #normalizeData() {
    const arrays = ["profiles", "sessions", "spaces", "results", "revisions", "draftFeedback", "edges", "reviews", "comments", "suggestions", "notifications", "activity", "workQueue"];
    for (const key of arrays) this.data[key] ||= [];
    this.data.storeRevision ||= 0;
    this.data.agentStatus ||= { state: "offline", currentWorkType: null, updatedAt: now() };
  }

  #hydrateSeedRevisions() {
    this.data.revisions ||= [];
    for (const result of this.data.results || []) {
      if (!result.submittedRevisionId) continue;
      if (this.data.revisions.some((item) => item.id === result.submittedRevisionId)) continue;
      this.data.revisions.push({
        id: result.submittedRevisionId,
        resultId: result.id,
        revisionNumber: result.version || 1,
        reason: result.status === "validated" ? "validated" : "submitted",
        authorId: result.createdBy,
        status: result.status,
        snapshot: clone(result),
        createdAt: result.updatedAt || now()
      });
    }
  }

  async reset() {
    this.data = JSON.parse(await readFile(this.seedPath, "utf8"));
    this.#hydrateSeedRevisions();
    this.#normalizeData();
    await this.#save();
    return clone(this.data);
  }

  async #save() {
    const temp = `${this.storePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(temp, this.storePath);
  }

  async mutate(fn) {
    let output;
    this.writeChain = this.writeChain.then(async () => {
      const mutation = await fn(this.data) || {};
      this.data.storeRevision += 1;
      await this.#save();
      output = mutation.result;
      for (const event of mutation.events || []) {
        this.emit("event", { ...event, storeRevision: this.data.storeRevision });
      }
    });
    await this.writeChain;
    return clone(output);
  }

  snapshot() {
    return clone(this.data);
  }

  getSpace(idOrSlug) {
    return this.data.spaces.find((space) => space.id === idOrSlug || space.inviteSlug === idOrSlug);
  }

  getResult(id) {
    return this.data.results.find((result) => result.id === id);
  }

  publicProfile(profile) {
    if (!profile) return null;
    const { pinSalt, pinHash, ...safe } = profile;
    return safe;
  }

  async join({ inviteSlug, displayName, pin, color }) {
    const space = this.getSpace(inviteSlug);
    if (!space) throw new StoreError("space_not_found", "This theorem space does not exist.", 404);
    const name = String(displayName || "").trim();
    if (name.length < 2 || name.length > 40) throw new StoreError("invalid_name", "Use a name between 2 and 40 characters.");
    if (String(pin || "").length < 4 || String(pin || "").length > 12) throw new StoreError("invalid_pin", "Use a PIN or password between 4 and 12 characters.");

    const normalizedName = normalizeName(name);
    const token = randomBytes(32).toString("base64url");
    const joined = await this.mutate((data) => {
      let profile = data.profiles.find((item) => item.normalizedName === normalizedName);
      if (profile) {
        const supplied = scryptSync(String(pin), profile.pinSalt, 32);
        const expected = Buffer.from(profile.pinHash, "hex");
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          throw new StoreError("wrong_pin", "That name already exists with a different PIN.", 401);
        }
        profile.lastSeenAt = now();
        profile.activeSpaceId = space.id;
        if (color) profile.color = color;
      } else {
        const salt = randomBytes(16).toString("hex");
        profile = {
          id: randomUUID(),
          displayName: name,
          normalizedName,
          pinSalt: salt,
          pinHash: scryptSync(String(pin), salt, 32).toString("hex"),
          initials: name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(""),
          color: color || "#3178ed",
          interestTags: [],
          activeSpaceId: space.id,
          activeResultId: null,
          createdAt: now(),
          lastSeenAt: now()
        };
        data.profiles.push(profile);
      }
      data.sessions.push({ id: randomUUID(), profileId: profile.id, tokenHash: hashToken(token), createdAt: now(), lastSeenAt: now() });
      return {
        result: { token, profile: this.publicProfile(profile), space },
        events: [{ type: "profile.upsert", spaceId: space.id, entity: this.publicProfile(profile) }]
      };
    });
    return joined;
  }

  getSession(token) {
    if (!token) return null;
    const session = this.data.sessions.find((item) => item.tokenHash === hashToken(token));
    if (!session) return null;
    const profile = this.data.profiles.find((item) => item.id === session.profileId);
    return profile ? { session, profile } : null;
  }

  requireSession(token) {
    const auth = this.getSession(token);
    if (!auth) throw new StoreError("unauthorized", "Join the workspace to continue.", 401);
    return auth;
  }

  async logout(token) {
    const { session } = this.requireSession(token);
    return this.mutate((data) => {
      data.sessions = data.sessions.filter((item) => item.id !== session.id);
      return { result: { ok: true }, events: [] };
    });
  }

  async renameSpace(token, spaceId, name) {
    const { profile } = this.requireSession(token);
    const nextName = String(name || "").trim();
    if (nextName.length < 2 || nextName.length > 80) throw new StoreError("invalid_space_name", "Use a theorem space name between 2 and 80 characters.");
    return this.mutate((data) => {
      const space = data.spaces.find((item) => item.id === spaceId);
      if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
      const previousName = space.name;
      space.name = nextName;
      space.updatedAt = now();
      const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "space.renamed", entityType: "space", entityId: space.id, summary: `${profile.displayName} renamed ${previousName} to ${nextName}.` });
      return { result: space, events: [{ type: "space.updated", spaceId: space.id, entity: clone(space) }, { type: "activity.new", spaceId: space.id, entity: activity }] };
    });
  }

  bootstrap({ token, spaceId }) {
    const { profile } = this.requireSession(token);
    const space = this.getSpace(spaceId || profile.activeSpaceId) || this.data.spaces[0];
    const resultIds = new Set(this.data.results.filter((item) => item.spaceId === space.id).map((item) => item.id));
    const visibleNotifications = this.data.notifications.filter((item) => item.spaceId === space.id && (!item.userId || item.userId === profile.id));
    return {
      storeRevision: this.data.storeRevision,
      profile: this.publicProfile(profile),
      space,
      spaces: clone(this.data.spaces),
      profiles: this.data.profiles.map((item) => this.publicProfile(item)),
      results: clone(this.data.results.filter((item) => item.spaceId === space.id)),
      edges: clone(this.data.edges.filter((item) => item.spaceId === space.id)),
      revisions: clone(this.data.revisions.filter((item) => resultIds.has(item.resultId))),
      reviews: clone(this.data.reviews.filter((item) => resultIds.has(item.resultId))),
      comments: clone(this.data.comments.filter((item) => resultIds.has(item.resultId))),
      draftFeedback: clone(this.data.draftFeedback.filter((item) => resultIds.has(item.resultId))),
      suggestions: clone(this.data.suggestions.filter((item) => item.spaceId === space.id && item.status === "open" && (!item.audienceUserIds?.length || item.audienceUserIds.includes(profile.id)))),
      notifications: clone(visibleNotifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
      activity: clone(this.data.activity.filter((item) => item.spaceId === space.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)),
      agentStatus: clone(this.data.agentStatus),
      pendingWorkCount: this.pendingWorkCount()
    };
  }

  #activity(data, { spaceId, actorType = "human", actorId, action, entityType, entityId, summary }) {
    const item = { id: randomUUID(), spaceId, actorType, actorId, action, entityType, entityId, summary, createdAt: now() };
    data.activity.push(item);
    return item;
  }

  #notification(data, input) {
    if (input.dedupeKey) {
      const existing = data.notifications.find((item) => item.dedupeKey === input.dedupeKey);
      if (existing) return existing;
    }
    const item = { id: randomUUID(), readBy: [], createdAt: now(), createdBy: "codex", ...input };
    data.notifications.push(item);
    return item;
  }

  #queue(data, { type, spaceId, entityType = "result", entityId, targetRevision = null, payload = {}, manual = false }) {
    const priority = type === "review_draft" && manual ? PRIORITY.review_draft_manual : PRIORITY[type];
    const duplicate = data.workQueue.find((item) => item.type === type && item.entityId === entityId && ["pending", "claimed"].includes(item.status));
    if (duplicate) {
      if (duplicate.status === "pending" && targetRevision) {
        duplicate.targetRevision = targetRevision;
        duplicate.payload = payload;
        duplicate.priority = priority;
      }
      return duplicate;
    }
    const item = {
      id: randomUUID(), type, priority, spaceId, entityType, entityId, targetRevision, payload,
      status: "pending", attempts: 0, claimedAt: null, leaseUntil: null, completedAt: null,
      error: null, createdAt: now()
    };
    data.workQueue.push(item);
    return item;
  }

  #eventsFor(entityType, entity, extra = {}) {
    return [{ type: "entity.upsert", entityType, entity: clone(entity), spaceId: entity.spaceId, ...extra }];
  }

  async updateProfile(token, patch) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const target = data.profiles.find((item) => item.id === profile.id);
      if (patch.color) target.color = String(patch.color);
      if (Array.isArray(patch.interestTags)) target.interestTags = patch.interestTags.slice(0, 12).map(String);
      if (patch.activeSpaceId && data.spaces.some((space) => space.id === patch.activeSpaceId)) target.activeSpaceId = patch.activeSpaceId;
      target.lastSeenAt = now();
      return { result: this.publicProfile(target), events: [{ type: "profile.upsert", spaceId: target.activeSpaceId, entity: this.publicProfile(target) }] };
    });
  }

  async createResult(token, input) {
    const { profile } = this.requireSession(token);
    const space = this.getSpace(input.spaceId || profile.activeSpaceId);
    if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
    return this.mutate((data) => {
      const result = {
        id: randomUUID(), spaceId: space.id, title: String(input.title || "Untitled result").slice(0, 120),
        statementLatex: String(input.statementLatex || ""), hypothesesLatex: Array.isArray(input.hypothesesLatex) ? input.hypothesesLatex.map(String) : [],
        proofMarkdown: String(input.proofMarkdown || ""), status: "draft", version: 0, draftRevision: 1,
        submittedRevisionId: null, lastCodexReviewAt: null, lastCodexReviewContentLength: 0,
        citation: String(input.citation || ""), bibtex: String(input.bibtex || ""), sourceType: "original",
        sourceSpaceId: null, sourceResultId: null, tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        dependencyIds: Array.isArray(input.dependencyIds) ? input.dependencyIds : [], x: Number(input.x ?? 360), y: Number(input.y ?? 260),
        starredBy: [], createdBy: profile.id, updatedBy: profile.id, createdAt: now(), updatedAt: now()
      };
      data.results.push(result);
      const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "result.created", entityType: "result", entityId: result.id, summary: `${profile.displayName} created ${result.title}.` });
      return { result, events: [...this.#eventsFor("result", result), { type: "activity.new", spaceId: space.id, entity: activity }] };
    });
  }

  async updateResult(token, id, patch) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const result = data.results.find((item) => item.id === id);
      if (!result) throw new StoreError("result_not_found", "Result not found.", 404);
      const contentChanged = ["title", "statementLatex", "hypothesesLatex", "proofMarkdown", "tags", "dependencyIds", "citation", "bibtex"].some((key) => key in patch);
      if (contentChanged && !["draft", "pending_review"].includes(result.status)) throw new StoreError("result_locked", "Create a new revision before editing this result.", 409);
      if (contentChanged && result.status === "pending_review") throw new StoreError("result_locked", "This submitted revision is being reviewed.", 409);
      for (const [key, value] of Object.entries(patch)) {
        if (!EDITABLE_FIELDS.has(key)) continue;
        if (["x", "y"].includes(key)) result[key] = Math.max(0, Math.min(key === "x" ? 900 : 850, Number(value) || 0));
        else if (["hypothesesLatex", "tags", "dependencyIds"].includes(key)) result[key] = Array.isArray(value) ? value.map(String) : [];
        else result[key] = String(value);
      }
      if (contentChanged) {
        result.draftRevision += 1;
        for (const feedback of data.draftFeedback.filter((item) => item.resultId === id && item.status === "current")) feedback.status = "stale";
      }
      result.updatedBy = profile.id;
      result.updatedAt = now();
      return { result, events: this.#eventsFor("result", result) };
    });
  }

  async toggleStar(token, id) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const result = data.results.find((item) => item.id === id);
      if (!result) throw new StoreError("result_not_found", "Result not found.", 404);
      result.starredBy ||= [];
      const index = result.starredBy.indexOf(profile.id);
      if (index >= 0) result.starredBy.splice(index, 1); else result.starredBy.push(profile.id);
      return { result, events: this.#eventsFor("result", result) };
    });
  }

  listRevisions(token, resultId) {
    this.requireSession(token);
    return clone(this.data.revisions.filter((item) => item.resultId === resultId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async cloneRevision(token, resultId, revisionId) {
    const { profile } = this.requireSession(token);
    const revision = this.data.revisions.find((item) => item.id === revisionId && item.resultId === resultId);
    if (!revision) throw new StoreError("revision_not_found", "Revision not found.", 404);
    return this.createResult(token, { ...revision.snapshot, title: `${revision.snapshot.title} - revision`, spaceId: revision.snapshot.spaceId });
  }

  async addComment(token, resultId, body) {
    const { profile } = this.requireSession(token);
    const result = this.getResult(resultId);
    if (!result) throw new StoreError("result_not_found", "Result not found.", 404);
    const text = String(body || "").trim();
    if (!text) throw new StoreError("empty_comment", "Comment cannot be empty.");
    return this.mutate((data) => {
      const comment = { id: randomUUID(), resultId, spaceId: result.spaceId, userId: profile.id, body: text.slice(0, 4000), createdAt: now() };
      data.comments.push(comment);
      const activity = this.#activity(data, { spaceId: result.spaceId, actorId: profile.id, action: "comment.created", entityType: "result", entityId: resultId, summary: `${profile.displayName} commented on ${result.title}.` });
      return { result: comment, events: [{ type: "entity.upsert", entityType: "comment", entity: comment, spaceId: result.spaceId }, { type: "activity.new", entity: activity, spaceId: result.spaceId }] };
    });
  }

  async requestDraftReview(token, resultId, { manual = true } = {}) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const result = data.results.find((item) => item.id === resultId);
      if (!result) throw new StoreError("result_not_found", "Result not found.", 404);
      if (result.status !== "draft") throw new StoreError("not_a_draft", "Only drafts can receive coaching.", 409);
      const work = this.#queue(data, { type: "review_draft", spaceId: result.spaceId, entityId: result.id, targetRevision: String(result.draftRevision), payload: { requestedBy: profile.id }, manual });
      return { result: work, events: [{ type: "queue.changed", spaceId: result.spaceId, pendingCount: this.pendingWorkCount(data) }] };
    });
  }

  scheduleDraftReview(resultId) {
    clearTimeout(this.draftTimers.get(resultId));
    const timer = setTimeout(async () => {
      this.draftTimers.delete(resultId);
      const current = this.getResult(resultId);
      if (!current || current.status !== "draft") return;
      const changed = contentLength(current) - Number(current.lastCodexReviewContentLength || 0);
      const elapsed = current.lastCodexReviewAt ? Date.now() - new Date(current.lastCodexReviewAt).getTime() : Infinity;
      if (changed < 120 || elapsed < 60_000) return;
      await this.mutate((data) => ({
        result: this.#queue(data, { type: "review_draft", spaceId: current.spaceId, entityId: current.id, targetRevision: String(current.draftRevision), payload: {}, manual: false }),
        events: [{ type: "queue.changed", spaceId: current.spaceId, pendingCount: this.pendingWorkCount(data) }]
      }));
    }, 12_000);
    this.draftTimers.set(resultId, timer);
  }

  async submitResult(token, resultId) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const result = data.results.find((item) => item.id === resultId);
      if (!result) throw new StoreError("result_not_found", "Result not found.", 404);
      if (result.status !== "draft") throw new StoreError("not_a_draft", "Only drafts can be submitted.", 409);
      if (!result.statementLatex.trim() || !result.proofMarkdown.trim()) throw new StoreError("incomplete_result", "Add a statement and proof before submitting.");
      data.workQueue = data.workQueue.filter((item) => !(item.entityId === resultId && item.type === "review_draft" && item.status === "pending"));
      result.version += 1;
      result.status = "pending_review";
      result.updatedAt = now();
      result.updatedBy = profile.id;
      const revision = { id: randomUUID(), resultId, revisionNumber: result.version, reason: "submitted", authorId: profile.id, status: result.status, snapshot: clone(result), createdAt: now() };
      result.submittedRevisionId = revision.id;
      revision.snapshot.submittedRevisionId = revision.id;
      data.revisions.push(revision);
      const work = this.#queue(data, { type: "validate_result", spaceId: result.spaceId, entityId: resultId, targetRevision: revision.id, payload: { authorId: profile.id } });
      const activity = this.#activity(data, { spaceId: result.spaceId, actorId: profile.id, action: "result.submitted", entityType: "result", entityId: result.id, summary: `${profile.displayName} submitted ${result.title} for Codex review.` });
      return { result: { result, work }, events: [...this.#eventsFor("result", result), { type: "activity.new", entity: activity, spaceId: result.spaceId }, { type: "queue.changed", spaceId: result.spaceId, pendingCount: this.pendingWorkCount(data) }] };
    });
  }

  async createEdge(token, input) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const source = data.results.find((item) => item.id === input.sourceResultId);
      const target = data.results.find((item) => item.id === input.targetResultId);
      if (!source || !target || source.spaceId !== target.spaceId) throw new StoreError("invalid_edge", "Both results must exist in the same theorem space.");
      if (source.id === target.id) throw new StoreError("invalid_edge", "A result cannot depend on itself.");
      const relation = ["depends_on", "supports", "conflicts_with", "contributes_to"].includes(input.relation) ? input.relation : "depends_on";
      if (data.edges.some((edge) => edge.sourceResultId === source.id && edge.targetResultId === target.id && edge.relation === relation)) throw new StoreError("duplicate_edge", "That relationship already exists.", 409);
      const edge = { id: randomUUID(), spaceId: source.spaceId, sourceResultId: source.id, targetResultId: target.id, relation, createdBy: profile.id, createdAt: now() };
      data.edges.push(edge);
      return { result: edge, events: [{ type: "entity.upsert", entityType: "edge", entity: edge, spaceId: edge.spaceId }] };
    });
  }

  async deleteEdge(token, id) {
    this.requireSession(token);
    return this.mutate((data) => {
      const index = data.edges.findIndex((item) => item.id === id);
      if (index < 0) throw new StoreError("edge_not_found", "Edge not found.", 404);
      const [edge] = data.edges.splice(index, 1);
      return { result: edge, events: [{ type: "entity.delete", entityType: "edge", id, spaceId: edge.spaceId }] };
    });
  }

  async applyLayout(token, spaceId, positions) {
    this.requireSession(token);
    const space = this.getSpace(spaceId);
    if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
    return this.mutate((data) => {
      const updated = [];
      for (const result of data.results.filter((item) => item.spaceId === space.id)) {
        const position = positions[result.id];
        if (!position) continue;
        result.x = Math.max(0, Math.min(900, Number(position.x) || 0));
        result.y = Math.max(0, Math.min(850, Number(position.y) || 0));
        result.updatedAt = now();
        updated.push(result);
      }
      return {
        result: updated,
        events: updated.map((entity) => ({ type: "entity.upsert", entityType: "result", entity: clone(entity), spaceId: space.id }))
      };
    });
  }

  async readNotifications(token, ids = null) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const targets = data.notifications.filter((item) => (!item.userId || item.userId === profile.id) && (!ids || ids.includes(item.id)));
      for (const item of targets) if (!item.readBy.includes(profile.id)) item.readBy.push(profile.id);
      return { result: targets, events: targets.map((entity) => ({ type: "entity.upsert", entityType: "notification", entity, spaceId: entity.spaceId, audienceUserIds: [profile.id] })) };
    });
  }

  async dismissSuggestion(token, id) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const suggestion = data.suggestions.find((item) => item.id === id);
      if (!suggestion) throw new StoreError("suggestion_not_found", "Suggestion not found.", 404);
      suggestion.status = "dismissed";
      suggestion.actedBy = profile.id;
      suggestion.actedAt = now();
      return { result: suggestion, events: [{ type: "entity.upsert", entityType: "suggestion", entity: suggestion, spaceId: suggestion.spaceId, audienceUserIds: suggestion.audienceUserIds }] };
    });
  }

  async acceptSuggestion(token, id) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const suggestion = data.suggestions.find((item) => item.id === id);
      if (!suggestion || suggestion.status !== "open") throw new StoreError("suggestion_not_found", "Open suggestion not found.", 404);
      const events = [];
      for (const command of suggestion.proposedChanges || []) {
        if (command.type === "create_edge") {
          const source = data.results.find((item) => item.id === command.sourceResultId);
          const target = data.results.find((item) => item.id === command.targetResultId);
          if (!source || !target || source.spaceId !== suggestion.spaceId || target.spaceId !== suggestion.spaceId) continue;
          const exists = data.edges.some((edge) => edge.sourceResultId === source.id && edge.targetResultId === target.id && edge.relation === command.relation);
          if (!exists) {
            const edge = { id: randomUUID(), spaceId: suggestion.spaceId, sourceResultId: source.id, targetResultId: target.id, relation: command.relation || "supports", createdBy: profile.id, createdAt: now() };
            data.edges.push(edge);
            events.push({ type: "entity.upsert", entityType: "edge", entity: edge, spaceId: edge.spaceId });
          }
        }
        if (command.type === "create_imported_result") {
          const source = data.results.find((item) => item.id === command.sourceResultId);
          if (!source) continue;
          const exists = data.results.find((item) => item.spaceId === suggestion.spaceId && item.sourceResultId === source.id);
          if (!exists) {
            const imported = { ...clone(source), id: randomUUID(), spaceId: suggestion.spaceId, status: "imported", sourceType: "imported", sourceSpaceId: source.spaceId, sourceResultId: source.id, x: Number(command.x || 640), y: Number(command.y || 300), starredBy: [], createdBy: profile.id, updatedBy: profile.id, createdAt: now(), updatedAt: now() };
            data.results.push(imported);
            events.push(...this.#eventsFor("result", imported));
          }
        }
      }
      suggestion.status = "accepted";
      suggestion.actedBy = profile.id;
      suggestion.actedAt = now();
      const activity = this.#activity(data, { spaceId: suggestion.spaceId, actorId: profile.id, action: "suggestion.accepted", entityType: "suggestion", entityId: suggestion.id, summary: `${profile.displayName} integrated ${suggestion.title}.` });
      events.push({ type: "entity.upsert", entityType: "suggestion", entity: suggestion, spaceId: suggestion.spaceId, audienceUserIds: suggestion.audienceUserIds }, { type: "activity.new", entity: activity, spaceId: suggestion.spaceId });
      return { result: suggestion, events };
    });
  }

  pendingWorkCount(data = this.data) {
    this.reapExpiredLeases(data);
    return data.workQueue.filter((item) => item.status === "pending").length;
  }

  reapExpiredLeases(data = this.data) {
    const timestamp = Date.now();
    for (const item of data.workQueue) {
      if (item.status !== "claimed" || !item.leaseUntil || new Date(item.leaseUntil).getTime() > timestamp) continue;
      item.attempts += 1;
      item.status = item.attempts >= 3 ? "failed" : "pending";
      item.error = "Agent lease expired";
      item.claimedAt = null;
      item.leaseUntil = null;
    }
  }

  async getNextWork() {
    return this.mutate((data) => {
      this.reapExpiredLeases(data);
      const pending = data.workQueue.filter((item) => item.status === "pending").sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      const item = pending[0];
      if (!item) return { result: { empty: true, agentStatus: data.agentStatus }, events: [] };
      item.status = "claimed";
      item.claimedAt = now();
      item.leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString();
      data.agentStatus = { state: item.type === "suggest_integrations" ? "integrating" : "reviewing", currentWorkType: item.type, updatedAt: now() };
      return { result: { empty: false, work: item, agentStatus: data.agentStatus }, events: [{ type: "agent.status", state: data.agentStatus }] };
    });
  }

  getWorkContext(workId) {
    const work = this.data.workQueue.find((item) => item.id === workId);
    if (!work || work.status !== "claimed") throw new StoreError("work_not_claimed", "Work is not currently claimed.", 409);
    if (new Date(work.leaseUntil).getTime() < Date.now()) throw new StoreError("lease_expired", "Work lease expired.", 409);
    const result = this.getResult(work.entityId);
    if (!result) throw new StoreError("result_not_found", "Result not found.", 404);
    const resultIds = new Set([result.id, ...(result.dependencyIds || [])]);
    return clone({
      work, result,
      targetRevision: this.data.revisions.find((item) => item.id === work.targetRevision) || null,
      edges: this.data.edges.filter((edge) => edge.sourceResultId === result.id || edge.targetResultId === result.id),
      dependencies: this.data.results.filter((item) => resultIds.has(item.id) && item.id !== result.id),
      reviews: this.data.reviews.filter((item) => item.resultId === result.id),
      comments: this.data.comments.filter((item) => item.resultId === result.id),
      feedback: this.data.draftFeedback.filter((item) => item.resultId === result.id),
      author: this.publicProfile(this.data.profiles.find((item) => item.id === result.createdBy)),
      space: this.getSpace(result.spaceId),
      proofSteps: result.proofMarkdown.split(/\n\s*\n/).map((text, index) => ({ id: `step-${index + 1}`, text: text.trim() })).filter((step) => step.text),
      warnings: this.inspectProjection(result.spaceId).warnings
    });
  }

  researchContext(workId, { tags = [], limit = 200, resultIds = [] } = {}) {
    const work = this.data.workQueue.find((item) => item.id === workId && item.status === "claimed" && item.type === "suggest_integrations");
    if (!work) throw new StoreError("invalid_work", "Claimed integration work is required.", 409);
    let results = this.data.results.filter((item) => item.spaceId !== work.spaceId && ["validated", "imported", "draft", "pending_review"].includes(item.status));
    if (tags.length) results = results.filter((item) => item.tags?.some((tag) => tags.includes(tag)));
    if (resultIds.length) results = results.filter((item) => resultIds.includes(item.id)).slice(0, 10);
    else results = results.slice(0, Math.min(200, Number(limit) || 200));
    return clone(results.map((item) => ({
      id: item.id, spaceId: item.spaceId, title: item.title, status: item.status, statementLatex: item.statementLatex,
      hypothesesLatex: item.hypothesesLatex, tags: item.tags, dependencyIds: item.dependencyIds, citation: item.citation,
      proofMarkdown: resultIds.length ? item.proofMarkdown : undefined,
      author: this.publicProfile(this.data.profiles.find((profile) => profile.id === item.createdBy))
    })));
  }

  #requireClaimed(data, workId, type) {
    const work = data.workQueue.find((item) => item.id === workId && item.status === "claimed" && (!type || item.type === type));
    if (!work) throw new StoreError("work_not_claimed", "Claimed work item not found.", 409);
    if (new Date(work.leaseUntil).getTime() < Date.now()) throw new StoreError("lease_expired", "Work lease expired.", 409);
    return work;
  }

  #complete(data, work) {
    work.status = "completed";
    work.completedAt = now();
    work.leaseUntil = null;
    data.agentStatus = { state: "idle", currentWorkType: null, updatedAt: now() };
  }

  async submitDraftReview(input) {
    return this.mutate((data) => {
      const work = this.#requireClaimed(data, input.workId, "review_draft");
      const result = data.results.find((item) => item.id === work.entityId);
      const stale = String(result.draftRevision) !== String(input.draftRevision);
      const feedback = { id: randomUUID(), resultId: result.id, spaceId: result.spaceId, draftRevision: Number(input.draftRevision), status: stale ? "stale" : "current", summary: String(input.summary || ""), issues: clone(input.issues || []), relevantResultIds: clone(input.relevantResultIds || []), createdBy: "codex", createdAt: now() };
      data.draftFeedback.push(feedback);
      if (!stale) {
        result.lastCodexReviewAt = now();
        result.lastCodexReviewContentLength = contentLength(result);
      }
      const notification = this.#notification(data, { spaceId: result.spaceId, userId: result.createdBy, type: "draft_feedback", title: input.notification?.title || "Draft feedback ready", body: input.notification?.body || feedback.summary, entityType: "result", entityId: result.id, dedupeKey: `draft:${result.id}:${feedback.draftRevision}` });
      const activity = this.#activity(data, { spaceId: result.spaceId, actorType: "codex", actorId: "codex", action: "draft.reviewed", entityType: "result", entityId: result.id, summary: `Codex reviewed draft revision ${feedback.draftRevision} of ${result.title}.` });
      this.#complete(data, work);
      return { result: { feedback, stale }, events: [{ type: "draft.feedback", entity: feedback, resultId: result.id, draftRevision: feedback.draftRevision, spaceId: result.spaceId, audienceUserIds: [result.createdBy] }, { type: "notification.new", notification, spaceId: result.spaceId, audienceUserIds: [result.createdBy] }, { type: "activity.new", entity: activity, spaceId: result.spaceId }, { type: "agent.status", state: data.agentStatus }] };
    });
  }

  async submitValidation(input) {
    return this.mutate((data) => {
      const work = this.#requireClaimed(data, input.workId, "validate_result");
      const result = data.results.find((item) => item.id === work.entityId);
      if (work.targetRevision !== input.submittedRevisionId || result.submittedRevisionId !== input.submittedRevisionId) throw new StoreError("revision_mismatch", "Validation must target the submitted revision.", 409);
      if (result.proofMarkdown.length > 80 && !(input.proofStepChecks || []).length) throw new StoreError("missing_step_checks", "Nontrivial proofs require proof-step checks.");
      const decision = ["validated", "needs_changes", "rejected"].includes(input.decision) ? input.decision : "needs_changes";
      const review = { id: randomUUID(), resultId: result.id, reviewerType: "codex", reviewerId: "codex", decision, summary: String(input.summary || ""), claimRestatement: String(input.claimRestatement || ""), assumptionChecks: clone(input.assumptionChecks || []), proofStepChecks: clone(input.proofStepChecks || []), dependencyChecks: clone(input.dependencyChecks || []), counterexampleRisks: clone(input.counterexampleRisks || []), issues: clone(input.issues || []), confidence: Number(input.confidence || 0), createdAt: now() };
      data.reviews.push(review);
      result.status = decision === "validated" ? "validated" : decision === "rejected" ? "rejected" : "draft";
      result.updatedAt = now();
      const revision = data.revisions.find((item) => item.id === input.submittedRevisionId);
      if (revision) revision.status = result.status;
      if (decision === "validated") this.#queue(data, { type: "suggest_integrations", spaceId: result.spaceId, entityId: result.id, targetRevision: input.submittedRevisionId, payload: { authorId: result.createdBy } });
      const notification = this.#notification(data, { spaceId: result.spaceId, userId: result.createdBy, type: "validation", title: input.notification?.title || "Codex review complete", body: input.notification?.body || review.summary, entityType: "result", entityId: result.id, dedupeKey: `validation:${result.id}:${input.submittedRevisionId}` });
      const activity = this.#activity(data, { spaceId: result.spaceId, actorType: "codex", actorId: "codex", action: `result.${decision}`, entityType: "result", entityId: result.id, summary: `Codex marked ${result.title} as ${decision.replace("_", " ")}.` });
      this.#complete(data, work);
      return { result: { result, review }, events: [...this.#eventsFor("result", result), { type: "entity.upsert", entityType: "review", entity: review, spaceId: result.spaceId }, { type: "notification.new", notification, spaceId: result.spaceId, audienceUserIds: [result.createdBy] }, { type: "activity.new", entity: activity, spaceId: result.spaceId }, { type: "queue.changed", spaceId: result.spaceId, pendingCount: this.pendingWorkCount(data) }, { type: "agent.status", state: data.agentStatus }] };
    });
  }

  async submitIntegrations(input) {
    return this.mutate((data) => {
      const work = this.#requireClaimed(data, input.workId, "suggest_integrations");
      const source = data.results.find((item) => item.id === work.entityId);
      const createdSuggestions = [];
      const createdNotifications = [];
      for (const raw of (input.suggestions || []).slice(0, 4)) {
        const targetId = raw.targetResultIds?.[0] || "user";
        const dedupeKey = `${source.id}:${targetId}:${raw.type || "relevance"}`;
        const existing = data.suggestions.find((item) => item.dedupeKey === dedupeKey && item.status === "open");
        if (existing) continue;
        const validUsers = (raw.audienceUserIds || []).filter((id) => data.profiles.some((profile) => profile.id === id));
        const validTargets = (raw.targetResultIds || []).filter((id) => data.results.some((result) => result.id === id));
        const targetResult = data.results.find((result) => result.id === validTargets[0]);
        const targetProfile = data.profiles.find((profile) => validUsers.includes(profile.id));
        const deliverySpaceId = targetResult?.spaceId || targetProfile?.activeSpaceId || source.spaceId;
        const suggestion = { id: randomUUID(), spaceId: deliverySpaceId, type: raw.type || "relevance", title: String(raw.title || "Relevant result found"), explanation: String(raw.explanation || ""), confidence: Number(raw.confidence || 0), sourceResultIds: [source.id, ...(raw.sourceResultIds || []).filter((id) => id !== source.id)], targetResultIds: validTargets, proposedChanges: clone(raw.proposedChanges || []), evidence: clone(raw.evidence || []), audienceUserIds: validUsers, dedupeKey, status: "open", createdBy: "codex", createdAt: now(), actedBy: null, actedAt: null };
        data.suggestions.push(suggestion);
        createdSuggestions.push(suggestion);
      }
      for (const raw of input.notifications || []) {
        const targetProfile = data.profiles.find((profile) => profile.id === raw.userId);
        if (!targetProfile) continue;
        const relatedSuggestion = createdSuggestions.find((item) => item.audienceUserIds.includes(raw.userId));
        const item = this.#notification(data, { spaceId: relatedSuggestion?.spaceId || targetProfile.activeSpaceId || source.spaceId, userId: raw.userId, type: "relevance", title: String(raw.title || "Relevant work found"), body: String(raw.body || ""), entityType: "result", entityId: source.id, dedupeKey: raw.dedupeKey || `integration:${source.id}:${raw.userId}:${relatedSuggestion?.id || "none"}` });
        createdNotifications.push(item);
      }
      const activity = this.#activity(data, { spaceId: source.spaceId, actorType: "codex", actorId: "codex", action: "integrations.suggested", entityType: "result", entityId: source.id, summary: `Codex found ${createdSuggestions.length} integration suggestion${createdSuggestions.length === 1 ? "" : "s"} for ${source.title}.` });
      this.#complete(data, work);
      const events = createdSuggestions.map((entity) => ({ type: "entity.upsert", entityType: "suggestion", entity, spaceId: entity.spaceId, audienceUserIds: entity.audienceUserIds }));
      events.push(...createdNotifications.map((notification) => ({ type: "notification.new", notification, spaceId: notification.spaceId, audienceUserIds: [notification.userId] })), { type: "activity.new", entity: activity, spaceId: source.spaceId }, { type: "agent.status", state: data.agentStatus });
      return { result: { suggestions: createdSuggestions, notifications: createdNotifications }, events };
    });
  }

  inspectProjection(spaceId) {
    const nodes = this.data.results.filter((item) => item.spaceId === spaceId);
    const nodeIds = new Set(nodes.map((item) => item.id));
    const edges = this.data.edges.filter((item) => item.spaceId === spaceId);
    const warnings = [];
    for (const edge of edges) if (!nodeIds.has(edge.sourceResultId) || !nodeIds.has(edge.targetResultId)) warnings.push({ type: "dangling_edge", edgeId: edge.id });
    const edgeKeys = new Set();
    for (const edge of edges) {
      const key = `${edge.sourceResultId}:${edge.targetResultId}:${edge.relation}`;
      if (edgeKeys.has(key)) warnings.push({ type: "duplicate_edge", edgeId: edge.id });
      edgeKeys.add(key);
    }
    for (const node of nodes) if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || node.x < 0 || node.y < 0 || node.x > 900 || node.y > 850) warnings.push({ type: "off_canvas", resultId: node.id });
    const statusCounts = nodes.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
    return clone({ spaceId, storeRevision: this.data.storeRevision, nodeCount: nodes.length, edgeCount: edges.length, statusCounts, openSuggestionCount: this.data.suggestions.filter((item) => item.spaceId === spaceId && item.status === "open").length, warnings });
  }

  async failWork(input) {
    return this.mutate((data) => {
      const work = this.#requireClaimed(data, input.workId);
      work.attempts += 1;
      work.error = String(input.error || "Agent failed");
      work.status = input.retryable && work.attempts < 3 ? "pending" : "failed";
      work.claimedAt = null;
      work.leaseUntil = null;
      data.agentStatus = { state: work.status === "failed" ? "failed" : "idle", currentWorkType: null, updatedAt: now() };
      const events = [{ type: "agent.status", state: data.agentStatus }, { type: "queue.changed", spaceId: work.spaceId, pendingCount: this.pendingWorkCount(data) }];
      if (work.status === "failed") {
        const result = data.results.find((item) => item.id === work.entityId);
        if (result?.createdBy && result.createdBy !== "seed") {
          const notification = this.#notification(data, { spaceId: work.spaceId, userId: result.createdBy, type: "agent_failed", title: "Codex could not finish this review", body: work.error, entityType: "result", entityId: result.id, dedupeKey: `agent-failed:${work.id}` });
          events.push({ type: "notification.new", notification, spaceId: work.spaceId, audienceUserIds: [result.createdBy] });
        }
      }
      return { result: work, events };
    });
  }

  async setAgentStatus(state) {
    return this.mutate((data) => {
      data.agentStatus = { ...data.agentStatus, ...state, updatedAt: now() };
      return { result: data.agentStatus, events: [{ type: "agent.status", state: data.agentStatus }] };
    });
  }
}
