import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const PRIORITY = {
  validate_result: 100,
  review_conjecture: 90,
  fill_current_status: 80,
  review_current_status: 80,
  suggest_integrations: 70,
  review_draft_manual: 30,
  review_draft: 10
};

const EDITABLE_FIELDS = new Set([
  "kind", "title", "statementLatex", "hypothesesLatex", "proofMarkdown", "tags",
  "dependencyIds", "citation", "bibtex", "collaboratorIds", "x", "y"
]);

const TASK_STATUSES = new Set(["open", "claimed", "in_progress", "blocked", "done"]);
const TASK_PRIORITIES = new Set(["high", "normal", "exploratory"]);
const RESULT_KINDS = new Set(["result", "conjecture", "proof", "counterexample"]);
const EDGE_RELATIONS = new Set(["uses", "supports", "special_case_of", "proves", "refutes", "alternative", "conflicts_with"]);
const PROFILE_COLORS = [
  "#2563eb", "#c2410c", "#0f766e", "#7c3aed", "#be185d", "#4d6412",
  "#036b8e", "#9f1239", "#4338ca", "#166534", "#8a5200", "#86198f"
];
const LEGACY_PROFILE_COLOR = "#3178ed";

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const normalizeName = (value) => String(value || "").trim().toLocaleLowerCase();
const slugify = (value) => String(value || "theorem-space").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "theorem-space";
const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const contentLength = (result) => [
  result.title,
  result.statementLatex,
  ...(result.hypothesesLatex || []),
  result.proofMarkdown
].join(" ").replace(/\s/g, "").length;

function nextProfileColor(profiles) {
  const counts = new Map(PROFILE_COLORS.map((color) => [color, 0]));
  for (const profile of profiles) {
    const color = String(profile.color || "").toLowerCase();
    if (counts.has(color)) counts.set(color, counts.get(color) + 1);
  }
  return PROFILE_COLORS.reduce((best, color) => counts.get(color) < counts.get(best) ? color : best, PROFILE_COLORS[0]);
}

function normalizeProfileColors(profiles) {
  const used = new Set();
  for (const profile of profiles) {
    const color = String(profile.color || "").toLowerCase();
    const isHexColor = /^#[0-9a-f]{6}$/.test(color);
    if (isHexColor && color !== LEGACY_PROFILE_COLOR && !used.has(color)) {
      profile.color = color;
      used.add(color);
      continue;
    }
    const assigned = PROFILE_COLORS.find((candidate) => !used.has(candidate)) || nextProfileColor(profiles);
    profile.color = assigned;
    used.add(assigned);
  }
}

const markdownInline = (value) => String(value ?? "").replace(/\s+/g, " ").replace(/([\\`*_[\]])/g, "\\$1");
const indentedJson = (value) => JSON.stringify(value, null, 2).split("\n").map((line) => `    ${line}`).join("\n");

function currentStatusContextMarkdown(context, exportedAt) {
  const status = context.currentStatus || {};
  const draft = status.draftMarkdown?.trim() || "_No current status draft._";
  const published = status.publishedMarkdown?.trim() || "_No current status has been published._";
  return [
    `# MathHive Codex Context: ${markdownInline(context.space?.name || "Theorem Space")}`,
    "",
    "> This is a complete snapshot of the context MathHive supplies to Codex when filling the Current Status. Current entity state is authoritative; timestamped history is supporting context.",
    "",
    "## Export Metadata",
    "",
    `- Exported at: ${exportedAt}`,
    `- Theorem space ID: \`${context.space?.id || "unknown"}\``,
    `- Snapshot mode: \`${context.mode}\``,
    `- Base status draft revision: ${context.baseDraftRevision}`,
    "",
    "## AI Task",
    "",
    ...context.writingRequirements.map((item) => `- ${markdownInline(item)}`),
    "",
    "## Current Status",
    "",
    "### Draft",
    "",
    draft,
    "",
    "### Published",
    "",
    published,
    "",
    "## Complete Codex Context Payload",
    "",
    "> This JSON object is the single canonical representation of the workspace context. It includes members, results and proofs, tasks, graph edges, revisions, reviews, comments, suggestions, status history, link syntax, and compact timestamped history.",
    "",
    indentedJson(context),
    ""
  ].join("\n");
}

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
    }
    this.#normalizeData();
    await this.#save();
    return this;
  }

  #normalizeData() {
    const arrays = ["profiles", "sessions", "spaces", "memberships", "tasks", "results", "revisions", "draftFeedback", "edges", "reviews", "comments", "suggestions", "currentStatuses", "statusHistory", "statusSuggestions", "notifications", "activity", "workQueue"];
    for (const key of arrays) this.data[key] ||= [];
    this.data.schemaVersion = 3;
    this.data.storeRevision ||= 0;
    this.data.agentStatus ||= { state: "offline", currentWorkType: null, updatedAt: now() };
    normalizeProfileColors(this.data.profiles);
    for (const space of this.data.spaces) {
      space.rootResultId ??= space.id === "space-spectral" && this.data.results.some((item) => item.id === "result-main") ? "result-main" : null;
      space.pendingLeadProfileId ??= null;
      space.createdBy ??= "seed";
    }
    for (const profile of this.data.profiles) {
      if (!profile.activeSpaceId || this.data.memberships.some((item) => item.spaceId === profile.activeSpaceId && item.profileId === profile.id)) continue;
      this.data.memberships.push({ id: randomUUID(), spaceId: profile.activeSpaceId, profileId: profile.id, role: "contributor", joinedAt: profile.createdAt || now() });
    }
    for (const space of this.data.spaces) {
      const members = this.data.memberships.filter((item) => item.spaceId === space.id).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
      if (members.length && !members.some((item) => item.role === "lead")) members[0].role = "lead";
      let foundLead = false;
      for (const member of members) {
        if (member.role !== "lead") continue;
        if (!foundLead) foundLead = true;
        else member.role = "contributor";
      }
    }
    for (const result of this.data.results) {
      result.kind ||= result.tags?.includes("conjecture") ? "conjecture" : result.tags?.includes("proof") ? "proof" : "result";
      if (!RESULT_KINDS.has(result.kind)) result.kind = "result";
      result.relevanceStatus ||= null;
      result.provedByProofIds ||= [];
      result.refutedByCounterexampleIds ||= [];
      result.collaboratorIds ||= [];
      result.taskId ??= null;
    }
    for (const edge of this.data.edges) {
      if (edge.relation === "depends_on") {
        [edge.sourceResultId, edge.targetResultId] = [edge.targetResultId, edge.sourceResultId];
        edge.relation = "uses";
      }
      if (edge.relation === "contributes_to") edge.relation = "supports";
      if (["proves", "refutes"].includes(edge.relation)) edge.verificationStatus ||= "proposed";
    }
    for (const task of this.data.tasks) {
      task.priority = TASK_PRIORITIES.has(task.priority) ? task.priority : "normal";
      task.status = TASK_STATUSES.has(task.status) ? task.status : "open";
      task.approvalState ||= "official";
      task.sortOrder ??= 0;
      task.parentTaskId ??= null;
      task.targetResultId ??= null;
      task.expectedRelation ??= null;
      task.outputResultIds ||= [];
      task.proposedBy ??= null;
      task.primaryContributorId ??= null;
      task.collaboratorIds ||= [];
      task.pendingVolunteerIds ||= [];
      task.invitedProfileIds ||= [];
      task.blockedReason ??= "";
    }
    for (const status of this.data.currentStatuses) {
      status.publishedMarkdown ??= "";
      status.draftMarkdown ??= status.publishedMarkdown;
      status.draftRevision ??= status.publishedMarkdown ? 1 : 0;
      status.version ??= 0;
      status.publishedAt ??= null;
      status.publishedBy ??= null;
      status.updatedAt ??= status.publishedAt || now();
      status.updatedBy ??= status.publishedBy || "seed";
      status.codexState ??= null;
      status.codexRequestedAt ??= null;
      status.draftSourceRefs ||= [];
      status.publishedSourceRefs ||= [];
      status.codexAssisted ??= false;
    }
    for (const suggestion of this.data.statusSuggestions) {
      suggestion.status ||= "open";
      suggestion.sourceRefs ||= [];
    }
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
    const operation = this.writeChain.then(async () => {
      const mutation = await fn(this.data) || {};
      this.data.storeRevision += 1;
      await this.#save();
      output = mutation.result;
      for (const event of mutation.events || []) {
        this.emit("event", { ...event, storeRevision: this.data.storeRevision });
      }
    });
    this.writeChain = operation.catch(() => {});
    await operation;
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

  membership(spaceId, profileId, data = this.data) {
    return data.memberships.find((item) => item.spaceId === spaceId && item.profileId === profileId) || null;
  }

  leadMembership(spaceId, data = this.data) {
    return data.memberships.find((item) => item.spaceId === spaceId && item.role === "lead") || null;
  }

  #requireMembership(data, spaceId, profileId) {
    const membership = this.membership(spaceId, profileId, data);
    if (!membership) throw new StoreError("not_a_member", "Join this theorem space before continuing.", 403);
    return membership;
  }

  #requireLead(data, spaceId, profileId) {
    const membership = this.#requireMembership(data, spaceId, profileId);
    if (membership.role !== "lead") throw new StoreError("lead_required", "The theorem-space lead must perform this coordination action.", 403);
    return membership;
  }

  #isTaskParticipant(task, profileId) {
    return task.primaryContributorId === profileId || task.collaboratorIds.includes(profileId);
  }

  #currentStatus(data, spaceId) {
    return data.currentStatuses.find((item) => item.spaceId === spaceId) || null;
  }

  #ensureCurrentStatus(data, spaceId, actorId) {
    let status = this.#currentStatus(data, spaceId);
    if (status) return status;
    const createdAt = now();
    status = {
      id: randomUUID(), spaceId, publishedMarkdown: "", draftMarkdown: "", draftRevision: 0, version: 0,
      publishedAt: null, publishedBy: null, updatedAt: createdAt, updatedBy: actorId,
      codexState: null, codexRequestedAt: null, draftSourceRefs: [], publishedSourceRefs: [], codexAssisted: false
    };
    data.currentStatuses.push(status);
    return status;
  }

  #statusView(status, includeDraft = false) {
    if (!status) return null;
    if (includeDraft) return clone(status);
    return {
      id: status.id, spaceId: status.spaceId, publishedMarkdown: status.publishedMarkdown,
      version: status.version, publishedAt: status.publishedAt, publishedBy: status.publishedBy
    };
  }

  async join({ inviteSlug, displayName, pin }) {
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
      } else {
        const salt = randomBytes(16).toString("hex");
        profile = {
          id: randomUUID(),
          displayName: name,
          normalizedName,
          pinSalt: salt,
          pinHash: scryptSync(String(pin), salt, 32).toString("hex"),
          initials: name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(""),
          color: nextProfileColor(data.profiles),
          interestTags: [],
          activeSpaceId: space.id,
          activeResultId: null,
          createdAt: now(),
          lastSeenAt: now()
        };
        data.profiles.push(profile);
      }
      let membership = data.memberships.find((item) => item.spaceId === space.id && item.profileId === profile.id);
      if (!membership) {
        const role = data.memberships.some((item) => item.spaceId === space.id && item.role === "lead") ? "contributor" : "lead";
        membership = { id: randomUUID(), spaceId: space.id, profileId: profile.id, role, joinedAt: now() };
        data.memberships.push(membership);
      }
      data.sessions.push({ id: randomUUID(), profileId: profile.id, tokenHash: hashToken(token), createdAt: now(), lastSeenAt: now() });
      return {
        result: { token, profile: this.publicProfile(profile), space, membership },
        events: [{ type: "profile.upsert", spaceId: space.id, entity: this.publicProfile(profile) }, { type: "entity.upsert", entityType: "membership", entity: membership, spaceId: space.id }]
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

  async createSpace(token, input) {
    const { profile } = this.requireSession(token);
    const name = String(input.name || "").trim();
    if (name.length < 2 || name.length > 80) throw new StoreError("invalid_space_name", "Use a theorem space name between 2 and 80 characters.");
    return this.mutate((data) => {
      const baseSlug = slugify(name);
      let inviteSlug = baseSlug;
      let suffix = 2;
      while (data.spaces.some((item) => item.inviteSlug === inviteSlug)) inviteSlug = `${baseSlug}-${suffix++}`;
      const createdAt = now();
      const space = { id: randomUUID(), inviteSlug, name, description: String(input.description || "").slice(0, 240), rootResultId: null, pendingLeadProfileId: null, createdBy: profile.id, createdAt, updatedAt: createdAt };
      const membership = { id: randomUUID(), spaceId: space.id, profileId: profile.id, role: "lead", joinedAt: createdAt };
      data.spaces.push(space);
      data.memberships.push(membership);
      const events = [{ type: "space.updated", spaceId: space.id, entity: clone(space) }, { type: "entity.upsert", entityType: "membership", entity: membership, spaceId: space.id }];
      let rootResult = null;
      const rootStatement = String(input.rootStatement || "").trim();
      if (rootStatement) {
        rootResult = {
          id: randomUUID(), spaceId: space.id, title: String(input.rootTitle || "Root problem").slice(0, 120), kind: "conjecture", relevanceStatus: null,
          statementLatex: rootStatement, hypothesesLatex: [], proofMarkdown: "", status: "draft", version: 0, draftRevision: 1,
          submittedRevisionId: null, lastCodexReviewAt: null, lastCodexReviewContentLength: 0, citation: "", bibtex: "", sourceType: "original",
          sourceSpaceId: null, sourceResultId: null, tags: ["root-problem"], dependencyIds: [], taskId: null, collaboratorIds: [],
          x: 360, y: 120, starredBy: [], provedByProofIds: [], refutedByCounterexampleIds: [], createdBy: profile.id, updatedBy: profile.id, createdAt, updatedAt: createdAt
        };
        data.results.push(rootResult);
        space.rootResultId = rootResult.id;
        events.push(...this.#eventsFor("result", rootResult));
      }
      const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "space.created", entityType: "space", entityId: space.id, summary: `${profile.displayName} created ${space.name}.` });
      events.push({ type: "activity.new", spaceId: space.id, entity: activity });
      return { result: { space, membership, rootResult }, events };
    });
  }

  async setRootResult(token, spaceId, resultId) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const space = data.spaces.find((item) => item.id === spaceId);
      if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
      this.#requireLead(data, space.id, profile.id);
      const result = data.results.find((item) => item.id === resultId && item.spaceId === space.id);
      if (!result) throw new StoreError("result_not_found", "Choose a result from this theorem space.", 404);
      space.rootResultId = result.id;
      space.updatedAt = now();
      const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "space.root_changed", entityType: "result", entityId: result.id, summary: `${profile.displayName} designated ${result.title} as the root problem.` });
      return { result: space, events: [{ type: "space.updated", spaceId: space.id, entity: clone(space) }, { type: "activity.new", spaceId: space.id, entity: activity }] };
    });
  }

  async offerLeadTransfer(token, spaceId, profileId) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const space = data.spaces.find((item) => item.id === spaceId);
      if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
      this.#requireLead(data, space.id, profile.id);
      const targetMembership = this.membership(space.id, profileId, data);
      if (!targetMembership || targetMembership.role === "lead") throw new StoreError("invalid_lead_target", "Choose another member of this theorem space.");
      space.pendingLeadProfileId = profileId;
      space.updatedAt = now();
      const notification = this.#notification(data, { spaceId: space.id, userId: profileId, type: "lead_transfer", title: "Lead transfer offered", body: `${profile.displayName} invited you to coordinate ${space.name}.`, entityType: "space", entityId: space.id, dedupeKey: `lead-transfer:${space.id}:${profileId}:${space.updatedAt}`, createdBy: profile.id });
      return { result: space, events: [{ type: "space.updated", spaceId: space.id, entity: clone(space) }, { type: "notification.new", notification, spaceId: space.id, audienceUserIds: [profileId] }] };
    });
  }

  async respondLeadTransfer(token, spaceId, accept) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const space = data.spaces.find((item) => item.id === spaceId);
      if (!space || space.pendingLeadProfileId !== profile.id) throw new StoreError("lead_transfer_not_found", "No lead transfer is waiting for you.", 404);
      const previousLead = this.leadMembership(space.id, data);
      const nextLead = this.#requireMembership(data, space.id, profile.id);
      space.pendingLeadProfileId = null;
      space.updatedAt = now();
      const events = [{ type: "space.updated", spaceId: space.id, entity: clone(space) }];
      if (accept) {
        if (previousLead) previousLead.role = "contributor";
        nextLead.role = "lead";
        events.push({ type: "entity.upsert", entityType: "membership", entity: clone(nextLead), spaceId: space.id });
        if (previousLead) events.push({ type: "entity.upsert", entityType: "membership", entity: clone(previousLead), spaceId: space.id });
        const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "space.lead_transferred", entityType: "space", entityId: space.id, summary: `${profile.displayName} accepted coordination of ${space.name}.` });
        events.push({ type: "activity.new", spaceId: space.id, entity: activity });
      }
      if (previousLead) {
        const notification = this.#notification(data, { spaceId: space.id, userId: previousLead.profileId, type: "lead_transfer", title: accept ? "Lead transfer accepted" : "Lead transfer declined", body: `${profile.displayName} ${accept ? "accepted" : "declined"} the invitation to coordinate ${space.name}.`, entityType: "space", entityId: space.id, dedupeKey: `lead-transfer-response:${space.id}:${profile.id}:${space.updatedAt}`, createdBy: profile.id });
        events.push({ type: "notification.new", notification, spaceId: space.id, audienceUserIds: [previousLead.profileId] });
      }
      return { result: { space, membership: nextLead, accepted: Boolean(accept) }, events };
    });
  }

  async renameSpace(token, spaceId, name) {
    const { profile } = this.requireSession(token);
    const nextName = String(name || "").trim();
    if (nextName.length < 2 || nextName.length > 80) throw new StoreError("invalid_space_name", "Use a theorem space name between 2 and 80 characters.");
    return this.mutate((data) => {
      const space = data.spaces.find((item) => item.id === spaceId);
      if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
      this.#requireLead(data, space.id, profile.id);
      const previousName = space.name;
      space.name = nextName;
      space.updatedAt = now();
      const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "space.renamed", entityType: "space", entityId: space.id, summary: `${profile.displayName} renamed ${previousName} to ${nextName}.` });
      return { result: space, events: [{ type: "space.updated", spaceId: space.id, entity: clone(space) }, { type: "activity.new", spaceId: space.id, entity: activity }] };
    });
  }

  async updateCurrentStatusDraft(token, spaceId, input) {
    const { profile } = this.requireSession(token);
    const markdown = String(input.markdown ?? "");
    if (markdown.length > 50_000) throw new StoreError("status_too_long", "Keep the current status under 50,000 characters.");
    return this.mutate((data) => {
      const space = data.spaces.find((item) => item.id === spaceId);
      if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
      this.#requireLead(data, space.id, profile.id);
      const status = this.#ensureCurrentStatus(data, space.id, profile.id);
      if (input.baseDraftRevision !== undefined && Number(input.baseDraftRevision) !== status.draftRevision) {
        throw new StoreError("status_revision_mismatch", "The current status draft changed. Reload it before saving.", 409);
      }
      if (status.draftMarkdown === markdown) return { result: status, events: [] };
      status.draftMarkdown = markdown;
      status.draftRevision += 1;
      status.updatedAt = now();
      status.updatedBy = profile.id;
      status.codexAssisted = false;
      status.draftSourceRefs = [];
      for (const suggestion of data.statusSuggestions) {
        if (suggestion.statusId === status.id && suggestion.status === "open") suggestion.status = "stale";
      }
      return {
        result: status,
        events: [{ type: "entity.upsert", entityType: "current_status", entity: clone(status), spaceId: space.id, audienceUserIds: [profile.id] }]
      };
    });
  }

  async requestCurrentStatusAssistance(token, spaceId, mode) {
    const { profile } = this.requireSession(token);
    if (!["fill", "review"].includes(mode)) throw new StoreError("invalid_status_assistance", "Choose Fill with Codex or Ask Codex.");
    return this.mutate((data) => {
      const space = data.spaces.find((item) => item.id === spaceId);
      if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
      this.#requireLead(data, space.id, profile.id);
      const status = this.#ensureCurrentStatus(data, space.id, profile.id);
      if (mode === "review" && !status.draftMarkdown.trim()) throw new StoreError("empty_status", "Write a current status before asking Codex to review it.");
      if (status.codexState) throw new StoreError("status_codex_busy", "Codex is already working on this current status.", 409);
      const type = mode === "fill" ? "fill_current_status" : "review_current_status";
      const work = this.#queue(data, {
        type, spaceId: space.id, entityType: "current_status", entityId: status.id,
        targetRevision: String(status.draftRevision), payload: { requestedBy: profile.id }, manual: true
      });
      status.codexState = mode === "fill" ? "drafting" : "reviewing";
      status.codexRequestedAt = now();
      status.updatedAt = now();
      return {
        result: { status, work },
        events: [
          { type: "entity.upsert", entityType: "current_status", entity: clone(status), spaceId: space.id, audienceUserIds: [profile.id] },
          { type: "queue.changed", spaceId: space.id, pendingCount: this.pendingWorkCount(data) }
        ]
      };
    });
  }

  async publishCurrentStatus(token, spaceId, input = {}) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const space = data.spaces.find((item) => item.id === spaceId);
      if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
      this.#requireLead(data, space.id, profile.id);
      const status = this.#currentStatus(data, space.id);
      if (!status || !status.draftMarkdown.trim()) throw new StoreError("empty_status", "Add a current status before publishing it.");
      if (input.baseDraftRevision !== undefined && Number(input.baseDraftRevision) !== status.draftRevision) {
        throw new StoreError("status_revision_mismatch", "The current status draft changed. Reload it before publishing.", 409);
      }
      const publishedAt = now();
      status.version += 1;
      status.publishedMarkdown = status.draftMarkdown;
      status.publishedSourceRefs = clone(status.draftSourceRefs || []);
      status.publishedAt = publishedAt;
      status.publishedBy = profile.id;
      status.updatedAt = publishedAt;
      status.updatedBy = profile.id;
      status.codexState = null;
      status.codexRequestedAt = null;
      const history = {
        id: randomUUID(), statusId: status.id, spaceId: space.id, version: status.version,
        markdown: status.publishedMarkdown, sourceRefs: clone(status.publishedSourceRefs),
        codexAssisted: Boolean(status.codexAssisted), publishedAt, publishedBy: profile.id
      };
      data.statusHistory.push(history);
      status.codexAssisted = false;
      for (const suggestion of data.statusSuggestions) {
        if (suggestion.statusId === status.id && suggestion.status === "open") suggestion.status = "stale";
      }
      const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "current_status.published", entityType: "current_status", entityId: status.id, summary: `${profile.displayName} published current status v${status.version}.` });
      const events = [
        { type: "entity.upsert", entityType: "current_status", entity: this.#statusView(status, false), spaceId: space.id },
        { type: "entity.upsert", entityType: "current_status", entity: clone(status), spaceId: space.id, audienceUserIds: [profile.id] },
        { type: "entity.upsert", entityType: "status_history", entity: history, spaceId: space.id },
        { type: "activity.new", entity: activity, spaceId: space.id }
      ];
      const memberIds = data.memberships.filter((item) => item.spaceId === space.id && item.profileId !== profile.id).map((item) => item.profileId);
      for (const userId of memberIds) {
        const notification = this.#notification(data, {
          spaceId: space.id, userId, type: "current_status_published", title: "Current status updated",
          body: `${profile.displayName} published version ${status.version} for ${space.name}.`, entityType: "current_status", entityId: status.id,
          dedupeKey: `current-status-published:${status.id}:${status.version}:${userId}`, createdBy: profile.id
        });
        events.push({ type: "notification.new", notification, spaceId: space.id, audienceUserIds: [userId] });
      }
      return { result: { status, history }, events };
    });
  }

  async respondCurrentStatusSuggestion(token, suggestionId, accept) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const suggestion = data.statusSuggestions.find((item) => item.id === suggestionId && item.status === "open");
      if (!suggestion) throw new StoreError("status_suggestion_not_found", "This Codex suggestion is no longer available.", 404);
      this.#requireLead(data, suggestion.spaceId, profile.id);
      const status = data.currentStatuses.find((item) => item.id === suggestion.statusId);
      if (!status) throw new StoreError("status_not_found", "Current status not found.", 404);
      if (accept && suggestion.baseDraftRevision !== status.draftRevision) throw new StoreError("status_suggestion_stale", "The draft changed after Codex prepared this suggestion.", 409);
      suggestion.status = accept ? "applied" : "dismissed";
      suggestion.actedBy = profile.id;
      suggestion.actedAt = now();
      const events = [{ type: "entity.upsert", entityType: "status_suggestion", entity: clone(suggestion), spaceId: suggestion.spaceId, audienceUserIds: [profile.id] }];
      if (accept) {
        status.draftMarkdown = suggestion.proposedMarkdown;
        status.draftRevision += 1;
        status.draftSourceRefs = clone(suggestion.sourceRefs || []);
        status.codexAssisted = true;
        status.updatedAt = now();
        status.updatedBy = profile.id;
        events.push({ type: "entity.upsert", entityType: "current_status", entity: clone(status), spaceId: suggestion.spaceId, audienceUserIds: [profile.id] });
      }
      return { result: { suggestion, status }, events };
    });
  }

  bootstrap({ token, spaceId }) {
    const { profile } = this.requireSession(token);
    const space = this.getSpace(spaceId || profile.activeSpaceId) || this.data.spaces[0];
    const currentMembership = this.membership(space.id, profile.id);
    if (!currentMembership) throw new StoreError("not_a_member", "Join this theorem space before continuing.", 403);
    const resultIds = new Set(this.data.results.filter((item) => item.spaceId === space.id).map((item) => item.id));
    const visibleNotifications = this.data.notifications.filter((item) => item.spaceId === space.id && (!item.userId || item.userId === profile.id));
    const currentStatus = this.#currentStatus(this.data, space.id);
    return {
      storeRevision: this.data.storeRevision,
      profile: this.publicProfile(profile),
      space,
      spaces: clone(this.data.spaces),
      profiles: this.data.profiles.map((item) => this.publicProfile(item)),
      memberships: clone(this.data.memberships.filter((item) => item.spaceId === space.id)),
      currentMembership: clone(currentMembership),
      spaceLead: this.publicProfile(this.data.profiles.find((item) => item.id === this.leadMembership(space.id)?.profileId)),
      tasks: clone(this.data.tasks.filter((item) => item.spaceId === space.id && (item.approvalState === "official" || currentMembership.role === "lead" || item.proposedBy === profile.id)).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))),
      results: clone(this.data.results.filter((item) => item.spaceId === space.id)),
      edges: clone(this.data.edges.filter((item) => item.spaceId === space.id)),
      revisions: clone(this.data.revisions.filter((item) => resultIds.has(item.resultId))),
      reviews: clone(this.data.reviews.filter((item) => resultIds.has(item.resultId))),
      comments: clone(this.data.comments.filter((item) => resultIds.has(item.resultId))),
      draftFeedback: clone(this.data.draftFeedback.filter((item) => resultIds.has(item.resultId))),
      suggestions: clone(this.data.suggestions.filter((item) => item.spaceId === space.id && item.status === "open" && (!item.audienceUserIds?.length || item.audienceUserIds.includes(profile.id)))),
      currentStatus: this.#statusView(currentStatus, currentMembership.role === "lead"),
      statusHistory: clone(this.data.statusHistory.filter((item) => item.spaceId === space.id).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 20)),
      statusSuggestions: currentMembership.role === "lead" ? clone(this.data.statusSuggestions.filter((item) => item.spaceId === space.id && item.status === "open")) : [],
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
      if (Array.isArray(patch.interestTags)) target.interestTags = patch.interestTags.slice(0, 12).map(String);
      let membership = null;
      if (patch.activeSpaceId && data.spaces.some((space) => space.id === patch.activeSpaceId)) {
        target.activeSpaceId = patch.activeSpaceId;
        membership = this.membership(target.activeSpaceId, target.id, data);
        if (!membership) {
          const role = data.memberships.some((item) => item.spaceId === target.activeSpaceId && item.role === "lead") ? "contributor" : "lead";
          membership = { id: randomUUID(), spaceId: target.activeSpaceId, profileId: target.id, role, joinedAt: now() };
          data.memberships.push(membership);
        }
      }
      target.lastSeenAt = now();
      const events = [{ type: "profile.upsert", spaceId: target.activeSpaceId, entity: this.publicProfile(target) }];
      if (membership) events.push({ type: "entity.upsert", entityType: "membership", entity: clone(membership), spaceId: target.activeSpaceId });
      return { result: this.publicProfile(target), events };
    });
  }

  async createTask(token, input) {
    const { profile } = this.requireSession(token);
    const space = this.getSpace(input.spaceId || profile.activeSpaceId);
    if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
    const title = String(input.title || "").trim();
    const goal = String(input.goal || "").trim();
    if (title.length < 2 || title.length > 120) throw new StoreError("invalid_task_title", "Use a task title between 2 and 120 characters.");
    if (goal.length < 4 || goal.length > 1000) throw new StoreError("invalid_task_goal", "Describe the mathematical goal in 4 to 1000 characters.");
    return this.mutate((data) => {
      const membership = this.#requireMembership(data, space.id, profile.id);
      const parent = input.parentTaskId ? data.tasks.find((item) => item.id === input.parentTaskId && item.spaceId === space.id && item.approvalState === "official") : null;
      const proposed = membership.role !== "lead";
      if (proposed && (!parent || !this.#isTaskParticipant(parent, profile.id))) throw new StoreError("task_scope_required", "You may propose a subtask only within an accepted assignment.", 403);
      if (input.parentTaskId && !parent) throw new StoreError("parent_task_not_found", "Parent task not found.", 404);
      const targetResultId = input.targetResultId || parent?.targetResultId || null;
      if (targetResultId && !data.results.some((item) => item.id === targetResultId && item.spaceId === space.id)) throw new StoreError("invalid_task_target", "Task target not found in this theorem space.");
      const expectedRelation = ["proves", "refutes", "supports"].includes(input.expectedRelation) ? input.expectedRelation : null;
      const sortOrder = Math.max(-1, ...data.tasks.filter((item) => item.spaceId === space.id && item.approvalState === "official").map((item) => Number(item.sortOrder) || 0)) + 1;
      const task = {
        id: randomUUID(), spaceId: space.id, title, goal,
        priority: TASK_PRIORITIES.has(input.priority) ? input.priority : "normal", status: "open", sortOrder,
        parentTaskId: parent?.id || null, targetResultId, expectedRelation, outputResultIds: [],
        approvalState: proposed ? "proposed" : "official", proposedBy: proposed ? profile.id : null,
        primaryContributorId: null, collaboratorIds: [], pendingVolunteerIds: [], invitedProfileIds: [],
        blockedReason: "", createdBy: profile.id, updatedBy: profile.id, completedBy: null,
        createdAt: now(), updatedAt: now(), completedAt: null
      };
      data.tasks.push(task);
      const events = [];
      const lead = this.leadMembership(space.id, data);
      if (proposed && lead) {
        const notification = this.#notification(data, { spaceId: space.id, userId: lead.profileId, type: "task_proposal", title: "Subtask proposed", body: `${profile.displayName} proposed ${task.title}.`, entityType: "task", entityId: task.id, dedupeKey: `task-proposal:${task.id}`, createdBy: profile.id });
        events.push({ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: space.id, audienceUserIds: [lead.profileId, profile.id] }, { type: "notification.new", notification, spaceId: space.id, audienceUserIds: [lead.profileId] });
      } else {
        events.push({ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: space.id });
        const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "task.created", entityType: "task", entityId: task.id, summary: `${profile.displayName} added official task ${task.title}.` });
        events.push({ type: "activity.new", spaceId: space.id, entity: activity });
      }
      return { result: task, events };
    });
  }

  async updateTask(token, taskId, patch) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const task = data.tasks.find((item) => item.id === taskId);
      if (!task) throw new StoreError("task_not_found", "Task not found.", 404);
      const membership = this.#requireMembership(data, task.spaceId, profile.id);
      const lead = membership.role === "lead";
      const participant = this.#isTaskParticipant(task, profile.id);
      if (!lead && !participant && !(task.approvalState === "proposed" && task.proposedBy === profile.id)) throw new StoreError("task_access_denied", "Only the lead or accepted task participants may update this task.", 403);
      if (task.approvalState === "proposed" && !lead && task.proposedBy !== profile.id) throw new StoreError("task_access_denied", "This proposal is not yours.", 403);
      if (task.approvalState !== "official" && "status" in patch) throw new StoreError("proposal_not_official", "Approve this proposal before changing its work status.", 409);
      if (lead || task.approvalState === "proposed") {
        if ("title" in patch) {
          const title = String(patch.title || "").trim();
          if (title.length < 2 || title.length > 120) throw new StoreError("invalid_task_title", "Use a task title between 2 and 120 characters.");
          task.title = title;
        }
        if ("goal" in patch) {
          const goal = String(patch.goal || "").trim();
          if (goal.length < 4 || goal.length > 1000) throw new StoreError("invalid_task_goal", "Describe the mathematical goal in 4 to 1000 characters.");
          task.goal = goal;
        }
      }
      if (lead) {
        if ("priority" in patch && TASK_PRIORITIES.has(patch.priority)) task.priority = patch.priority;
        if ("sortOrder" in patch) task.sortOrder = Math.max(0, Number(patch.sortOrder) || 0);
        if ("expectedRelation" in patch) task.expectedRelation = ["proves", "refutes", "supports"].includes(patch.expectedRelation) ? patch.expectedRelation : null;
        if ("targetResultId" in patch) {
          if (patch.targetResultId && !data.results.some((item) => item.id === patch.targetResultId && item.spaceId === task.spaceId)) throw new StoreError("invalid_task_target", "Task target not found.");
          task.targetResultId = patch.targetResultId || null;
        }
      }
      if ("status" in patch) {
        const next = TASK_STATUSES.has(patch.status) ? patch.status : task.status;
        if (next === "blocked") {
          const reason = String(patch.blockedReason || "").trim();
          if (reason.length < 4) throw new StoreError("blocked_reason_required", "Explain what is blocking the task.");
          task.blockedReason = reason.slice(0, 500);
        }
        if (next === "done" && ["proves", "refutes"].includes(task.expectedRelation)) {
          const verified = data.edges.some((edge) => task.outputResultIds.includes(edge.sourceResultId) && edge.targetResultId === task.targetResultId && edge.relation === task.expectedRelation && edge.verificationStatus === "verified");
          if (!verified) throw new StoreError("verified_output_required", "This task completes when Codex validates its expected relationship.", 409);
        }
        if (next === "open" && task.status === "done" && !lead) throw new StoreError("lead_required", "Only the lead can reopen completed work.", 403);
        if (next === "open" && lead && !["blocked", "done"].includes(task.status) && Date.now() - new Date(task.updatedAt).getTime() < 7 * 86400_000) throw new StoreError("task_still_active", "Active work can be force-reopened after seven days without an update.", 409);
        task.status = next;
        if (next === "open" && lead && patch.clearAssignment === true) {
          task.primaryContributorId = null;
          task.collaboratorIds = [];
        }
        if (next !== "blocked") task.blockedReason = "";
        if (next === "done") {
          task.completedBy = profile.id;
          task.completedAt = now();
        } else {
          task.completedBy = null;
          task.completedAt = null;
        }
      }
      task.updatedBy = profile.id;
      task.updatedAt = now();
      const activity = this.#activity(data, { spaceId: task.spaceId, actorId: profile.id, action: `task.${task.status}`, entityType: "task", entityId: task.id, summary: `${profile.displayName} updated ${task.title} to ${task.status.replace("_", " ")}.` });
      const events = [{ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId }, { type: "activity.new", spaceId: task.spaceId, entity: activity }];
      const leadMembership = this.leadMembership(task.spaceId, data);
      if (task.status === "blocked" && leadMembership && leadMembership.profileId !== profile.id) {
        const notification = this.#notification(data, { spaceId: task.spaceId, userId: leadMembership.profileId, type: "task_blocked", title: "Task blocked", body: `${task.title}: ${task.blockedReason}`, entityType: "task", entityId: task.id, dedupeKey: `task-blocked:${task.id}:${task.updatedAt}`, createdBy: profile.id });
        events.push({ type: "notification.new", notification, spaceId: task.spaceId, audienceUserIds: [leadMembership.profileId] });
      }
      return { result: task, events };
    });
  }

  async volunteerForTask(token, taskId) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const task = data.tasks.find((item) => item.id === taskId && item.approvalState === "official");
      if (!task) throw new StoreError("task_not_found", "Official task not found.", 404);
      if (task.status === "done") throw new StoreError("task_complete", "The lead must reopen this task before new volunteers join.", 409);
      this.#requireMembership(data, task.spaceId, profile.id);
      if (this.#isTaskParticipant(task, profile.id)) throw new StoreError("already_participating", "You are already participating in this task.", 409);
      if (!task.pendingVolunteerIds.includes(profile.id)) task.pendingVolunteerIds.push(profile.id);
      task.invitedProfileIds = task.invitedProfileIds.filter((id) => id !== profile.id);
      task.updatedAt = now();
      const lead = this.leadMembership(task.spaceId, data);
      const events = [{ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId }];
      if (lead && lead.profileId !== profile.id) {
        const notification = this.#notification(data, { spaceId: task.spaceId, userId: lead.profileId, type: "task_volunteer", title: "Volunteer waiting", body: `${profile.displayName} volunteered for ${task.title}.`, entityType: "task", entityId: task.id, dedupeKey: `task-volunteer:${task.id}:${profile.id}`, createdBy: profile.id });
        events.push({ type: "notification.new", notification, spaceId: task.spaceId, audienceUserIds: [lead.profileId] });
      }
      return { result: task, events };
    });
  }

  async respondVolunteer(token, taskId, input) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const task = data.tasks.find((item) => item.id === taskId && item.approvalState === "official");
      if (!task) throw new StoreError("task_not_found", "Official task not found.", 404);
      if (task.status === "done") throw new StoreError("task_complete", "Reopen this task before accepting another volunteer.", 409);
      this.#requireLead(data, task.spaceId, profile.id);
      const volunteerId = input.profileId;
      if (!task.pendingVolunteerIds.includes(volunteerId)) throw new StoreError("volunteer_not_found", "That volunteer request is no longer pending.", 404);
      task.pendingVolunteerIds = task.pendingVolunteerIds.filter((id) => id !== volunteerId);
      const accepted = input.decision === "accept";
      if (accepted) {
        if (input.role === "collaborator" || (task.primaryContributorId && task.primaryContributorId !== volunteerId)) {
          if (!task.collaboratorIds.includes(volunteerId)) task.collaboratorIds.push(volunteerId);
        } else task.primaryContributorId = volunteerId;
        if (task.status === "open") task.status = "claimed";
      }
      task.updatedBy = profile.id;
      task.updatedAt = now();
      const notification = this.#notification(data, { spaceId: task.spaceId, userId: volunteerId, type: "task_volunteer_response", title: accepted ? "Volunteer request accepted" : "Task coverage updated", body: accepted ? `You are now ${task.primaryContributorId === volunteerId ? "the primary contributor" : "a collaborator"} on ${task.title}.` : `${task.title} is being covered by the current assignment.`, entityType: "task", entityId: task.id, dedupeKey: `task-volunteer-response:${task.id}:${volunteerId}:${task.updatedAt}`, createdBy: profile.id });
      const activity = accepted ? this.#activity(data, { spaceId: task.spaceId, actorId: profile.id, action: "task.volunteer_accepted", entityType: "task", entityId: task.id, summary: `${profile.displayName} accepted a volunteer for ${task.title}.` }) : null;
      const events = [{ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId }, { type: "notification.new", notification, spaceId: task.spaceId, audienceUserIds: [volunteerId] }];
      if (activity) events.push({ type: "activity.new", spaceId: task.spaceId, entity: activity });
      return { result: task, events };
    });
  }

  async inviteToTask(token, taskId, profileId) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const task = data.tasks.find((item) => item.id === taskId && item.approvalState === "official");
      if (!task) throw new StoreError("task_not_found", "Official task not found.", 404);
      if (task.status === "done") throw new StoreError("task_complete", "Reopen this task before inviting another contributor.", 409);
      this.#requireLead(data, task.spaceId, profile.id);
      const target = this.#requireMembership(data, task.spaceId, profileId);
      if (target.role === "lead" || this.#isTaskParticipant(task, profileId)) throw new StoreError("invalid_task_invite", "Choose an unassigned contributor.");
      if (!task.invitedProfileIds.includes(profileId)) task.invitedProfileIds.push(profileId);
      task.updatedAt = now();
      const notification = this.#notification(data, { spaceId: task.spaceId, userId: profileId, type: "task_invite", title: "Task invitation", body: `${profile.displayName} invited you to contribute to ${task.title}.`, entityType: "task", entityId: task.id, dedupeKey: `task-invite:${task.id}:${profileId}`, createdBy: profile.id });
      return { result: task, events: [{ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId }, { type: "notification.new", notification, spaceId: task.spaceId, audienceUserIds: [profileId] }] };
    });
  }

  async respondTaskInvitation(token, taskId, accept) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const task = data.tasks.find((item) => item.id === taskId && item.invitedProfileIds.includes(profile.id));
      if (!task) throw new StoreError("task_invite_not_found", "No task invitation is waiting for you.", 404);
      task.invitedProfileIds = task.invitedProfileIds.filter((id) => id !== profile.id);
      if (accept) {
        if (!task.primaryContributorId) task.primaryContributorId = profile.id;
        else if (!task.collaboratorIds.includes(profile.id)) task.collaboratorIds.push(profile.id);
        if (task.status === "open") task.status = "claimed";
      }
      task.updatedAt = now();
      const lead = this.leadMembership(task.spaceId, data);
      const events = [{ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId }];
      if (lead) {
        const notification = this.#notification(data, { spaceId: task.spaceId, userId: lead.profileId, type: "task_invite_response", title: accept ? "Task invitation accepted" : "Task invitation declined", body: `${profile.displayName} ${accept ? "accepted" : "declined"} the invitation to ${task.title}.`, entityType: "task", entityId: task.id, dedupeKey: `task-invite-response:${task.id}:${profile.id}:${task.updatedAt}`, createdBy: profile.id });
        events.push({ type: "notification.new", notification, spaceId: task.spaceId, audienceUserIds: [lead.profileId] });
      }
      return { result: task, events };
    });
  }

  async releaseTask(token, taskId) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const task = data.tasks.find((item) => item.id === taskId);
      if (!task || !this.#isTaskParticipant(task, profile.id)) throw new StoreError("task_participation_not_found", "You are not assigned to this task.", 404);
      if (task.status === "done") throw new StoreError("task_complete", "Completed task assignments remain in the record unless the lead reopens the task.", 409);
      if (task.primaryContributorId === profile.id) task.primaryContributorId = null;
      task.collaboratorIds = task.collaboratorIds.filter((id) => id !== profile.id);
      if (!task.primaryContributorId) task.status = "open";
      task.blockedReason = "";
      task.updatedAt = now();
      task.updatedBy = profile.id;
      const lead = this.leadMembership(task.spaceId, data);
      const activity = this.#activity(data, { spaceId: task.spaceId, actorId: profile.id, action: "task.released", entityType: "task", entityId: task.id, summary: `${profile.displayName} released ${task.title}.` });
      const events = [{ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId }, { type: "activity.new", spaceId: task.spaceId, entity: activity }];
      if (lead && lead.profileId !== profile.id) {
        const notification = this.#notification(data, { spaceId: task.spaceId, userId: lead.profileId, type: "task_released", title: "Task released", body: `${profile.displayName} released ${task.title}.`, entityType: "task", entityId: task.id, dedupeKey: `task-released:${task.id}:${profile.id}:${task.updatedAt}`, createdBy: profile.id });
        events.push({ type: "notification.new", notification, spaceId: task.spaceId, audienceUserIds: [lead.profileId] });
      }
      return { result: task, events };
    });
  }

  async respondTaskProposal(token, taskId, accept) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const task = data.tasks.find((item) => item.id === taskId && item.approvalState === "proposed");
      if (!task) throw new StoreError("task_proposal_not_found", "Task proposal not found.", 404);
      this.#requireLead(data, task.spaceId, profile.id);
      task.approvalState = accept ? "official" : "declined";
      task.updatedAt = now();
      task.updatedBy = profile.id;
      const proposer = task.proposedBy;
      const notification = this.#notification(data, { spaceId: task.spaceId, userId: proposer, type: "task_proposal_response", title: accept ? "Subtask added to blueprint" : "Subtask proposal closed", body: accept ? `${task.title} is now official work.` : `${task.title} was not added to the current blueprint.`, entityType: "task", entityId: task.id, dedupeKey: `task-proposal-response:${task.id}:${task.updatedAt}`, createdBy: profile.id });
      const events = [{ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId, ...(accept ? {} : { audienceUserIds: [proposer, profile.id] }) }, { type: "notification.new", notification, spaceId: task.spaceId, audienceUserIds: [proposer] }];
      if (accept) {
        const activity = this.#activity(data, { spaceId: task.spaceId, actorId: profile.id, action: "task.proposal_accepted", entityType: "task", entityId: task.id, summary: `${profile.displayName} added ${task.title} to the official blueprint.` });
        events.push({ type: "activity.new", spaceId: task.spaceId, entity: activity });
      }
      return { result: task, events };
    });
  }

  #linkTaskOutput(data, task, result, actorId) {
    if (!task.outputResultIds.includes(result.id)) task.outputResultIds.push(result.id);
    result.taskId = task.id;
    if (["open", "claimed"].includes(task.status)) task.status = "in_progress";
    task.updatedBy = actorId;
    task.updatedAt = now();
  }

  async linkTaskOutput(token, taskId, resultId) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const task = data.tasks.find((item) => item.id === taskId && item.approvalState === "official");
      const result = data.results.find((item) => item.id === resultId && item.spaceId === task?.spaceId);
      if (!task || !result) throw new StoreError("task_output_not_found", "Task or result not found.", 404);
      const membership = this.#requireMembership(data, task.spaceId, profile.id);
      if (membership.role !== "lead" && !this.#isTaskParticipant(task, profile.id)) throw new StoreError("task_scope_required", "Only accepted participants may link output to this task.", 403);
      this.#linkTaskOutput(data, task, result, profile.id);
      return { result: { task, result }, events: [...this.#eventsFor("result", result), { type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId }] };
    });
  }

  async createResult(token, input) {
    const { profile } = this.requireSession(token);
    const space = this.getSpace(input.spaceId || profile.activeSpaceId);
    if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
    return this.mutate((data) => {
      const membership = this.#requireMembership(data, space.id, profile.id);
      const task = input.taskId ? data.tasks.find((item) => item.id === input.taskId && item.spaceId === space.id && item.approvalState === "official") : null;
      if (input.taskId && !task) throw new StoreError("task_not_found", "Official task not found.", 404);
      if (membership.role !== "lead" && (!task || !this.#isTaskParticipant(task, profile.id))) throw new StoreError("task_scope_required", "An accepted task assignment is required to create official mathematical work.", 403);
      if (membership.role !== "lead" && task.status === "done") throw new StoreError("task_complete", "The lead must reopen this task before more official work is added.", 409);
      const kind = RESULT_KINDS.has(input.kind) ? input.kind : input.tags?.includes("conjecture") ? "conjecture" : input.tags?.includes("proof") ? "proof" : "result";
      const collaborators = Array.isArray(input.collaboratorIds) ? input.collaboratorIds.filter((id) => id !== profile.id && this.membership(space.id, id, data)) : [];
      const result = {
        id: randomUUID(), spaceId: space.id, title: String(input.title || "Untitled result").slice(0, 120),
        kind, relevanceStatus: null,
        statementLatex: String(input.statementLatex || ""), hypothesesLatex: Array.isArray(input.hypothesesLatex) ? input.hypothesesLatex.map(String) : [],
        proofMarkdown: String(input.proofMarkdown || ""), status: "draft", version: 0, draftRevision: 1,
        submittedRevisionId: null, lastCodexReviewAt: null, lastCodexReviewContentLength: 0,
        citation: String(input.citation || ""), bibtex: String(input.bibtex || ""), sourceType: "original",
        sourceSpaceId: null, sourceResultId: null, tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        dependencyIds: Array.isArray(input.dependencyIds) ? input.dependencyIds : [], taskId: task?.id || null, collaboratorIds: collaborators,
        x: Number(input.x ?? 360), y: Number(input.y ?? 260), starredBy: [], provedByProofIds: [], refutedByCounterexampleIds: [],
        createdBy: profile.id, updatedBy: profile.id, createdAt: now(), updatedAt: now()
      };
      data.results.push(result);
      if (task) this.#linkTaskOutput(data, task, result, profile.id);
      const activity = this.#activity(data, { spaceId: space.id, actorId: profile.id, action: "result.created", entityType: "result", entityId: result.id, summary: `${profile.displayName} created ${result.title}.` });
      const events = [...this.#eventsFor("result", result), { type: "activity.new", spaceId: space.id, entity: activity }];
      if (task) events.push({ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: space.id });
      return { result, events };
    });
  }

  async updateResult(token, id, patch) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const result = data.results.find((item) => item.id === id);
      if (!result) throw new StoreError("result_not_found", "Result not found.", 404);
      this.#requireMembership(data, result.spaceId, profile.id);
      const contentChanged = ["kind", "title", "statementLatex", "hypothesesLatex", "proofMarkdown", "tags", "dependencyIds", "citation", "bibtex"].some((key) => key in patch);
      if (contentChanged && result.createdBy !== profile.id && !result.collaboratorIds.includes(profile.id)) throw new StoreError("result_edit_denied", "Only the author or an explicit coauthor may edit this result.", 403);
      if ("collaboratorIds" in patch && result.createdBy !== profile.id) throw new StoreError("result_edit_denied", "Only the result author may manage coauthors.", 403);
      if (contentChanged && !["draft", "pending_review"].includes(result.status)) throw new StoreError("result_locked", "Create a new revision before editing this result.", 409);
      if (contentChanged && result.status === "pending_review") throw new StoreError("result_locked", "This submitted revision is being reviewed.", 409);
      for (const [key, value] of Object.entries(patch)) {
        if (!EDITABLE_FIELDS.has(key)) continue;
        if (["x", "y"].includes(key)) result[key] = Math.max(0, Math.min(key === "x" ? 900 : 850, Number(value) || 0));
        else if (key === "kind") result[key] = RESULT_KINDS.has(value) ? value : "result";
        else if (["hypothesesLatex", "tags", "dependencyIds"].includes(key)) result[key] = Array.isArray(value) ? value.map(String) : [];
        else if (key === "collaboratorIds") result[key] = Array.isArray(value) ? [...new Set(value.filter((profileId) => profileId !== result.createdBy && this.membership(result.spaceId, profileId, data)))] : [];
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
      if (result.createdBy !== profile.id && !result.collaboratorIds.includes(profile.id)) throw new StoreError("result_edit_denied", "Only an author or coauthor may request draft coaching.", 403);
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
      if (result.createdBy !== profile.id && !result.collaboratorIds.includes(profile.id)) throw new StoreError("result_edit_denied", "Only an author or coauthor may submit this result.", 403);
      if (result.status !== "draft") throw new StoreError("not_a_draft", "Only drafts can be submitted.", 409);
      if (!result.statementLatex.trim()) throw new StoreError("incomplete_result", "Add a mathematical statement before submitting.");
      if (result.kind !== "conjecture" && !result.proofMarkdown.trim()) throw new StoreError("incomplete_result", "Add a statement and proof before submitting.");
      if (result.kind === "proof") {
        const provesEdge = data.edges.find((edge) => edge.sourceResultId === result.id && edge.relation === "proves" && edge.verificationStatus === "proposed");
        if (!provesEdge) throw new StoreError("missing_proves_edge", "Link this proof to the conjecture it proves before submitting.");
      }
      if (result.kind === "counterexample") {
        const refutesEdge = data.edges.find((edge) => edge.sourceResultId === result.id && edge.relation === "refutes" && edge.verificationStatus === "proposed");
        if (!refutesEdge) throw new StoreError("missing_refutes_edge", "Link this counterexample to the conjecture it refutes before submitting.");
      }
      data.workQueue = data.workQueue.filter((item) => !(item.entityId === resultId && item.type === "review_draft" && item.status === "pending"));
      result.version += 1;
      result.status = "pending_review";
      result.updatedAt = now();
      result.updatedBy = profile.id;
      const revision = { id: randomUUID(), resultId, revisionNumber: result.version, reason: "submitted", authorId: profile.id, status: result.status, snapshot: clone(result), createdAt: now() };
      result.submittedRevisionId = revision.id;
      revision.snapshot.submittedRevisionId = revision.id;
      data.revisions.push(revision);
      const workType = result.kind === "conjecture" ? "review_conjecture" : "validate_result";
      const work = this.#queue(data, { type: workType, spaceId: result.spaceId, entityId: resultId, targetRevision: revision.id, payload: { authorId: profile.id } });
      const reviewLabel = result.kind === "conjecture" ? "relevance" : result.kind === "counterexample" ? "refutation" : "proof";
      const activity = this.#activity(data, { spaceId: result.spaceId, actorId: profile.id, action: `${result.kind}.submitted`, entityType: "result", entityId: result.id, summary: `${profile.displayName} submitted ${result.title} for Codex ${reviewLabel} review.` });
      return { result: { result, work }, events: [...this.#eventsFor("result", result), { type: "activity.new", entity: activity, spaceId: result.spaceId }, { type: "queue.changed", spaceId: result.spaceId, pendingCount: this.pendingWorkCount(data) }] };
    });
  }

  async createEdge(token, input) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const source = data.results.find((item) => item.id === input.sourceResultId);
      const target = data.results.find((item) => item.id === input.targetResultId);
      if (!source || !target || source.spaceId !== target.spaceId) throw new StoreError("invalid_edge", "Both results must exist in the same theorem space.");
      if (source.id === target.id) throw new StoreError("invalid_edge", "A result cannot relate to itself.");
      const membership = this.#requireMembership(data, source.spaceId, profile.id);
      if (membership.role !== "lead") {
        const task = data.tasks.find((item) => item.id === source.taskId && item.approvalState === "official");
        if (!task || !this.#isTaskParticipant(task, profile.id) || (source.createdBy !== profile.id && !source.collaboratorIds.includes(profile.id))) throw new StoreError("task_scope_required", "Create relationships from work within your accepted assignment.", 403);
      }
      const relation = EDGE_RELATIONS.has(input.relation) ? input.relation : "uses";
      if (relation === "proves") {
        if (source.kind !== "proof") throw new StoreError("invalid_proof_source", "Only a Proof contribution can create a proves relationship.");
        if (target.kind !== "conjecture") throw new StoreError("invalid_proof_target", "A proves relationship must target a conjecture.");
        if (!["conjecture", "proved", "refuted"].includes(target.status)) throw new StoreError("unreviewed_proof_target", "The target conjecture must complete relevance review before it can be proved.", 409);
        if (data.edges.some((edge) => edge.sourceResultId === source.id && edge.relation === "proves")) throw new StoreError("proof_target_exists", "This proof already targets a conjecture.", 409);
      }
      if (relation === "refutes") {
        if (source.kind !== "counterexample") throw new StoreError("invalid_refutation_source", "Only a Counterexample contribution can create a refutes relationship.");
        if (target.kind !== "conjecture") throw new StoreError("invalid_refutation_target", "A refutes relationship must target a conjecture.");
        if (!["conjecture", "proved", "refuted"].includes(target.status)) throw new StoreError("unreviewed_refutation_target", "The target conjecture must complete relevance review before it can be refuted.", 409);
        if (data.edges.some((edge) => edge.sourceResultId === source.id && edge.relation === "refutes")) throw new StoreError("refutation_target_exists", "This counterexample already targets a conjecture.", 409);
      }
      if (data.edges.some((edge) => edge.sourceResultId === source.id && edge.targetResultId === target.id && edge.relation === relation)) throw new StoreError("duplicate_edge", "That relationship already exists.", 409);
      const requiresVerification = ["proves", "refutes"].includes(relation);
      const edge = {
        id: randomUUID(), spaceId: source.spaceId, sourceResultId: source.id, targetResultId: target.id, relation,
        verificationStatus: requiresVerification ? "proposed" : null,
        targetRevisionId: requiresVerification ? target.submittedRevisionId : null,
        verifiedBy: null, verifiedAt: null, createdBy: profile.id, createdAt: now()
      };
      data.edges.push(edge);
      return { result: edge, events: [{ type: "entity.upsert", entityType: "edge", entity: edge, spaceId: edge.spaceId }] };
    });
  }

  async deleteEdge(token, id) {
    const { profile } = this.requireSession(token);
    return this.mutate((data) => {
      const index = data.edges.findIndex((item) => item.id === id);
      if (index < 0) throw new StoreError("edge_not_found", "Edge not found.", 404);
      const edge = data.edges[index];
      const membership = this.#requireMembership(data, edge.spaceId, profile.id);
      const source = data.results.find((item) => item.id === edge.sourceResultId);
      if (membership.role !== "lead" && edge.createdBy !== profile.id && source?.createdBy !== profile.id && !source?.collaboratorIds?.includes(profile.id)) throw new StoreError("edge_delete_denied", "Only the edge author, source author, or lead may remove this relationship.", 403);
      if (["proves", "refutes"].includes(data.edges[index].relation) && data.edges[index].verificationStatus === "verified") throw new StoreError("verified_edge_locked", "A Codex-validated relationship cannot be deleted.", 409);
      const [removedEdge] = data.edges.splice(index, 1);
      return { result: removedEdge, events: [{ type: "entity.delete", entityType: "edge", id, spaceId: removedEdge.spaceId }] };
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
      const membership = this.#requireMembership(data, suggestion.spaceId, profile.id);
      const task = suggestion.taskId ? data.tasks.find((item) => item.id === suggestion.taskId && item.approvalState === "official") : null;
      if (suggestion.scope === "blueprint_change" && membership.role !== "lead") throw new StoreError("lead_required", "The lead must accept suggestions that expand the official blueprint.", 403);
      if (suggestion.scope === "within_task" && membership.role !== "lead" && (!task || !this.#isTaskParticipant(task, profile.id))) throw new StoreError("task_scope_required", "This suggestion is outside your accepted assignment.", 403);
      const events = [];
      for (const command of suggestion.proposedChanges || []) {
        if (command.type === "create_edge") {
          if (["proves", "refutes"].includes(command.relation)) continue;
          const source = data.results.find((item) => item.id === command.sourceResultId);
          const target = data.results.find((item) => item.id === command.targetResultId);
          if (!source || !target || source.spaceId !== suggestion.spaceId || target.spaceId !== suggestion.spaceId) continue;
          const exists = data.edges.some((edge) => edge.sourceResultId === source.id && edge.targetResultId === target.id && edge.relation === command.relation);
          if (!exists) {
            const edge = { id: randomUUID(), spaceId: suggestion.spaceId, sourceResultId: source.id, targetResultId: target.id, relation: EDGE_RELATIONS.has(command.relation) ? command.relation : "supports", verificationStatus: null, targetRevisionId: null, verifiedBy: null, verifiedAt: null, createdBy: profile.id, createdAt: now() };
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
      if (item.status === "failed" && ["fill_current_status", "review_current_status"].includes(item.type)) {
        const status = data.currentStatuses.find((entry) => entry.id === item.entityId);
        if (status) {
          status.codexState = null;
          status.codexRequestedAt = null;
        }
      }
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
      const state = item.type === "suggest_integrations" ? "integrating" : ["fill_current_status", "review_current_status"].includes(item.type) ? "summarizing" : "reviewing";
      data.agentStatus = { state, currentWorkType: item.type, updatedAt: now() };
      return { result: { empty: false, work: item, agentStatus: data.agentStatus }, events: [{ type: "agent.status", state: data.agentStatus }] };
    });
  }

  #buildCurrentStatusContext(work, status) {
    const space = this.getSpace(work.spaceId);
    const results = this.data.results.filter((item) => item.spaceId === work.spaceId);
    const resultIds = new Set(results.map((item) => item.id));
    const taskIds = new Set(this.data.tasks.filter((item) => item.spaceId === work.spaceId).map((item) => item.id));
    const resultTitles = new Map(results.map((item) => [item.id, item.title]));
    const taskTitles = new Map(this.data.tasks.filter((item) => item.spaceId === work.spaceId).map((item) => [item.id, item.title]));
    const timestampedHistory = [
      ...this.data.activity.filter((item) => item.spaceId === work.spaceId).map((item) => ({
        at: item.createdAt, type: "activity", summary: item.summary, entityType: item.entityType, entityId: item.entityId
      })),
      ...this.data.revisions.filter((item) => resultIds.has(item.resultId)).map((item) => ({
        at: item.createdAt, type: "result_revision", summary: `${resultTitles.get(item.resultId) || "Result"} revision ${item.revisionNumber} was ${String(item.reason || item.status).replaceAll("_", " ")}.`, entityType: "result", entityId: item.resultId, revisionId: item.id
      })),
      ...this.data.statusHistory.filter((item) => item.spaceId === work.spaceId).map((item) => ({
        at: item.publishedAt, type: "status_publication", summary: `Current status v${item.version} was published.`, entityType: "current_status", entityId: item.statusId, historyId: item.id
      })),
      ...this.data.tasks.filter((item) => item.spaceId === work.spaceId).map((item) => ({
        at: item.updatedAt, type: "task_state", summary: `${taskTitles.get(item.id)} is ${item.status.replaceAll("_", " ")}${item.blockedReason ? `: ${item.blockedReason}` : "."}`, entityType: "task", entityId: item.id
      }))
    ].filter((item) => item.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500);
    const members = this.data.memberships.filter((item) => item.spaceId === work.spaceId).map((membership) => ({
      ...clone(membership), profile: this.publicProfile(this.data.profiles.find((item) => item.id === membership.profileId))
    }));
    return clone({
      work,
      mode: work.type === "fill_current_status" ? "fill" : "review",
      baseDraftRevision: Number(work.targetRevision),
      space,
      currentStatus: status,
      rootProblem: space?.rootResultId ? this.getResult(space.rootResultId) : null,
      members,
      tasks: this.data.tasks.filter((item) => item.spaceId === work.spaceId && item.approvalState !== "declined"),
      results,
      edges: this.data.edges.filter((item) => item.spaceId === work.spaceId),
      revisions: this.data.revisions.filter((item) => resultIds.has(item.resultId)),
      reviews: this.data.reviews.filter((item) => resultIds.has(item.resultId)),
      comments: this.data.comments.filter((item) => resultIds.has(item.resultId)),
      suggestions: this.data.suggestions.filter((item) => item.spaceId === work.spaceId),
      statusHistory: this.data.statusHistory.filter((item) => item.spaceId === work.spaceId).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
      timestampedHistory,
      linkSyntax: {
        results: results.map((item) => ({ id: item.id, title: item.title, href: `#result:${item.id}` })),
        tasks: this.data.tasks.filter((item) => taskIds.has(item.id)).map((item) => ({ id: item.id, title: item.title, href: `#task:${item.id}` }))
      },
      writingRequirements: [
        "Return one self-contained Markdown note with accurate LaTeX using $...$ or $$...$$.",
        "Use the supplied #result:<id> and #task:<id> links whenever naming specific workspace work.",
        "Distinguish drafts, conjectures, Codex-reviewed results, proved or refuted conjectures, and imported work exactly as recorded.",
        "Cover the current mathematical direction, meaningful progress, blockers, and immediate priorities without ranking contributors.",
        "Treat the timestamped history as context; current entity state is authoritative when older history disagrees."
      ]
    });
  }

  #statusWorkContext(work) {
    const status = this.data.currentStatuses.find((item) => item.id === work.entityId);
    if (!status) throw new StoreError("status_not_found", "Current status not found.", 404);
    return this.#buildCurrentStatusContext(work, status);
  }

  exportCurrentStatusContext(token, spaceId) {
    const { profile } = this.requireSession(token);
    const space = this.getSpace(spaceId);
    if (!space) throw new StoreError("space_not_found", "Theorem space not found.", 404);
    this.#requireMembership(this.data, space.id, profile.id);
    const exportedAt = now();
    const status = this.#currentStatus(this.data, space.id) || {
      id: `current-status-${space.id}`, spaceId: space.id, publishedMarkdown: "", draftMarkdown: "", draftRevision: 0, version: 0,
      publishedAt: null, publishedBy: null, updatedAt: exportedAt, updatedBy: profile.id, codexState: null, codexRequestedAt: null,
      draftSourceRefs: [], publishedSourceRefs: [], codexAssisted: false
    };
    const work = {
      id: `context-export-${space.id}`, type: "fill_current_status", priority: PRIORITY.fill_current_status, spaceId: space.id,
      entityType: "current_status", entityId: status.id, targetRevision: String(status.draftRevision), payload: { requestedBy: profile.id },
      status: "snapshot", attempts: 0, claimedAt: null, leaseUntil: null, completedAt: null, error: null, createdAt: exportedAt
    };
    const context = this.#buildCurrentStatusContext(work, status);
    return {
      filename: `mathhive-${slugify(space.name)}-codex-context-${exportedAt.slice(0, 19).replaceAll(":", "-")}.md`,
      markdown: currentStatusContextMarkdown(context, exportedAt)
    };
  }

  getWorkContext(workId) {
    const work = this.data.workQueue.find((item) => item.id === workId);
    if (!work || work.status !== "claimed") throw new StoreError("work_not_claimed", "Work is not currently claimed.", 409);
    if (new Date(work.leaseUntil).getTime() < Date.now()) throw new StoreError("lease_expired", "Work lease expired.", 409);
    if (["fill_current_status", "review_current_status"].includes(work.type)) return this.#statusWorkContext(work);
    const result = this.getResult(work.entityId);
    if (!result) throw new StoreError("result_not_found", "Result not found.", 404);
    const resultIds = new Set([result.id, ...(result.dependencyIds || [])]);
    const verificationRelation = result.kind === "proof" ? "proves" : result.kind === "counterexample" ? "refutes" : null;
    const verificationEdge = verificationRelation ? this.data.edges.find((edge) => edge.sourceResultId === result.id && edge.relation === verificationRelation) : null;
    const relationTarget = verificationEdge ? this.getResult(verificationEdge.targetResultId) : null;
    const task = result.taskId ? this.data.tasks.find((item) => item.id === result.taskId) : null;
    const parentTask = task?.parentTaskId ? this.data.tasks.find((item) => item.id === task.parentTaskId) : null;
    const participantIds = task ? [task.primaryContributorId, ...task.collaboratorIds].filter(Boolean) : [];
    const space = this.getSpace(result.spaceId);
    return clone({
      work, result,
      targetRevision: this.data.revisions.find((item) => item.id === work.targetRevision) || null,
      verificationEdge,
      provesEdge: verificationRelation === "proves" ? verificationEdge : null,
      refutesEdge: verificationRelation === "refutes" ? verificationEdge : null,
      relationTarget,
      proofTarget: verificationRelation === "proves" ? relationTarget : null,
      targetResultRevision: verificationEdge ? this.data.revisions.find((item) => item.id === verificationEdge.targetRevisionId) || null : null,
      proofTargetRevision: verificationRelation === "proves" && verificationEdge ? this.data.revisions.find((item) => item.id === verificationEdge.targetRevisionId) || null : null,
      task,
      parentTask,
      taskParticipants: participantIds.map((id) => this.publicProfile(this.data.profiles.find((profile) => profile.id === id))).filter(Boolean),
      rootProblem: space?.rootResultId ? this.getResult(space.rootResultId) : null,
      edges: this.data.edges.filter((edge) => edge.sourceResultId === result.id || edge.targetResultId === result.id),
      dependencies: this.data.results.filter((item) => resultIds.has(item.id) && item.id !== result.id),
      reviews: this.data.reviews.filter((item) => item.resultId === result.id),
      comments: this.data.comments.filter((item) => item.resultId === result.id),
      feedback: this.data.draftFeedback.filter((item) => item.resultId === result.id),
      author: this.publicProfile(this.data.profiles.find((item) => item.id === result.createdBy)),
      space,
      relatedCandidates: this.data.results.filter((item) => item.spaceId === result.spaceId && item.id !== result.id).map((item) => ({
        id: item.id, kind: item.kind || "result", title: item.title, status: item.status, statementLatex: item.statementLatex,
        hypothesesLatex: item.hypothesesLatex, tags: item.tags, dependencyIds: item.dependencyIds
      })),
      proofSteps: result.proofMarkdown.split(/\n\s*\n/).map((text, index) => ({ id: `step-${index + 1}`, text: text.trim() })).filter((step) => step.text),
      warnings: this.inspectProjection(result.spaceId).warnings
    });
  }

  researchContext(workId, { tags = [], limit = 200, resultIds = [] } = {}) {
    const work = this.data.workQueue.find((item) => item.id === workId && item.status === "claimed" && item.type === "suggest_integrations");
    if (!work) throw new StoreError("invalid_work", "Claimed integration work is required.", 409);
    let results = this.data.results.filter((item) => item.spaceId !== work.spaceId && ["validated", "imported", "draft", "pending_review", "conjecture", "proved"].includes(item.status));
    if (tags.length) results = results.filter((item) => item.tags?.some((tag) => tags.includes(tag)));
    if (resultIds.length) results = results.filter((item) => resultIds.includes(item.id)).slice(0, 10);
    else results = results.slice(0, Math.min(200, Number(limit) || 200));
    return clone(results.map((item) => ({
      id: item.id, spaceId: item.spaceId, kind: item.kind || "result", title: item.title, status: item.status, statementLatex: item.statementLatex,
      hypothesesLatex: item.hypothesesLatex, tags: item.tags, dependencyIds: item.dependencyIds, citation: item.citation,
      proofMarkdown: resultIds.length ? item.proofMarkdown : undefined,
      task: item.taskId ? this.data.tasks.find((task) => task.id === item.taskId && task.approvalState === "official") || null : null,
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

  #statusSourceRefs(data, spaceId, refs = []) {
    const belongsToSpace = (type, id) => {
      if (type === "result") return data.results.some((item) => item.id === id && item.spaceId === spaceId);
      if (type === "task") return data.tasks.some((item) => item.id === id && item.spaceId === spaceId);
      if (type === "edge") return data.edges.some((item) => item.id === id && item.spaceId === spaceId);
      if (type === "revision") return data.revisions.some((item) => item.id === id && data.results.some((result) => result.id === item.resultId && result.spaceId === spaceId));
      if (type === "review") return data.reviews.some((item) => item.id === id && data.results.some((result) => result.id === item.resultId && result.spaceId === spaceId));
      if (type === "current_status") return data.currentStatuses.some((item) => item.id === id && item.spaceId === spaceId);
      return false;
    };
    return refs.slice(0, 100).map((ref) => ({ entityType: String(ref.entityType || ""), entityId: String(ref.entityId || ""), label: String(ref.label || "").slice(0, 160) })).filter((ref) => belongsToSpace(ref.entityType, ref.entityId));
  }

  async submitCurrentStatusDraft(input) {
    return this.mutate((data) => {
      const work = this.#requireClaimed(data, input.workId, "fill_current_status");
      const status = data.currentStatuses.find((item) => item.id === work.entityId);
      if (!status) throw new StoreError("status_not_found", "Current status not found.", 404);
      if (Number(work.targetRevision) !== Number(input.baseDraftRevision)) throw new StoreError("status_revision_mismatch", "Codex must return the requested status draft revision.", 409);
      const proposedMarkdown = String(input.markdown || "");
      if (!proposedMarkdown.trim() || proposedMarkdown.length > 50_000) throw new StoreError("invalid_status_markdown", "Codex must return a nonempty current status under 50,000 characters.");
      const sourceRefs = this.#statusSourceRefs(data, status.spaceId, input.sourceRefs || []);
      const leadId = this.leadMembership(status.spaceId, data)?.profileId;
      if (!leadId) throw new StoreError("lead_not_found", "This theorem space has no lead.", 409);
      const stale = status.draftRevision !== Number(input.baseDraftRevision);
      let suggestion = null;
      if (stale) {
        for (const item of data.statusSuggestions) if (item.statusId === status.id && item.status === "open") item.status = "stale";
        suggestion = {
          id: randomUUID(), statusId: status.id, spaceId: status.spaceId, type: "generated_draft",
          baseDraftRevision: status.draftRevision, proposedMarkdown, rationale: String(input.summary || "Codex prepared a complete status draft."),
          sourceRefs, status: "open", createdBy: "codex", createdAt: now(), actedBy: null, actedAt: null
        };
        data.statusSuggestions.push(suggestion);
      } else {
        status.draftMarkdown = proposedMarkdown;
        status.draftRevision += 1;
        status.draftSourceRefs = sourceRefs;
        status.codexAssisted = true;
        status.updatedAt = now();
        status.updatedBy = "codex";
      }
      status.codexState = null;
      status.codexRequestedAt = null;
      const notification = this.#notification(data, {
        spaceId: status.spaceId, userId: leadId, type: "current_status_draft", title: input.notification?.title || "Current status draft ready",
        body: input.notification?.body || (stale ? "Codex prepared a draft after your note changed. Review the proposed version." : "Codex filled the current status draft."),
        entityType: "current_status", entityId: status.id, dedupeKey: `current-status-fill:${work.id}`
      });
      this.#complete(data, work);
      const events = [
        { type: "entity.upsert", entityType: "current_status", entity: clone(status), spaceId: status.spaceId, audienceUserIds: [leadId] },
        { type: "notification.new", notification, spaceId: status.spaceId, audienceUserIds: [leadId] },
        { type: "queue.changed", spaceId: status.spaceId, pendingCount: this.pendingWorkCount(data) },
        { type: "agent.status", state: data.agentStatus }
      ];
      if (suggestion) events.splice(1, 0, { type: "entity.upsert", entityType: "status_suggestion", entity: suggestion, spaceId: status.spaceId, audienceUserIds: [leadId] });
      return { result: { status, suggestion, stale }, events };
    });
  }

  async submitCurrentStatusReview(input) {
    return this.mutate((data) => {
      const work = this.#requireClaimed(data, input.workId, "review_current_status");
      const status = data.currentStatuses.find((item) => item.id === work.entityId);
      if (!status) throw new StoreError("status_not_found", "Current status not found.", 404);
      if (Number(work.targetRevision) !== Number(input.baseDraftRevision)) throw new StoreError("status_revision_mismatch", "Codex must review the requested status draft revision.", 409);
      const proposedMarkdown = String(input.proposedMarkdown || "");
      if (!proposedMarkdown.trim() || proposedMarkdown.length > 50_000) throw new StoreError("invalid_status_markdown", "Codex must return a nonempty proposed status under 50,000 characters.");
      const leadId = this.leadMembership(status.spaceId, data)?.profileId;
      if (!leadId) throw new StoreError("lead_not_found", "This theorem space has no lead.", 409);
      for (const item of data.statusSuggestions) if (item.statusId === status.id && item.status === "open") item.status = "stale";
      const stale = status.draftRevision !== Number(input.baseDraftRevision);
      const suggestion = {
        id: randomUUID(), statusId: status.id, spaceId: status.spaceId, type: "reviewed_revision",
        baseDraftRevision: Number(input.baseDraftRevision), proposedMarkdown, rationale: String(input.rationale || "Codex suggested a revised current status."),
        sourceRefs: this.#statusSourceRefs(data, status.spaceId, input.sourceRefs || []), status: stale ? "stale" : "open",
        createdBy: "codex", createdAt: now(), actedBy: null, actedAt: null
      };
      data.statusSuggestions.push(suggestion);
      status.codexState = null;
      status.codexRequestedAt = null;
      const notification = this.#notification(data, {
        spaceId: status.spaceId, userId: leadId, type: "current_status_review", title: input.notification?.title || "Codex status suggestion ready",
        body: input.notification?.body || (stale ? "The status changed while Codex reviewed it. Ask Codex again for a current suggestion." : "Codex proposed one revised version of the current status."),
        entityType: "current_status", entityId: status.id, dedupeKey: `current-status-review:${work.id}`
      });
      this.#complete(data, work);
      const events = [
        { type: "entity.upsert", entityType: "current_status", entity: clone(status), spaceId: status.spaceId, audienceUserIds: [leadId] },
        { type: "notification.new", notification, spaceId: status.spaceId, audienceUserIds: [leadId] },
        { type: "queue.changed", spaceId: status.spaceId, pendingCount: this.pendingWorkCount(data) },
        { type: "agent.status", state: data.agentStatus }
      ];
      if (!stale) events.splice(1, 0, { type: "entity.upsert", entityType: "status_suggestion", entity: suggestion, spaceId: status.spaceId, audienceUserIds: [leadId] });
      return { result: { status, suggestion, stale }, events };
    });
  }

  async submitDraftReview(input) {
    return this.mutate((data) => {
      const work = this.#requireClaimed(data, input.workId, "review_draft");
      const result = data.results.find((item) => item.id === work.entityId);
      const stale = String(result.draftRevision) !== String(input.draftRevision);
      const feedback = { id: randomUUID(), resultId: result.id, spaceId: result.spaceId, draftRevision: Number(input.draftRevision), status: stale ? "stale" : "current", summary: String(input.summary || ""), issues: clone(input.issues || []), relevantResultIds: clone(input.relevantResultIds || []), relevanceAssessment: input.relevanceAssessment ? clone(input.relevanceAssessment) : null, taskAlignment: input.taskAlignment ? clone(input.taskAlignment) : null, createdBy: "codex", createdAt: now() };
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
      const relation = result.kind === "proof" ? "proves" : result.kind === "counterexample" ? "refutes" : null;
      const verificationEdge = relation ? data.edges.find((edge) => edge.sourceResultId === result.id && edge.relation === relation) : null;
      const relationTarget = verificationEdge ? data.results.find((item) => item.id === verificationEdge.targetResultId) : null;
      const submittedEdgeId = input.verificationEdgeId || (relation === "proves" ? input.provesEdgeId : input.refutesEdgeId);
      if (relation && (!verificationEdge || verificationEdge.id !== submittedEdgeId || !relationTarget)) throw new StoreError("verification_edge_mismatch", `Validation must target the proposed ${relation} relationship.`, 409);
      if (relation && verificationEdge.targetRevisionId !== relationTarget.submittedRevisionId) throw new StoreError("relation_target_changed", "The target conjecture changed after this contribution was linked.", 409);
      if (result.kind === "proof" && result.proofMarkdown.length > 80 && !(input.proofStepChecks || []).length) throw new StoreError("missing_step_checks", "Nontrivial proofs require proof-step checks.");
      if (result.kind === "counterexample" && !(input.counterexampleChecks || input.proofStepChecks || []).length) throw new StoreError("missing_counterexample_checks", "Counterexamples require construction and hypothesis checks.");
      const decision = ["validated", "needs_changes", "rejected"].includes(input.decision) ? input.decision : "needs_changes";
      const task = result.taskId ? data.tasks.find((item) => item.id === result.taskId && item.approvalState === "official") : null;
      const taskOutcome = task ? (input.taskOutcome || (decision === "validated" && relation && task.expectedRelation === relation && task.targetResultId === relationTarget?.id ? "complete" : "keep_open")) : null;
      if (taskOutcome === "complete" && decision !== "validated") throw new StoreError("invalid_task_completion", "Only a validated contribution can complete a task.", 409);
      const review = {
        id: randomUUID(), resultId: result.id, reviewerType: "codex", reviewerId: "codex", decision,
        summary: String(input.summary || ""), claimRestatement: String(input.claimRestatement || ""),
        assumptionChecks: clone(input.assumptionChecks || []), proofStepChecks: clone(input.proofStepChecks || []), counterexampleChecks: clone(input.counterexampleChecks || []),
        dependencyChecks: clone(input.dependencyChecks || []), counterexampleRisks: clone(input.counterexampleRisks || []), issues: clone(input.issues || []), confidence: Number(input.confidence || 0),
        verificationEdgeId: verificationEdge?.id || null, provesEdgeId: relation === "proves" ? verificationEdge?.id || null : null,
        refutesEdgeId: relation === "refutes" ? verificationEdge?.id || null : null, targetResultId: relationTarget?.id || null,
        taskId: task?.id || null, taskOutcome, taskRationale: String(input.taskRationale || ""), createdAt: now()
      };
      data.reviews.push(review);
      result.status = decision === "validated" ? "validated" : decision === "rejected" ? "rejected" : "draft";
      result.updatedAt = now();
      const revision = data.revisions.find((item) => item.id === input.submittedRevisionId);
      if (revision) revision.status = result.status;
      const extraEvents = [];
      if (verificationEdge) {
        verificationEdge.verificationStatus = decision === "validated" ? "verified" : decision === "rejected" ? "rejected" : "proposed";
        verificationEdge.verifiedBy = decision === "validated" ? "codex" : null;
        verificationEdge.verifiedAt = decision === "validated" ? now() : null;
        extraEvents.push({ type: "entity.upsert", entityType: "edge", entity: clone(verificationEdge), spaceId: result.spaceId });
        if (decision === "validated") {
          relationTarget.status = relation === "proves" ? "proved" : "refuted";
          const evidenceIds = relation === "proves" ? (relationTarget.provedByProofIds ||= []) : (relationTarget.refutedByCounterexampleIds ||= []);
          if (!evidenceIds.includes(result.id)) evidenceIds.push(result.id);
          relationTarget.updatedAt = now();
          const targetRevision = data.revisions.find((item) => item.id === relationTarget.submittedRevisionId);
          if (targetRevision) targetRevision.status = relationTarget.status;
          extraEvents.push(...this.#eventsFor("result", relationTarget));
        }
      }
      if (task) {
        if (taskOutcome === "complete") {
          const relationMatches = !task.expectedRelation || (verificationEdge?.relation === task.expectedRelation && verificationEdge.targetResultId === task.targetResultId && verificationEdge.verificationStatus === "verified") || (task.expectedRelation === "supports" && data.edges.some((edge) => task.outputResultIds.includes(edge.sourceResultId) && edge.targetResultId === task.targetResultId && edge.relation === "supports"));
          if (!relationMatches) throw new StoreError("task_outcome_mismatch", "The validated output does not satisfy the task's expected relationship.", 409);
          task.status = "done";
          task.completedBy = "codex";
          task.completedAt = now();
        } else if (["open", "claimed"].includes(task.status)) task.status = "in_progress";
        task.updatedBy = "codex";
        task.updatedAt = now();
        extraEvents.push({ type: "entity.upsert", entityType: "task", entity: clone(task), spaceId: task.spaceId });
      }
      if (decision === "validated") this.#queue(data, { type: "suggest_integrations", spaceId: result.spaceId, entityId: result.id, targetRevision: input.submittedRevisionId, payload: { authorId: result.createdBy, taskId: task?.id || null } });
      const notification = this.#notification(data, { spaceId: result.spaceId, userId: result.createdBy, type: "validation", title: input.notification?.title || "Codex review complete", body: input.notification?.body || review.summary, entityType: "result", entityId: result.id, dedupeKey: `validation:${result.id}:${input.submittedRevisionId}` });
      const relationNotification = verificationEdge && decision === "validated" ? this.#notification(data, { spaceId: result.spaceId, userId: relationTarget.createdBy, type: relation === "proves" ? "conjecture_proved" : "conjecture_refuted", title: relation === "proves" ? "Conjecture proved" : "Conjecture refuted", body: `${result.title} was Codex-validated as ${relation === "proves" ? "a proof" : "a counterexample"} of ${relationTarget.title}.`, entityType: "result", entityId: relationTarget.id, dedupeKey: `${relation === "proves" ? "proved" : "refuted"}:${relationTarget.id}:${result.id}` }) : null;
      const activity = this.#activity(data, { spaceId: result.spaceId, actorType: "codex", actorId: "codex", action: `result.${decision}`, entityType: "result", entityId: result.id, summary: `Codex marked ${result.title} as ${decision === "validated" ? "Codex-validated" : decision.replace("_", " ")}.` });
      this.#complete(data, work);
      const events = [...this.#eventsFor("result", result), { type: "entity.upsert", entityType: "review", entity: review, spaceId: result.spaceId }, ...extraEvents, { type: "notification.new", notification, spaceId: result.spaceId, audienceUserIds: [result.createdBy] }];
      if (relationNotification) events.push({ type: "notification.new", notification: relationNotification, spaceId: result.spaceId, audienceUserIds: [relationTarget.createdBy] });
      if (task?.status === "done") {
        const leadId = this.leadMembership(task.spaceId, data)?.profileId;
        const affected = [...new Set([leadId, task.primaryContributorId, ...task.collaboratorIds].filter((id) => id && id !== result.createdBy && id !== relationTarget?.createdBy))];
        for (const userId of affected) {
          const taskNotification = this.#notification(data, { spaceId: task.spaceId, userId, type: "task_completed", title: "Task completed", body: `${task.title} completed with Codex-validated output ${result.title}.`, entityType: "task", entityId: task.id, dedupeKey: `task-completed:${task.id}:${input.submittedRevisionId}:${userId}` });
          events.push({ type: "notification.new", notification: taskNotification, spaceId: task.spaceId, audienceUserIds: [userId] });
        }
      }
      events.push({ type: "activity.new", entity: activity, spaceId: result.spaceId }, { type: "queue.changed", spaceId: result.spaceId, pendingCount: this.pendingWorkCount(data) }, { type: "agent.status", state: data.agentStatus });
      return { result: { result, review, verificationEdge, provesEdge: relation === "proves" ? verificationEdge : null, refutesEdge: relation === "refutes" ? verificationEdge : null, relationTarget, proofTarget: relation === "proves" ? relationTarget : null, task }, events };
    });
  }

  async submitConjectureReview(input) {
    return this.mutate((data) => {
      const work = this.#requireClaimed(data, input.workId, "review_conjecture");
      const result = data.results.find((item) => item.id === work.entityId);
      if (result.kind !== "conjecture") throw new StoreError("not_a_conjecture", "Conjecture review requires a conjecture.", 409);
      if (work.targetRevision !== input.submittedRevisionId || result.submittedRevisionId !== input.submittedRevisionId) throw new StoreError("revision_mismatch", "Review must target the submitted conjecture revision.", 409);
      const decision = ["relevant", "needs_clarification", "not_relevant"].includes(input.decision) ? input.decision : "needs_clarification";
      const relatedResultIds = (input.relatedResultIds || []).filter((id) => data.results.some((item) => item.id === id && item.spaceId === result.spaceId && item.id !== result.id));
      const review = {
        id: randomUUID(), resultId: result.id, reviewerType: "codex", reviewerId: "codex", reviewType: "conjecture_relevance",
        decision, summary: String(input.summary || ""), relevanceExplanation: String(input.relevanceExplanation || ""),
        relatedResultIds, issues: clone(input.issues || []), confidence: Number(input.confidence || 0), createdAt: now()
      };
      data.reviews.push(review);
      result.relevanceStatus = decision;
      result.status = decision === "relevant" ? "conjecture" : "draft";
      result.updatedAt = now();
      const revision = data.revisions.find((item) => item.id === input.submittedRevisionId);
      if (revision) revision.status = result.status;
      if (decision === "relevant") this.#queue(data, { type: "suggest_integrations", spaceId: result.spaceId, entityId: result.id, targetRevision: input.submittedRevisionId, payload: { authorId: result.createdBy } });
      const notification = this.#notification(data, { spaceId: result.spaceId, userId: result.createdBy, type: "conjecture_review", title: input.notification?.title || "Conjecture review complete", body: input.notification?.body || review.summary, entityType: "result", entityId: result.id, dedupeKey: `conjecture:${result.id}:${input.submittedRevisionId}` });
      const activity = this.#activity(data, { spaceId: result.spaceId, actorType: "codex", actorId: "codex", action: `conjecture.${decision}`, entityType: "result", entityId: result.id, summary: `Codex marked ${result.title} as ${decision.replace("_", " ")}.` });
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
        const task = raw.taskId ? data.tasks.find((item) => item.id === raw.taskId && item.approvalState === "official") : null;
        const targetId = raw.targetResultIds?.[0] || task?.id || "user";
        const validUsers = (raw.audienceUserIds || []).filter((id) => data.profiles.some((profile) => profile.id === id));
        const validTargets = (raw.targetResultIds || []).filter((id) => data.results.some((result) => result.id === id));
        const targetResult = data.results.find((result) => result.id === validTargets[0]);
        const targetProfile = data.profiles.find((profile) => validUsers.includes(profile.id));
        const deliverySpaceId = task?.spaceId || targetResult?.spaceId || targetProfile?.activeSpaceId || source.spaceId;
        const taskParticipants = task ? [task.primaryContributorId, ...task.collaboratorIds].filter(Boolean) : [];
        const requestedWithinTask = raw.scope === "within_task" && task && validUsers.every((id) => taskParticipants.includes(id) || this.membership(task.spaceId, id, data)?.role === "lead");
        const scope = requestedWithinTask ? "within_task" : "blueprint_change";
        const leadId = this.leadMembership(deliverySpaceId, data)?.profileId;
        const audienceUserIds = [...new Set([...validUsers, ...(scope === "blueprint_change" && leadId ? [leadId] : [])])];
        const dedupeKey = `${source.id}:${targetId}:${raw.type || "relevance"}:${scope}`;
        const existing = data.suggestions.find((item) => item.dedupeKey === dedupeKey && item.status === "open");
        if (existing) continue;
        const suggestion = { id: randomUUID(), spaceId: deliverySpaceId, taskId: task?.id || null, scope, type: raw.type || "relevance", title: String(raw.title || "Relevant result found"), explanation: String(raw.explanation || ""), confidence: Number(raw.confidence || 0), sourceResultIds: [source.id, ...(raw.sourceResultIds || []).filter((id) => id !== source.id)], targetResultIds: validTargets, proposedChanges: clone(raw.proposedChanges || []), evidence: clone(raw.evidence || []), audienceUserIds, dedupeKey, status: "open", createdBy: "codex", createdAt: now(), actedBy: null, actedAt: null };
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
      if (["proves", "refutes"].includes(edge.relation)) {
        const source = nodes.find((item) => item.id === edge.sourceResultId);
        const target = nodes.find((item) => item.id === edge.targetResultId);
        const expectedKind = edge.relation === "proves" ? "proof" : "counterexample";
        const expectedStatus = edge.relation === "proves" ? "proved" : "refuted";
        if (source?.kind !== expectedKind || target?.kind !== "conjecture") warnings.push({ type: `invalid_${edge.relation}_edge`, edgeId: edge.id });
        if (edge.verificationStatus === "verified" && target?.status !== expectedStatus) warnings.push({ type: "unpromoted_relation_target", edgeId: edge.id });
      }
    }
    const profileIds = new Set(this.data.profiles.map((item) => item.id));
    const tasks = this.data.tasks.filter((item) => item.spaceId === spaceId && item.approvalState !== "declined");
    for (const task of tasks) {
      if (task.targetResultId && !nodeIds.has(task.targetResultId)) warnings.push({ type: "missing_task_target", taskId: task.id });
      for (const resultId of task.outputResultIds) if (!nodeIds.has(resultId)) warnings.push({ type: "missing_task_output", taskId: task.id, resultId });
      for (const profileId of [task.primaryContributorId, ...task.collaboratorIds, ...task.pendingVolunteerIds, ...task.invitedProfileIds].filter(Boolean)) if (!profileIds.has(profileId)) warnings.push({ type: "invalid_task_participant", taskId: task.id, profileId });
    }
    const space = this.getSpace(spaceId);
    if (space?.rootResultId && !nodeIds.has(space.rootResultId)) warnings.push({ type: "missing_root_problem", resultId: space.rootResultId });
    for (const node of nodes) if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || node.x < 0 || node.y < 0 || node.x > 900 || node.y > 850) warnings.push({ type: "off_canvas", resultId: node.id });
    const statusCounts = nodes.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
    const taskStatusCounts = tasks.filter((item) => item.approvalState === "official").reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
    return clone({ spaceId, storeRevision: this.data.storeRevision, nodeCount: nodes.length, edgeCount: edges.length, taskCount: tasks.length, statusCounts, taskStatusCounts, openSuggestionCount: this.data.suggestions.filter((item) => item.spaceId === spaceId && item.status === "open").length, warnings });
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
        if (["fill_current_status", "review_current_status"].includes(work.type)) {
          const status = data.currentStatuses.find((item) => item.id === work.entityId);
          const leadId = this.leadMembership(work.spaceId, data)?.profileId;
          if (status) {
            status.codexState = null;
            status.codexRequestedAt = null;
            events.push({ type: "entity.upsert", entityType: "current_status", entity: clone(status), spaceId: work.spaceId, audienceUserIds: leadId ? [leadId] : [] });
          }
          if (leadId) {
            const notification = this.#notification(data, { spaceId: work.spaceId, userId: leadId, type: "agent_failed", title: "Codex could not update current status", body: work.error, entityType: "current_status", entityId: status?.id || work.entityId, dedupeKey: `agent-failed:${work.id}` });
            events.push({ type: "notification.new", notification, spaceId: work.spaceId, audienceUserIds: [leadId] });
          }
        }
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
