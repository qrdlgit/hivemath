const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const tokenKey = "mathhive.token";

// Incognito windows share localStorage; identity must stay scoped to one window.
localStorage.removeItem(tokenKey);

const state = {
  token: sessionStorage.getItem(tokenKey),
  profile: null,
  space: null,
  spaces: [],
  profiles: [],
  memberships: [],
  currentMembership: null,
  spaceLead: null,
  tasks: [],
  results: [],
  edges: [],
  revisions: [],
  reviews: [],
  comments: [],
  draftFeedback: [],
  suggestions: [],
  notifications: [],
  activity: [],
  presence: [],
  locks: new Map(),
  cursors: new Map(),
  pointerPlacement: null,
  agentStatus: { state: "offline" },
  pendingWorkCount: 0,
  taskFilter: "active",
  pendingContributionKind: null,
  pendingTaskParentId: null,
  selectedResultId: null,
  socket: null,
  reconnectTimer: null,
  saveTimer: null,
  suppressEditorSync: false,
  zoom: 1,
  pan: { x: 0, y: 0 },
  drag: null,
  activeTool: "pan",
  filters: new Set(["validated", "pending", "imported", "conjecture", "conflict"])
};

const stage = $("#graphStage");
const viewport = $("#graphViewport");
const nodeLayer = $("#nodesLayer");
const edgeLayer = $("#edgesLayer");
const cursorLayer = $("#liveCursors");
const editor = $("#resultEditor");
const editorScrim = $("#editorScrim");
const markdown = window.markdownit({ html: false, breaks: true, linkify: true });
const baseNodeWidth = 188;
const maxNodeWidth = baseNodeWidth * 3;

function inviteSlug() {
  const match = location.pathname.match(/^\/join\/([^/]+)/);
  return match?.[1] || localStorage.getItem("mathhive.inviteSlug") || "spectral-gap";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

function refreshIcons(root = document) {
  if (window.lucide) window.lucide.createIcons({ root, attrs: { "aria-hidden": "true" } });
}

function icon(name) {
  return `<i data-lucide="${name}"></i>`;
}

function renderLatex(element, latex, displayMode = true) {
  if (!element) return;
  if (!latex?.trim()) {
    element.innerHTML = '<span class="empty-math">No mathematical statement yet</span>';
    return;
  }
  try {
    element.innerHTML = window.katex.renderToString(latex, { displayMode, throwOnError: false, strict: "ignore" });
  } catch {
    element.textContent = latex;
  }
}

function renderMarkdown(source) {
  const expressions = [];
  const delimiters = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
  const withTokens = String(source || "").replace(delimiters, (match, bracketBlock, dollarBlock, bracketInline, dollarInline) => {
    const value = bracketBlock ?? dollarBlock ?? bracketInline ?? dollarInline;
    const displayMode = bracketBlock !== undefined || dollarBlock !== undefined;
    const index = expressions.push({ value, displayMode }) - 1;
    return `MATHXTOKEN${index}XEND`;
  });
  let html = markdown.render(withTokens);
  expressions.forEach((expression, index) => {
    let rendered;
    try {
      rendered = window.katex.renderToString(expression.value, { displayMode: expression.displayMode, throwOnError: false, strict: "ignore" });
    } catch {
      rendered = escapeHtml(expression.value);
    }
    html = html.replace(`MATHXTOKEN${index}XEND`, rendered);
  });
  return html;
}

function renderStatement(element, source, displayMode = true) {
  const mixedContent = /\$|\\\[|\\\(/.test(source || "");
  element.classList.toggle("mixed-content", mixedContent);
  if (mixedContent) {
    element.innerHTML = renderMarkdown(source) || '<span class="empty-math">No mathematical statement yet</span>';
    return;
  }
  renderLatex(element, source, displayMode);
}

function renderHypothesesPreview() {
  const element = $("#hypothesesPreview");
  const hypotheses = $("#resultHypotheses").value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!hypotheses.length) {
    element.innerHTML = '<span class="empty-math">Hypotheses preview</span>';
    return;
  }
  element.innerHTML = "";
  hypotheses.forEach((hypothesis) => {
    const row = document.createElement("div");
    row.className = "hypothesis-preview-item";
    renderLatex(row, hypothesis);
    element.append(row);
  });
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.auth !== false && state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || `Request failed (${response.status})`);
    error.code = payload.error;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `${icon(type === "error" ? "circle-alert" : "circle-check")}<span>${escapeHtml(message)}</span>`;
  $("#toastRegion").append(toast);
  refreshIcons(toast);
  setTimeout(() => toast.remove(), 3600);
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function resultType(result) {
  if (["validated", "proved"].includes(result.status)) return "validated";
  if (result.status === "imported") return "imported";
  if (result.status === "conjecture") return "conjecture";
  if (["conflict_resolved", "rejected", "refuted"].includes(result.status)) return "conflict";
  if (result.status === "draft") return "draft";
  return "pending";
}

function statusLabel(status) {
  return ({
    validated: "Codex-validated",
    proved: "Proved",
    refuted: "Refuted",
    imported: "Imported",
    conjecture: "Relevant",
    pending_review: "Pending review",
    conflict_resolved: "Conflict resolved",
    rejected: "Rejected",
    draft: "Draft"
  })[status] || status;
}

function isLead() {
  return state.currentMembership?.role === "lead";
}

function membershipFor(profileId) {
  return state.memberships.find((item) => item.profileId === profileId);
}

function acceptedTasks(profileId = state.profile?.id) {
  return state.tasks.filter((task) => task.approvalState === "official" && task.status !== "done" && (task.primaryContributorId === profileId || task.collaboratorIds?.includes(profileId)));
}

function authorName(id) {
  return state.profiles.find((profile) => profile.id === id)?.displayName || (id === "seed" ? "Workspace seed" : "Unknown author");
}

function upsert(list, entity) {
  const index = list.findIndex((item) => item.id === entity.id);
  if (index >= 0) list[index] = entity;
  else list.push(entity);
}

async function loadWorkspace(spaceId) {
  const payload = await api(`/api/bootstrap${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""}`);
  Object.assign(state, payload);
  state.locks = new Map();
  state.cursors = new Map();
  hidePointerPlacement();
  localStorage.setItem("mathhive.inviteSlug", payload.space.inviteSlug);
  history.replaceState(null, "", `/join/${payload.space.inviteSlug}`);
  renderAll();
  connectRealtime();
}

async function initialize() {
  state.spaces = await api("/api/spaces", { auth: false });
  const requested = state.spaces.find((space) => space.inviteSlug === inviteSlug()) || state.spaces[0];
  $("#joinSpaceName").textContent = requested?.name || "this theorem space";
  if (!state.token) return;
  try {
    await loadWorkspace(requested?.id);
    $("#joinGate").hidden = true;
  } catch (error) {
    if (error.status === 401) {
      state.token = null;
      sessionStorage.removeItem(tokenKey);
    } else showToast(error.message, "error");
  }
}

function renderAll() {
  renderWorkspace();
  renderSpaces();
  renderPresence();
  renderWork();
  renderSpaceSettings();
  renderNodes();
  renderSuggestions();
  renderNotifications();
  renderAgentStatus();
  renderActivity();
  refreshIcons();
  requestAnimationFrame(() => {
    renderEdges();
    if (!stage.dataset.fitted) {
      fitStage();
      stage.dataset.fitted = "true";
    }
  });
}

function renderWorkspace() {
  if (!state.space) return;
  $("#workspaceTitle").textContent = state.space.name;
  $("#profileMenuName").textContent = state.profile.displayName;
  $("#profileMenuSpace").textContent = state.space.name;
  $("#profileRole").textContent = isLead() ? "Lead · coordination" : "Contributor";
  $("#workspaceNameButton").disabled = !isLead();
  $("#workspaceNameButton").title = isLead() ? "Rename theorem space" : "The lead manages the theorem space name";
  $("#addTask").hidden = !isLead();
  const online = Math.max(1, new Set(state.presence.map((person) => person.profileId)).size);
  $("#onlineCount").textContent = `${online} online`;
}

function renderSpaces() {
  if (!state.space) return;
  const markup = state.spaces.map((space) => {
    const count = space.id === state.space.id ? state.results.length : null;
    return `<button class="space-item ${space.id === state.space.id ? "active" : ""}" data-space-id="${space.id}">
      <span class="space-icon">${icon("network")}</span>
      <span class="space-copy"><strong>${escapeHtml(space.name)}</strong><small>${count === null ? "Open workspace" : `${count} results`}</small></span>
      <span class="status-dot"></span>
    </button>`;
  }).join("");
  $("#spacesList").innerHTML = markup;
  $("#workspacePopover").innerHTML = state.spaces.map((space) => `<button class="workspace-option ${space.id === state.space.id ? "active" : ""}" data-space-id="${space.id}" role="menuitem">${icon("network")}<span>${escapeHtml(space.name)}</span><span class="status-dot"></span></button>`).join("");
  $$('[data-space-id]').forEach((button) => button.addEventListener("click", () => switchWorkspace(button.dataset.spaceId)));
  refreshIcons($("#leftSidebar"));
  refreshIcons($("#workspacePopover"));
}

function renderSpaceSettings() {
  if (!state.space || !state.profile) return;
  $("#spaceSettings").hidden = !isLead();
  $("#leadTransferResponse").hidden = state.space.pendingLeadProfileId !== state.profile.id;
  $("#rootResultSelect").innerHTML = state.results.map((result) => `<option value="${result.id}">${escapeHtml(result.title)}</option>`).join("");
  $("#rootResultSelect").value = state.space.rootResultId || state.results[0]?.id || "";
  const transferCandidates = state.memberships.filter((item) => item.profileId !== state.profile.id).map((item) => state.profiles.find((profile) => profile.id === item.profileId)).filter(Boolean);
  $("#leadTransferSelect").innerHTML = transferCandidates.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.displayName)}</option>`).join("");
  $("#offerLeadTransfer").disabled = transferCandidates.length === 0;
}

function taskStatusLabel(status) {
  return ({ open: "Open", claimed: "Claimed", in_progress: "In progress", blocked: "Blocked", done: "Done" })[status] || status;
}

function taskParticipantName(task) {
  if (!task.primaryContributorId) return "Unassigned";
  return authorName(task.primaryContributorId);
}

function renderWork() {
  if (!state.profile) return;
  const official = state.tasks.filter((task) => task.approvalState === "official");
  const mine = official.filter((task) => task.primaryContributorId === state.profile.id || task.collaboratorIds?.includes(state.profile.id));
  const pending = official.filter((task) => task.pendingVolunteerIds?.length).length;
  const blocked = official.filter((task) => task.status === "blocked").length;
  $("#workSummary").innerHTML = `<span><strong>${mine.length}</strong> assigned</span><span><strong>${official.filter((task) => task.status === "open").length}</strong> open</span>${isLead() ? `<span><strong>${pending}</strong> volunteer decision${pending === 1 ? "" : "s"}</span>` : ""}${blocked ? `<span class="blocked-summary"><strong>${blocked}</strong> blocked</span>` : ""}`;
  const visible = state.tasks.filter((task) => {
    if (task.approvalState === "declined") return false;
    if (task.approvalState === "proposed") return isLead() || task.proposedBy === state.profile.id;
    if (state.taskFilter === "active") return task.status !== "done";
    return task.status === state.taskFilter;
  });
  $("#taskList").innerHTML = visible.map((task) => {
    const target = state.results.find((result) => result.id === task.targetResultId);
    const participant = task.primaryContributorId === state.profile.id || task.collaboratorIds?.includes(state.profile.id);
    const volunteered = task.pendingVolunteerIds?.includes(state.profile.id);
    const invited = task.invitedProfileIds?.includes(state.profile.id);
    const canVolunteer = task.approvalState === "official" && task.status !== "done" && !participant && !volunteered && !invited;
    const pendingNames = isLead() ? (task.pendingVolunteerIds || []).map((id) => state.profiles.find((profile) => profile.id === id)).filter(Boolean) : [];
    const inviteCandidates = isLead() ? state.memberships.map((item) => state.profiles.find((profile) => profile.id === item.profileId)).filter((profile) => profile && profile.id !== state.profile.id && !task.pendingVolunteerIds.includes(profile.id) && !task.invitedProfileIds.includes(profile.id) && task.primaryContributorId !== profile.id && !task.collaboratorIds.includes(profile.id)) : [];
    const proposal = task.approvalState === "proposed";
    const stale = task.status !== "done" && Date.now() - new Date(task.updatedAt).getTime() >= 7 * 86400_000;
    const canReopen = isLead() && !proposal && (["blocked", "done"].includes(task.status) || stale);
    const actionMarkup = proposal
      ? isLead() ? `<button class="primary" data-task-action="approve-proposal">Approve</button><button data-task-action="decline-proposal">Decline</button>` : `<span class="pending-copy">Awaiting lead decision</span>`
      : `${canVolunteer ? `<button class="primary" data-task-action="volunteer">Volunteer</button>` : ""}${volunteered ? `<span class="pending-copy">Volunteer request pending</span>` : ""}${invited ? `<button class="primary" data-task-action="accept-invite">Accept invite</button><button data-task-action="decline-invite">Decline</button>` : ""}${participant ? `<button class="primary" data-task-action="start">${icon("square-pen")} Start contribution</button><button data-task-action="propose">Propose subtask</button><button data-task-action="release">Release</button>${task.status === "blocked" ? `<button data-task-action="resume">Resume</button>` : `<button data-task-action="block">Block</button>`}` : ""}`;
    return `<article class="task-row ${task.parentTaskId ? "child-task" : ""} status-${task.status} ${proposal ? "task-proposal" : ""}" data-task-id="${task.id}">
      <header><span class="task-priority ${task.priority}"></span><strong>${escapeHtml(task.title)}</strong><span class="task-status">${proposal ? "Proposed" : escapeHtml(taskStatusLabel(task.status))}</span></header>
      <p>${escapeHtml(task.goal)}</p>
      <div class="task-meta">${target ? `<button data-open-target="${target.id}">${icon("target")} ${escapeHtml(target.title)}</button>` : `<span>${icon("compass")} Exploratory</span>`}<span>${icon("user-round")} ${escapeHtml(taskParticipantName(task))}</span>${task.collaboratorIds?.length ? `<span>+${task.collaboratorIds.length} collaborator${task.collaboratorIds.length === 1 ? "" : "s"}</span>` : ""}${stale ? `<span class="stale-task">No recent update</span>` : ""}</div>
      ${task.blockedReason ? `<div class="task-blocked">${icon("circle-alert")} ${escapeHtml(task.blockedReason)}</div>` : ""}
      ${pendingNames.map((profile) => `<div class="volunteer-decision" data-volunteer-id="${profile.id}"><span>${avatar(profile)} ${escapeHtml(profile.displayName)}</span><button class="primary" data-task-action="accept-primary">Primary</button><button data-task-action="accept-collaborator">Collaborator</button><button data-task-action="decline-volunteer">Decline</button></div>`).join("")}
      ${isLead() && !proposal && inviteCandidates.length ? `<div class="task-invite"><select aria-label="Invite contributor">${inviteCandidates.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.displayName)}</option>`).join("")}</select><button data-task-action="invite">Invite</button></div>` : ""}
      <footer class="task-actions">${actionMarkup}${canReopen ? `<button data-task-action="reopen">Reopen for volunteers</button>` : ""}</footer>
    </article>`;
  }).join("") || '<div class="empty-message">No work matches this view.</div>';
  $$('[data-task-action]').forEach((button) => button.addEventListener("click", () => handleTaskAction(button)));
  $$('[data-open-target]').forEach((button) => button.addEventListener("click", () => openResult(button.dataset.openTarget)));
  refreshIcons($("#workSection"));
}

async function handleTaskAction(button) {
  const row = button.closest("[data-task-id]");
  const task = state.tasks.find((item) => item.id === row.dataset.taskId);
  const action = button.dataset.taskAction;
  try {
    let updated = null;
    if (action === "volunteer") updated = await api(`/api/tasks/${task.id}/volunteer`, { method: "POST", body: {} });
    if (["accept-primary", "accept-collaborator", "decline-volunteer"].includes(action)) {
      const profileId = button.closest("[data-volunteer-id]").dataset.volunteerId;
      updated = await api(`/api/tasks/${task.id}/volunteers/respond`, { method: "POST", body: { profileId, decision: action === "decline-volunteer" ? "decline" : "accept", role: action === "accept-collaborator" ? "collaborator" : "primary" } });
    }
    if (action === "invite") {
      const profileId = row.querySelector(".task-invite select").value;
      updated = await api(`/api/tasks/${task.id}/invite`, { method: "POST", body: { profileId } });
    }
    if (["accept-invite", "decline-invite"].includes(action)) updated = await api(`/api/tasks/${task.id}/invitations/respond`, { method: "POST", body: { accept: action === "accept-invite" } });
    if (["approve-proposal", "decline-proposal"].includes(action)) updated = await api(`/api/tasks/${task.id}/proposal/respond`, { method: "POST", body: { accept: action === "approve-proposal" } });
    if (action === "release") updated = await api(`/api/tasks/${task.id}/release`, { method: "POST", body: {} });
    if (action === "block") {
      const blockedReason = window.prompt("What is blocking this task?");
      if (!blockedReason) return;
      updated = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "blocked", blockedReason } });
    }
    if (action === "resume") updated = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "in_progress" } });
    if (action === "reopen") updated = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "open", clearAssignment: true } });
    if (action === "propose") return openTaskModal(task.id);
    if (action === "start") return createResult(task.expectedRelation === "proves" ? "proof" : task.expectedRelation === "refutes" ? "counterexample" : "result", task.id);
    if (updated) upsert(state.tasks, updated);
    renderWork();
  } catch (error) { showToast(error.message, "error"); }
}

async function switchWorkspace(spaceId) {
  if (spaceId === state.space.id) return $("#workspacePopover").classList.remove("open");
  try {
    closeEditor();
    await api("/api/profiles/me", { method: "PATCH", body: { activeSpaceId: spaceId } });
    stage.dataset.fitted = "";
    await loadWorkspace(spaceId);
    $("#workspacePopover").classList.remove("open");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function avatar(profile, extraClass = "") {
  return `<span class="avatar ${extraClass}" style="background:${escapeHtml(profile.color || "#64748b")}">${escapeHtml(profile.initials || "?")}</span>`;
}

function renderPresence(filter = $("#collaboratorSearch")?.value || "") {
  if (!state.profile) return;
  const people = state.presence.length ? state.presence : [{ ...state.profile, profileId: state.profile.id, activity: "You" }];
  const unique = [...new Map(people.map((person) => [person.profileId, person])).values()];
  const filtered = unique.filter((person) => person.displayName.toLowerCase().includes(filter.toLowerCase()));
  $("#collaboratorList").innerHTML = filtered.map((person) => `<div class="collaborator">
    ${avatar(person)}
    <span class="collaborator-copy"><strong>${escapeHtml(person.displayName)}</strong><small>${escapeHtml(person.profileId === state.profile.id ? "You" : person.activity || "Viewing graph")}${membershipFor(person.profileId)?.role === "lead" ? " · Lead" : ""}</small></span>
    <span class="status-dot green"></span>
  </div>`).join("") || '<div class="empty-message">No matching collaborators</div>';
  $(".avatar-stack").innerHTML = unique.slice(0, 4).map((person) => avatar(person)).join("") + (unique.length > 4 ? `<span class="avatar avatar-count">+${unique.length - 4}</span>` : "");
  $("#onlineCount").textContent = `${unique.length} online`;
}

function nodeStatusIcon(type) {
  if (type === "validated") return icon("check");
  if (type === "imported") return icon("download");
  if (type === "conjecture") return icon("lightbulb");
  if (type === "conflict") return icon("x");
  return "";
}

function renderNodes() {
  if (!nodeLayer) return;
  stage.style.width = "960px";
  stage.style.height = "920px";
  nodeLayer.innerHTML = state.results.map((result) => {
    const type = resultType(result);
    const filterType = ["draft", "pending"].includes(type) ? "pending" : type;
    const filtered = !state.filters.has(filterType);
    const starred = Boolean(result.starredBy?.includes(state.profile.id));
    const lock = state.locks.get(result.id);
    const kind = result.kind || "result";
    const kindMeta = kind === "conjecture" ? { icon: "lightbulb", label: "Conjecture" } : kind === "proof" ? { icon: "file-check-2", label: "Proof" } : kind === "counterexample" ? { icon: "circle-x", label: "Counterexample" } : null;
    const root = state.space.rootResultId === result.id;
    const taskCount = state.tasks.filter((task) => task.approvalState === "official" && task.targetResultId === result.id && task.status !== "done").length;
    return `<article class="result-node ${type} kind-${kind} ${root ? "root-problem" : ""} ${filtered ? "filtered" : ""}" data-node-id="${result.id}" style="left:${result.x}px;top:${result.y}px" tabindex="0">
      <header class="node-heading"><span class="node-status">${nodeStatusIcon(type)}</span><strong>${escapeHtml(result.title)}</strong>
        <button class="star-button ${starred ? "starred" : ""}" data-star-id="${result.id}" title="${result.starredBy?.length || 0} star${result.starredBy?.length === 1 ? "" : "s"}" aria-label="Star result">${icon("star")}</button>
      </header>
      <div class="node-body"><div class="formula" data-result-math="${result.id}"></div>
        <div class="status-row">${root ? `<span class="root-pill">${icon("target")} Root problem</span>` : ""}${kindMeta ? `<span class="kind-pill ${kind}">${icon(kindMeta.icon)} ${kindMeta.label}</span>` : ""}<span class="status-pill">${escapeHtml(statusLabel(result.status))}</span>${taskCount ? `<span class="node-task-count">${taskCount} task${taskCount === 1 ? "" : "s"}</span>` : ""}<span class="version">v${result.version || 0}.${result.draftRevision || 0}</span></div>
        <div class="citation">${lock ? `${escapeHtml(lock.displayName)} editing` : escapeHtml(result.citation || authorName(result.createdBy))}</div>
      </div>
    </article>`;
  }).join("");

  for (const result of state.results) renderStatement($(`[data-result-math="${result.id}"]`), result.statementLatex, false);
  sizeNodesToContent();
  $$(".result-node").forEach((element) => {
    element.addEventListener("pointerdown", beginNodeDrag);
    element.addEventListener("click", () => {
      if (!state.drag?.moved) openResult(element.dataset.nodeId);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") openResult(element.dataset.nodeId);
    });
  });
  $$('[data-star-id]').forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      const result = await api(`/api/results/${button.dataset.starId}/star`, { method: "POST", body: {} });
      upsert(state.results, result);
      renderNodes();
      showToast(result.starredBy.includes(state.profile.id) ? "Result starred" : "Result unstarred");
    } catch (error) { showToast(error.message, "error"); }
  }));
  refreshIcons(nodeLayer);
  requestAnimationFrame(renderEdges);
}

function sizeNodesToContent() {
  let stageWidth = 960;
  let stageHeight = 920;
  for (const result of state.results) {
    const element = $(`[data-node-id="${result.id}"]`);
    if (!element) continue;
    const title = $(".node-heading strong", element);
    const formula = $(".formula", element);
    const contentWidth = formula.classList.contains("mixed-content")
      ? measureMixedContentWidth(formula)
      : formula.scrollWidth;
    const desiredWidth = Math.ceil(Math.max(baseNodeWidth, title.scrollWidth + 76, contentWidth + 22));
    const width = Math.min(maxNodeWidth, desiredWidth);
    element.style.width = `${width}px`;
    stageWidth = Math.max(stageWidth, Number(result.x) + width + 40);
    stageHeight = Math.max(stageHeight, Number(result.y) + Math.min(405, element.scrollHeight) + 40);
  }
  stage.style.width = `${stageWidth}px`;
  stage.style.height = `${stageHeight}px`;
}

function measureMixedContentWidth(formula) {
  const probe = formula.cloneNode(true);
  probe.classList.add("node-size-probe");
  probe.style.maxWidth = `${maxNodeWidth - 22}px`;
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

function edgeClass(edge) {
  if (["proves", "refutes"].includes(edge.relation)) return `${edge.relation} ${edge.verificationStatus || "proposed"}`;
  return ({ uses: "depends", supports: "support", special_case_of: "special-case", conflicts_with: "alternative", alternative: "alternative" })[edge.relation] || "depends";
}

function renderEdges() {
  edgeLayer.querySelectorAll(".graph-edge, .edge-label").forEach((element) => element.remove());
  state.edges.forEach((edge, index) => {
    const sourceElement = $(`[data-node-id="${edge.sourceResultId}"]`);
    const targetElement = $(`[data-node-id="${edge.targetResultId}"]`);
    if (!sourceElement || !targetElement || sourceElement.classList.contains("filtered") || targetElement.classList.contains("filtered")) return;
    const source = {
      x: parseFloat(sourceElement.style.left) + sourceElement.offsetWidth / 2,
      y: parseFloat(sourceElement.style.top) + sourceElement.offsetHeight / 2
    };
    const target = {
      x: parseFloat(targetElement.style.left) + targetElement.offsetWidth / 2,
      y: parseFloat(targetElement.style.top) + targetElement.offsetHeight / 2
    };
    const vertical = Math.abs(target.y - source.y) >= Math.abs(target.x - source.x);
    const start = vertical
      ? { x: source.x, y: source.y + Math.sign(target.y - source.y) * sourceElement.offsetHeight / 2 }
      : { x: source.x + Math.sign(target.x - source.x) * sourceElement.offsetWidth / 2, y: source.y };
    const end = vertical
      ? { x: target.x, y: target.y - Math.sign(target.y - source.y) * targetElement.offsetHeight / 2 }
      : { x: target.x - Math.sign(target.x - source.x) * targetElement.offsetWidth / 2, y: target.y };
    const bend = ((index % 3) - 1) * 12;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${start.x} ${start.y} Q ${(start.x + end.x) / 2 + (vertical ? bend : 0)} ${(start.y + end.y) / 2 + (vertical ? 0 : bend)} ${end.x} ${end.y}`);
    path.setAttribute("class", `graph-edge ${edgeClass(edge)}`);
    edgeLayer.append(path);
    if (["proves", "refutes", "uses", "supports", "special_case_of"].includes(edge.relation)) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String((start.x + end.x) / 2 + (vertical ? bend : 0)));
      label.setAttribute("y", String((start.y + end.y) / 2 + (vertical ? -7 : bend - 7)));
      label.setAttribute("class", `edge-label ${edge.relation} ${edge.verificationStatus || "asserted"}`);
      label.setAttribute("text-anchor", "middle");
      label.textContent = ["proves", "refutes"].includes(edge.relation) && edge.verificationStatus !== "verified" ? `${edge.relation}?` : edge.relation === "special_case_of" ? "special case of" : edge.relation;
      const sourceResult = state.results.find((item) => item.id === edge.sourceResultId);
      const targetResult = state.results.find((item) => item.id === edge.targetResultId);
      label.setAttribute("aria-label", `${sourceResult?.title || "Source"} ${label.textContent.replace("?", " (proposed)")} ${targetResult?.title || "target"}`);
      edgeLayer.append(label);
    }
  });
}

function applyStageTransform() {
  stage.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  $("#zoomValue").textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitStage() {
  if (!viewport.clientWidth || !viewport.clientHeight) return;
  const margin = 36;
  state.zoom = Math.max(.38, Math.min(1, (viewport.clientWidth - margin * 2) / stage.offsetWidth, (viewport.clientHeight - margin * 2) / stage.offsetHeight));
  state.pan.x = Math.max(margin, (viewport.clientWidth - stage.offsetWidth * state.zoom) / 2);
  state.pan.y = 20;
  applyStageTransform();
}

function setZoom(next, center = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }) {
  const previous = state.zoom;
  state.zoom = Math.max(.45, Math.min(1.4, next));
  state.pan.x = center.x - ((center.x - state.pan.x) / previous) * state.zoom;
  state.pan.y = center.y - ((center.y - state.pan.y) / previous) * state.zoom;
  applyStageTransform();
}

function beginNodeDrag(event) {
  if (event.button !== 0 || event.target.closest("button")) return;
  hidePointerPlacement();
  const element = event.currentTarget;
  state.drag = {
    type: "node", element, resultId: element.dataset.nodeId, moved: false,
    startX: event.clientX, startY: event.clientY,
    left: parseFloat(element.style.left), top: parseFloat(element.style.top)
  };
  element.classList.add("dragging");
}

function beginPan(event) {
  if (event.button !== 0 || event.target.closest(".result-node, button, .minimap, .pointer-placement")) return;
  showPointerPlacement(event);
  state.drag = { type: state.activeTool === "pan" ? "pan" : "canvas", moved: false, startX: event.clientX, startY: event.clientY, x: state.pan.x, y: state.pan.y };
}

function movePointer(event) {
  if (!state.drag) return;
  const dx = event.clientX - state.drag.startX;
  const dy = event.clientY - state.drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4 && !state.drag.moved) {
    state.drag.moved = true;
    hidePointerPlacement();
  }
  if (state.drag.type === "pan") {
    state.pan.x = state.drag.x + dx;
    state.pan.y = state.drag.y + dy;
    applyStageTransform();
    return;
  }
  if (state.drag.type === "canvas") return;
  const result = state.results.find((item) => item.id === state.drag.resultId);
  result.x = Math.max(0, Math.min(900, state.drag.left + dx / state.zoom));
  result.y = Math.max(0, Math.min(850, state.drag.top + dy / state.zoom));
  state.drag.element.style.left = `${result.x}px`;
  state.drag.element.style.top = `${result.y}px`;
  renderEdges();
}

function endPointer() {
  if (!state.drag) return;
  const completed = state.drag;
  if (completed.type === "node") {
    completed.element.classList.remove("dragging");
    const result = state.results.find((item) => item.id === completed.resultId);
    if (completed.moved) sendRealtime({ type: "node.drag", resultId: result.id, x: result.x, y: result.y });
  }
  setTimeout(() => { if (state.drag === completed) state.drag = null; }, 0);
}

function graphPoint(event) {
  const rect = viewport.getBoundingClientRect();
  const x = (event.clientX - rect.left - state.pan.x) / state.zoom;
  const y = (event.clientY - rect.top - state.pan.y) / state.zoom;
  if (x < 0 || y < 0 || x > stage.offsetWidth || y > stage.offsetHeight) return null;
  return { x, y };
}

function showPointerPlacement(event) {
  const point = graphPoint(event);
  if (!point) return hidePointerPlacement();
  state.pointerPlacement = point;
  const popover = $("#pointerPlacement");
  const rect = viewport.getBoundingClientRect();
  popover.style.left = `${Math.max(8, Math.min(viewport.clientWidth - 196, event.clientX - rect.left + 12))}px`;
  popover.style.top = `${Math.max(8, Math.min(viewport.clientHeight - 48, event.clientY - rect.top + 12))}px`;
  popover.hidden = false;
}

function hidePointerPlacement() {
  state.pointerPlacement = null;
  $("#pointerPlacement").hidden = true;
}

function placeWorkPointer() {
  if (!state.pointerPlacement) return;
  if (state.socket?.readyState !== WebSocket.OPEN) return showToast("Live graph is reconnecting. Try again shortly.", "error");
  const pointer = { profileId: state.profile.id, displayName: state.profile.displayName, color: state.profile.color, ...state.pointerPlacement };
  state.cursors.set(state.profile.id, pointer);
  renderCursors();
  sendRealtime({ type: "cursor.place", x: pointer.x, y: pointer.y });
  hidePointerPlacement();
  showToast("Work pointer moved");
}

function renderCursors() {
  cursorLayer.innerHTML = [...state.cursors.values()].map((cursor) => `<div class="live-cursor" style="--cursor-color:${escapeHtml(cursor.color)};transform:translate(${cursor.x}px, ${cursor.y}px)"><div class="cursor-arrow"></div><span class="cursor-label">${escapeHtml(cursor.displayName)}</span></div>`).join("");
}

function connectRealtime() {
  clearTimeout(state.reconnectTimer);
  if (state.socket) state.socket.close();
  if (!state.token || !state.space) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}&space=${encodeURIComponent(state.space.id)}`);
  state.socket = socket;
  socket.addEventListener("open", () => sendRealtime({ type: "presence.update", activity: "Viewing graph" }));
  socket.addEventListener("message", (event) => handleRealtime(JSON.parse(event.data)));
  socket.addEventListener("close", () => {
    if (state.socket !== socket || !state.token) return;
    state.reconnectTimer = setTimeout(connectRealtime, 1500);
  });
}

function sendRealtime(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
}

function handleRealtime(event) {
  if (event.type === "presence.sync") {
    state.presence = event.presence;
    const activeProfiles = new Set(event.presence.map((person) => person.profileId));
    for (const profileId of state.cursors.keys()) if (!activeProfiles.has(profileId)) state.cursors.delete(profileId);
    renderPresence();
    renderWorkspace();
    renderCursors();
    return;
  }
  if (event.type === "cursor.sync") {
    state.cursors = new Map(event.cursors.map((cursor) => [cursor.profileId, cursor]));
    renderCursors();
    return;
  }
  if (["cursor.place", "cursor.move"].includes(event.type)) {
    state.cursors.set(event.profileId, event);
    renderCursors();
    return;
  }
  if (event.type === "cursor.remove") {
    state.cursors.delete(event.profileId);
    renderCursors();
    return;
  }
  if (event.type === "editing.sync") {
    state.locks = new Map(event.locks.map((lock) => [lock.resultId, lock]));
    renderNodes();
    applyEditorLock();
    return;
  }
  if (event.type === "editing.lock") {
    state.locks.set(event.lock.resultId, event.lock);
    renderNodes();
    applyEditorLock();
    return;
  }
  if (event.type === "editing.unlock") {
    state.locks.delete(event.resultId);
    renderNodes();
    applyEditorLock();
    return;
  }
  if (event.type === "editing.denied") {
    state.locks.set(event.lock.resultId, event.lock);
    applyEditorLock();
    showToast(`${event.lock.displayName} is already editing this result.`, "error");
    return;
  }
  if (event.type === "agent.status") {
    state.agentStatus = event.state;
    renderAgentStatus();
    return;
  }
  if (event.type === "queue.changed") {
    state.pendingWorkCount = event.pendingCount;
    renderAgentStatus();
    return;
  }
  if (event.type === "draft.feedback") {
    upsert(state.draftFeedback, event.entity);
    if (state.selectedResultId === event.resultId) renderFeedback();
    return;
  }
  if (event.type === "notification.new") {
    upsert(state.notifications, event.notification);
    renderNotifications();
    showToast(event.notification.title);
    return;
  }
  if (event.type === "activity.new") {
    upsert(state.activity, event.entity);
    renderActivity();
    return;
  }
  if (event.type === "profile.upsert") {
    upsert(state.profiles, event.entity);
    renderPresence();
    renderWork();
    return;
  }
  if (event.type === "space.updated") {
    upsert(state.spaces, event.entity);
    if (state.space.id === event.entity.id) state.space = event.entity;
    renderWorkspace();
    renderSpaces();
    renderSpaceSettings();
    renderNodes();
    return;
  }
  if (event.type === "entity.delete" && event.entityType === "edge") {
    state.edges = state.edges.filter((edge) => edge.id !== event.id);
    renderEdges();
    return;
  }
  if (event.type !== "entity.upsert") return;
  const collections = { result: "results", edge: "edges", review: "reviews", comment: "comments", suggestion: "suggestions", notification: "notifications", task: "tasks", membership: "memberships" };
  const collection = collections[event.entityType];
  if (!collection) return;
  if (event.entityType === "suggestion" && event.entity.status !== "open") state.suggestions = state.suggestions.filter((item) => item.id !== event.entity.id);
  else upsert(state[collection], event.entity);
  if (event.entityType === "result") {
    renderNodes();
    renderWork();
    renderSpaceSettings();
    if (state.selectedResultId === event.entity.id && !state.suppressEditorSync) updateEditorHeader(event.entity);
  }
  if (event.entityType === "edge") renderEdges();
  if (event.entityType === "suggestion") renderSuggestions();
  if (event.entityType === "notification") renderNotifications();
  if (event.entityType === "comment" && state.selectedResultId === event.entity.resultId) renderComments();
  if (event.entityType === "review" && state.selectedResultId === event.entity.resultId) renderFeedback();
  if (event.entityType === "task") {
    renderWork();
    renderNodes();
  }
  if (event.entityType === "membership") {
    if (event.entity.profileId === state.profile.id) state.currentMembership = event.entity;
    state.spaceLead = state.profiles.find((profile) => profile.id === state.memberships.find((item) => item.role === "lead")?.profileId) || state.spaceLead;
    renderWorkspace();
    renderPresence();
    renderSpaceSettings();
    renderWork();
  }
}

function currentResult() {
  return state.results.find((result) => result.id === state.selectedResultId);
}

function updateEditorHeader(result) {
  $("#editorHeading").textContent = result.title;
  const kindLabel = result.kind === "conjecture" ? "Conjecture · " : result.kind === "proof" ? "Proof · " : result.kind === "counterexample" ? "Counterexample · " : "";
  $("#editorStatus").textContent = `${kindLabel}${statusLabel(result.status)} · v${result.version || 0}.${result.draftRevision || 0}`;
  $("#editorStar").classList.toggle("starred", Boolean(result.starredBy?.includes(state.profile.id)));
  $("#submitResult").disabled = result.status !== "draft";
}

function openResult(resultId) {
  const result = state.results.find((item) => item.id === resultId);
  if (!result) return;
  if (state.selectedResultId && state.selectedResultId !== resultId) sendRealtime({ type: "editing.release", resultId: state.selectedResultId });
  state.selectedResultId = resultId;
  editor.hidden = false;
  editorScrim.hidden = false;
  updateEditorHeader(result);
  $("#resultTitle").value = result.title || "";
  $("#resultStatement").value = result.statementLatex || "";
  $("#resultHypotheses").value = (result.hypothesesLatex || []).join("\n");
  $("#resultProof").value = result.proofMarkdown || "";
  $("#resultTags").value = (result.tags || []).join(", ");
  $("#resultCitation").value = result.citation || "";
  const kindControl = $(`input[name="resultKind"][value="${result.kind || "result"}"]`);
  if (kindControl) kindControl.checked = true;
  const verificationEdge = state.edges.find((edge) => edge.sourceResultId === result.id && ["proves", "refutes"].includes(edge.relation));
  populateRelatedResults(verificationEdge?.targetResultId || result.dependencyIds?.[0] || "");
  $("#resultRelation").value = result.kind === "proof" ? "proves" : result.kind === "counterexample" ? "refutes" : "uses";
  const officialTasks = state.tasks.filter((task) => task.approvalState === "official");
  $("#resultTask").innerHTML = `<option value="">Lead blueprint work</option>` + officialTasks.map((task) => `<option value="${task.id}">${escapeHtml(task.title)}</option>`).join("");
  $("#resultTask").value = result.taskId || "";
  $("#resultTask").disabled = true;
  const coauthorProfiles = state.memberships.map((item) => state.profiles.find((profile) => profile.id === item.profileId)).filter((profile) => profile && profile.id !== result.createdBy);
  $("#resultCollaborators").innerHTML = coauthorProfiles.map((profile) => `<option value="${profile.id}" ${result.collaboratorIds?.includes(profile.id) ? "selected" : ""}>${escapeHtml(profile.displayName)}</option>`).join("");
  $("#resultCollaborators").closest("label").hidden = coauthorProfiles.length === 0;
  $(".editor-scope-row").classList.toggle("single-column", coauthorProfiles.length === 0);
  updateContributionKindUI();
  renderEditorPreview();
  renderFeedback();
  renderRevisions();
  renderComments();
  selectEditorTab("write");
  if (result.status === "draft" && (result.createdBy === state.profile.id || result.collaboratorIds?.includes(state.profile.id))) sendRealtime({ type: "editing.acquire", resultId });
  sendRealtime({ type: "presence.update", activity: `Editing ${result.title}`, activeResultId: result.id });
  applyEditorLock();
  refreshIcons(editor);
}

function closeEditor() {
  clearTimeout(state.saveTimer);
  if (state.selectedResultId) sendRealtime({ type: "editing.release", resultId: state.selectedResultId });
  state.selectedResultId = null;
  editor.hidden = true;
  editorScrim.hidden = true;
  sendRealtime({ type: "presence.update", activity: "Viewing graph", activeResultId: null });
}

function applyEditorLock() {
  const result = currentResult();
  if (!result || editor.hidden) return;
  const lock = state.locks.get(result.id);
  const otherEditor = lock && lock.profileId !== state.profile.id;
  const canAuthor = result.createdBy === state.profile.id || result.collaboratorIds?.includes(state.profile.id);
  const readOnly = result.status !== "draft" || otherEditor || !canAuthor;
  $$("#resultForm input, #resultForm textarea, #resultForm select").forEach((input) => { input.disabled = readOnly; });
  $("#resultTask").disabled = true;
  if (!readOnly && ["proof", "counterexample"].includes(selectedContributionKind())) $("#resultRelation").disabled = true;
  if (result.createdBy !== state.profile.id) $("#resultCollaborators").disabled = true;
  $("#reviewDraft").disabled = readOnly;
  $("#addRelationship").disabled = readOnly;
  $("#submitResult").disabled = readOnly;
  $("#lockBanner").hidden = !otherEditor && result.status === "draft" && canAuthor;
  $("#lockBanner").textContent = otherEditor ? `${lock.displayName} is editing. You have a read-only view.` : !canAuthor ? "Only the author and explicit coauthors can edit this draft." : `${result.kind === "conjecture" ? "Reviewed conjectures" : `${statusLabel(result.status)} results`} are read-only. Clone a revision to continue the argument.`;
}

function renderEditorPreview() {
  renderStatement($("#statementPreview"), $("#resultStatement").value, true);
  renderHypothesesPreview();
  $("#proofPreview").innerHTML = renderMarkdown($("#resultProof").value) || `<span class="empty-math">${selectedContributionKind() === "conjecture" ? "Rationale preview" : selectedContributionKind() === "counterexample" ? "Construction preview" : "Proof preview"}</span>`;
  renderLocalChecks();
}

function selectedContributionKind() {
  return $('input[name="resultKind"]:checked')?.value || "result";
}

function updateContributionKindUI() {
  const kind = selectedContributionKind();
  const conjecture = kind === "conjecture";
  const proof = kind === "proof";
  const counterexample = kind === "counterexample";
  $("#statementLabel").textContent = proof ? "Claim proved (LaTeX)" : counterexample ? "Counterexample claim (LaTeX)" : "Statement (LaTeX)";
  $("#renderedStatementLabel").textContent = proof ? "Rendered claim" : counterexample ? "Rendered counterexample" : "Rendered statement";
  $("#hypothesesLabel").textContent = proof || counterexample ? "Target hypotheses, one LaTeX expression per line" : "Hypotheses, one LaTeX expression per line";
  $("#reasoningLabel").textContent = conjecture ? "Rationale / evidence (Markdown + LaTeX, optional)" : counterexample ? "Construction and verification (Markdown + LaTeX)" : "Proof (Markdown + LaTeX)";
  $("#renderedReasoningLabel").textContent = conjecture ? "Rendered rationale" : counterexample ? "Rendered construction" : "Rendered proof";
  $("#resultProof").required = !conjecture;
  $("#resultProof").placeholder = conjecture ? "Explain why the conjecture may be plausible or useful. Use $...$ for inline math." : counterexample ? "Construct the example, verify every hypothesis, and show the exact conclusion that fails." : "State each step. Use $...$ for inline math and $$...$$ for display math.";
  $("#proofPreview").setAttribute("aria-label", conjecture ? "Rendered rationale" : "Rendered proof");
  $("#relatedResultLabel").textContent = proof ? "Conjecture proved" : counterexample ? "Conjecture refuted" : "Related result";
  if (proof) $("#resultRelation").value = "proves";
  else if (counterexample) $("#resultRelation").value = "refutes";
  else if (["proves", "refutes"].includes($("#resultRelation").value)) $("#resultRelation").value = "uses";
  $("#resultRelation").disabled = proof || counterexample;
  $("#feedbackTitle").textContent = conjecture ? "Conjecture relevance check" : proof ? "Proof verification" : counterexample ? "Counterexample verification" : "Realtime proof check";
  $("#reviewDraft").textContent = conjecture ? "Check relevance" : proof ? "Check proof" : counterexample ? "Check counterexample" : "Ask Codex now";
  $("#submitResultLabel").textContent = conjecture ? "Submit conjecture for review" : proof ? "Submit proof for validation" : counterexample ? "Submit counterexample for validation" : "Submit for AI validation";
}

function populateRelatedResults(selectedId = "") {
  const verification = ["proof", "counterexample"].includes(selectedContributionKind());
  const candidates = state.results.filter((item) => item.id !== state.selectedResultId && (!verification || (item.kind === "conjecture" && ["conjecture", "proved", "refuted"].includes(item.status))));
  $("#resultDependency").innerHTML = `<option value="">${verification ? "Choose an accepted conjecture" : "Choose a result"}</option>` + candidates.map((item) => `<option value="${item.id}">${escapeHtml(item.title)}${verification ? ` · ${escapeHtml(statusLabel(item.status))}` : ""}</option>`).join("");
  $("#resultDependency").value = candidates.some((item) => item.id === selectedId) ? selectedId : "";
}

function renderLocalChecks() {
  const statement = $("#resultStatement").value.trim();
  const proof = $("#resultProof").value.trim();
  const hypotheses = $("#resultHypotheses").value.trim();
  const kind = selectedContributionKind();
  const conjecture = kind === "conjecture";
  const proofContribution = kind === "proof";
  const counterexampleContribution = kind === "counterexample";
  const verificationContribution = proofContribution || counterexampleContribution;
  const relatedId = $("#resultDependency").value;
  const linked = Boolean(relatedId && state.edges.some((edge) => edge.sourceResultId === state.selectedResultId && edge.targetResultId === relatedId && (!verificationContribution || edge.relation === (proofContribution ? "proves" : "refutes"))));
  const checks = proofContribution ? [
    { pass: linked, text: "Link this proof to the accepted conjecture it proves." },
    { pass: statement.length > 8, text: "The claimed conclusion is present." },
    { pass: proof.length >= 80, text: proof.length >= 80 ? "Proof has enough detail for AI review." : "Expand the proof beyond a short assertion." },
    { pass: /because|since|therefore|hence|implies|apply|assume|suppose/i.test(proof), text: "Make logical transitions and invoked results explicit." }
  ] : counterexampleContribution ? [
    { pass: linked, text: "Link this counterexample to the accepted conjecture it refutes." },
    { pass: statement.length > 8, text: "State the counterexample and failed conclusion precisely." },
    { pass: proof.length >= 80, text: proof.length >= 80 ? "Construction has enough detail for Codex review." : "Verify the construction and every target hypothesis." },
    { pass: /fails|counterexample|does not|violates|however|but/i.test(proof), text: "Identify the exact target conclusion that fails." }
  ] : conjecture ? [
    { pass: statement.length > 8, text: statement.length > 8 ? "Conjecture is stated precisely enough to review." : "Add a precise conjecture statement." },
    { pass: Boolean(hypotheses) || /for all|forall|every/i.test(statement), text: "State the hypotheses and quantifier scope." },
    { pass: linked, text: "Link the conjecture to the problem or result it advances." },
    { pass: proof.length >= 40, text: proof.length >= 40 ? "Rationale gives Codex useful relevance context." : "Add a short rationale to improve relevance feedback." }
  ] : [
    { pass: statement.length > 8, text: statement.length > 8 ? "Statement is present and renderable." : "Add a precise mathematical statement." },
    { pass: proof.length >= 80, text: proof.length >= 80 ? "Proof has enough detail for AI review." : "Expand the proof beyond a short assertion." },
    { pass: /because|since|therefore|hence|implies|apply|assume|suppose/i.test(proof), text: "Make logical transitions and invoked results explicit." },
    { pass: Boolean(hypotheses) || /for all|forall|every/i.test(statement), text: "State the hypotheses and scope of the claim." }
  ];
  $("#localChecks").innerHTML = checks.map((check) => `<div class="check-item ${check.pass ? "pass" : ""}"><i></i><span>${escapeHtml(check.text)}</span></div>`).join("");
}

function renderFeedback() {
  const result = currentResult();
  if (!result) return;
  const feedback = state.draftFeedback.filter((item) => item.resultId === result.id && item.status === "current").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const review = state.reviews.filter((item) => item.resultId === result.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const source = [feedback, review].filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!source) {
    $("#codexFeedback").innerHTML = state.pendingWorkCount ? '<article><h4>Codex review queued</h4><p>The local agent can claim this work through the review command endpoints.</p></article>' : "";
    return;
  }
  const issues = (source.issues || []).map((issue) => typeof issue === "string" ? issue : issue.message || issue.description || JSON.stringify(issue));
  const checks = (source.proofStepChecks || []).filter((check) => check.status && check.status !== "pass").map((check) => check.explanation || check.summary || `Step ${check.stepId || ""} needs attention`);
  const allIssues = [...issues, ...checks];
  const sourceIsReview = source === review;
  const relevance = source.relevanceAssessment || (sourceIsReview && review.reviewType === "conjecture_relevance" ? { verdict: review.decision, explanation: review.relevanceExplanation, relatedResultIds: review.relatedResultIds } : null);
  const taskAlignment = source.taskAlignment || (source.taskOutcome ? { verdict: source.taskOutcome === "complete" ? "Task complete" : "Task remains open", explanation: source.taskRationale } : null);
  const relatedNames = (relevance?.relatedResultIds || source.relevantResultIds || []).map((id) => state.results.find((item) => item.id === id)?.title).filter(Boolean);
  const heading = sourceIsReview && review.reviewType === "conjecture_relevance" ? `Conjecture relevance: ${review.decision.replace("_", " ")}` : sourceIsReview ? `Validation: ${review.decision.replace("_", " ")}` : "Codex draft feedback";
  $("#codexFeedback").innerHTML = `<article><h4>${escapeHtml(heading)}</h4><p>${escapeHtml(source.summary || "Review completed.")}</p>${taskAlignment ? `<div class="task-alignment"><strong>${escapeHtml(String(taskAlignment.verdict).replaceAll("_", " "))}</strong><p>${escapeHtml(taskAlignment.explanation || "")}</p></div>` : ""}${relevance ? `<div class="relevance-result ${escapeHtml(relevance.verdict)}"><strong>Relevance: ${escapeHtml(relevance.verdict.replace("_", " "))}</strong><p>${escapeHtml(relevance.explanation || "")}</p>${relatedNames.length ? `<small>Related: ${escapeHtml(relatedNames.join(", "))}</small>` : ""}</div>` : ""}${allIssues.length ? `<ul>${allIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>` : ""}</article>`;
}

function renderRevisions() {
  const result = currentResult();
  if (!result) return;
  const revisions = state.revisions.filter((revision) => revision.resultId === result.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#revisionCount").textContent = revisions.length;
  $("#revisionList").innerHTML = revisions.map((revision) => `<article class="revision-item"><header><strong>Revision ${revision.revisionNumber} · ${escapeHtml(statusLabel(revision.status))}</strong><time>${relativeTime(revision.createdAt)}</time></header><div>${escapeHtml(revision.snapshot?.title || result.title)}</div><button class="secondary-button" data-clone-revision="${revision.id}">${icon("copy-plus")} Continue from this revision</button></article>`).join("") || '<div class="empty-message">The first frozen revision is created when this result is submitted.</div>';
  $$('[data-clone-revision]').forEach((button) => button.addEventListener("click", () => cloneRevision(button.dataset.cloneRevision)));
  refreshIcons($("#revisionList"));
}

function renderComments() {
  const result = currentResult();
  if (!result) return;
  const comments = state.comments.filter((comment) => comment.resultId === result.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  $("#commentCount").textContent = comments.length;
  $("#commentList").innerHTML = comments.map((comment) => `<article class="comment-item"><header><strong>${escapeHtml(authorName(comment.userId))}</strong><time>${relativeTime(comment.createdAt)}</time></header><div>${escapeHtml(comment.body)}</div></article>`).join("") || '<div class="empty-message">No comments yet.</div>';
}

function selectEditorTab(tab) {
  $$('[data-editor-tab]').forEach((button) => button.classList.toggle("active", button.dataset.editorTab === tab));
  $$('[data-editor-panel]').forEach((panel) => panel.classList.toggle("active", panel.dataset.editorPanel === tab));
}

function scheduleSave() {
  const result = currentResult();
  if (!result || result.status !== "draft") return;
  $("#saveStatus").textContent = "Unsaved changes";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveEditor().catch((error) => showToast(error.message, "error")), 700);
}

async function saveEditor() {
  clearTimeout(state.saveTimer);
  const result = currentResult();
  if (!result || result.status !== "draft") return result;
  $("#saveStatus").textContent = "Saving...";
  state.suppressEditorSync = true;
  try {
    const body = {
      title: $("#resultTitle").value.trim() || "Untitled result",
      kind: selectedContributionKind(),
      statementLatex: $("#resultStatement").value,
      hypothesesLatex: $("#resultHypotheses").value.split("\n").map((line) => line.trim()).filter(Boolean),
      proofMarkdown: $("#resultProof").value,
      tags: $("#resultTags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
      citation: $("#resultCitation").value
    };
    if (result.createdBy === state.profile.id) body.collaboratorIds = [...$("#resultCollaborators").selectedOptions].map((option) => option.value);
    const updated = await api(`/api/results/${result.id}`, { method: "PATCH", body });
    upsert(state.results, updated);
    $("#saveStatus").textContent = `Saved · draft ${updated.draftRevision}`;
    updateEditorHeader(updated);
    renderNodes();
    return updated;
  } finally {
    state.suppressEditorSync = false;
  }
}

async function requestCreateResult(kind = "result") {
  if (isLead()) return createResult(kind, null);
  const tasks = acceptedTasks();
  if (!tasks.length) return showToast("Volunteer for a task and wait for lead acceptance before starting official work.", "error");
  if (tasks.length === 1) return createResult(kind, tasks[0].id);
  state.pendingContributionKind = kind;
  $("#contributionTask").innerHTML = tasks.map((task) => `<option value="${task.id}">${escapeHtml(task.title)}</option>`).join("");
  $("#taskChooserModal").hidden = false;
  refreshIcons($("#taskChooserModal"));
}

async function createResult(kind = "result", taskId = null) {
  try {
    const title = kind === "conjecture" ? "Untitled conjecture" : kind === "proof" ? "Untitled proof" : kind === "counterexample" ? "Untitled counterexample" : "Untitled result";
    const result = await api("/api/results", { method: "POST", body: { spaceId: state.space.id, taskId, kind, title, x: 390, y: 330 } });
    upsert(state.results, result);
    if (taskId) {
      const task = state.tasks.find((item) => item.id === taskId);
      if (task) {
        if (!task.outputResultIds.includes(result.id)) task.outputResultIds.push(result.id);
        task.status = "in_progress";
      }
    }
    renderNodes();
    renderWork();
    openResult(result.id);
    $("#resultTitle").select();
  } catch (error) { showToast(error.message, "error"); }
}

async function cloneRevision(revisionId) {
  const result = currentResult();
  try {
    const clone = await api(`/api/results/${result.id}/revisions/${revisionId}/clone`, { method: "POST", body: {} });
    upsert(state.results, clone);
    renderNodes();
    openResult(clone.id);
    showToast("Editable revision created");
  } catch (error) { showToast(error.message, "error"); }
}

async function addRelationship() {
  const result = currentResult();
  const relatedId = $("#resultDependency").value;
  const relation = $("#resultRelation").value;
  if (!relatedId) return showToast("Choose a related result first.", "error");
  try {
    if (["proves", "refutes"].includes(relation)) {
      const target = state.results.find((item) => item.id === relatedId);
      $("#resultStatement").value = target.statementLatex || "";
      $("#resultHypotheses").value = (target.hypothesesLatex || []).join("\n");
      renderEditorPreview();
      await saveEditor();
    }
    const edge = await api("/api/edges", { method: "POST", body: {
      sourceResultId: result.id,
      targetResultId: relatedId,
      relation
    } });
    upsert(state.edges, edge);
    if (["proves", "refutes"].includes(relation)) {
      const target = state.results.find((item) => item.id === relatedId);
      const proof = currentResult();
      if (target && proof && Math.abs(Number(proof.x) - Number(target.x)) < 80 && Math.abs(Number(proof.y) - Number(target.y)) < 80) {
        const x = target.x <= 580 ? Math.min(900, Number(target.x) + 300) : Math.max(0, Number(target.x) - 300);
        const positioned = await api(`/api/results/${proof.id}`, { method: "PATCH", body: { x, y: Math.min(850, Number(target.y) + 170) } });
        upsert(state.results, positioned);
        renderNodes();
      }
    }
    if (relation === "uses" && !result.dependencyIds.includes(relatedId)) {
      const updated = await api(`/api/results/${result.id}`, { method: "PATCH", body: { dependencyIds: [...result.dependencyIds, relatedId] } });
      upsert(state.results, updated);
    }
    renderEdges();
    renderLocalChecks();
    showToast(relation === "proves" ? "Proposed proof link added" : relation === "refutes" ? "Proposed refutation link added" : "Graph relation added");
  } catch (error) { showToast(error.message, "error"); }
}

async function requestDraftReview() {
  try {
    await saveEditor();
    await api(`/api/results/${state.selectedResultId}/draft-review`, { method: "POST", body: {} });
    state.pendingWorkCount += 1;
    renderAgentStatus();
    renderFeedback();
    showToast(currentResult()?.kind === "conjecture" ? "Conjecture relevance check queued" : currentResult()?.kind === "proof" ? "Proof check queued" : currentResult()?.kind === "counterexample" ? "Counterexample check queued" : "Draft review queued for Codex");
  } catch (error) { showToast(error.message, "error"); }
}

async function submitCurrentResult() {
  try {
    const result = await saveEditor();
    if (!result.statementLatex.trim()) return showToast("Add a mathematical statement before submitting.", "error");
    if (result.kind !== "conjecture" && !result.proofMarkdown.trim()) return showToast("Add a statement and proof before submitting.", "error");
    const payload = await api(`/api/results/${result.id}/submit`, { method: "POST", body: {} });
    upsert(state.results, payload.result);
    if (payload.result.submittedRevisionId) state.revisions.push({ id: payload.result.submittedRevisionId, resultId: payload.result.id, revisionNumber: payload.result.version, status: payload.result.status, snapshot: payload.result, createdAt: new Date().toISOString() });
    state.pendingWorkCount += 1;
    updateEditorHeader(payload.result);
    applyEditorLock();
    renderNodes();
    renderRevisions();
    showToast(result.kind === "conjecture" ? "Conjecture queued for relevance review" : result.kind === "proof" ? "Proof and proposed edge queued for validation" : result.kind === "counterexample" ? "Counterexample and proposed edge queued for validation" : "Submitted revision queued for AI validation");
  } catch (error) { showToast(error.message, "error"); }
}

function renderSuggestions() {
  $("#suggestionCount").textContent = `${state.suggestions.length} suggestion${state.suggestions.length === 1 ? "" : "s"}`;
  $("#suggestionsList").innerHTML = state.suggestions.map((suggestion) => {
    const task = state.tasks.find((item) => item.id === suggestion.taskId);
    const canApply = suggestion.scope !== "blueprint_change" || isLead();
    return `<article class="suggestion-card ${suggestion.type === "conflict" ? "conflict" : "validated"}" data-suggestion-id="${suggestion.id}">
    <div class="suggestion-title"><span class="status-symbol validated">${icon("sparkles")}</span><strong>${escapeHtml(suggestion.title)}</strong></div>
    <div class="suggestion-scope">${escapeHtml(suggestion.scope === "within_task" ? `Within assignment${task ? ` · ${task.title}` : ""}` : "Blueprint change · lead decision")}</div>
    <p class="suggestion-copy">${escapeHtml(suggestion.explanation)}</p>
    <div class="confidence-row"><span>Confidence</span><span class="confidence-bar"><span style="width:${Math.max(0, Math.min(100, suggestion.confidence))}%"></span></span><strong>${suggestion.confidence}%</strong></div>
    <div class="suggestion-actions"><button class="primary" data-suggestion-action="accept" ${canApply ? "" : "disabled"}>${icon("git-merge")} ${canApply ? "Integrate" : "Lead decision"}</button><button data-suggestion-action="dismiss">Dismiss</button></div>
  </article>`;
  }).join("") || '<div class="empty-message">Codex suggestions relevant to your active work will appear here.</div>';
  $$('[data-suggestion-action]').forEach((button) => button.addEventListener("click", () => actOnSuggestion(button.closest("[data-suggestion-id]").dataset.suggestionId, button.dataset.suggestionAction)));
  refreshIcons($("#suggestionsList"));
}

async function actOnSuggestion(id, action) {
  try {
    await api(`/api/suggestions/${id}/${action}`, { method: "POST", body: {} });
    state.suggestions = state.suggestions.filter((suggestion) => suggestion.id !== id);
    renderSuggestions();
    showToast(action === "accept" ? "Suggestion integrated into the graph" : "Suggestion dismissed");
  } catch (error) { showToast(error.message, "error"); }
}

function notificationIcon(type) {
  return ({ validation: "badge-check", relevance: "network", conjecture_review: "lightbulb", conjecture_proved: "file-check-2", conjecture_refuted: "circle-x", task_volunteer: "hand", task_volunteer_response: "user-check", task_invite: "mail", task_invite_response: "mail-check", task_proposal: "list-plus", task_proposal_response: "list-checks", task_blocked: "circle-alert", task_released: "undo-2", task_completed: "badge-check", lead_transfer: "user-cog", draft_feedback: "sparkles", agent_failed: "circle-alert" })[type] || "bell";
}

function renderNotifications() {
  if (!state.profile) return;
  const sorted = [...state.notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const unread = sorted.filter((item) => !item.readBy?.includes(state.profile.id));
  $("#notificationBadge").textContent = unread.length;
  $("#notificationBadge").hidden = unread.length === 0;
  $("#notificationsList").innerHTML = sorted.slice(0, 8).map((notification) => `<button class="notification-item ${notification.readBy?.includes(state.profile.id) ? "" : "unread"}" data-notification-id="${notification.id}" data-entity-id="${notification.entityId || ""}">
    <span class="notification-icon" style="--notification-color:#6557ed">${icon(notificationIcon(notification.type))}</span><p><strong>${escapeHtml(notification.title)}</strong><br>${escapeHtml(notification.body)}</p><time>${relativeTime(notification.createdAt)}</time>
  </button>`).join("") || '<div class="empty-message">No notifications yet.</div>';
  $$('[data-notification-id]').forEach((button) => button.addEventListener("click", async () => {
    await readNotifications([button.dataset.notificationId]);
    if (state.results.some((result) => result.id === button.dataset.entityId)) openResult(button.dataset.entityId);
    if (state.tasks.some((task) => task.id === button.dataset.entityId)) {
      selectRightTab("work");
      $("#taskList").querySelector(`[data-task-id="${button.dataset.entityId}"]`)?.scrollIntoView({ block: "center" });
    }
  }));
  refreshIcons($("#notificationsList"));
}

async function readNotifications(ids = null) {
  try {
    const updated = await api("/api/notifications/read", { method: "POST", body: { ids } });
    updated.forEach((item) => upsert(state.notifications, item));
    renderNotifications();
  } catch (error) { showToast(error.message, "error"); }
}

function renderAgentStatus() {
  const status = state.agentStatus || { state: "offline" };
  const online = status.state !== "offline";
  const label = state.pendingWorkCount > 0 && ["offline", "idle"].includes(status.state)
    ? `${state.pendingWorkCount} queued`
    : `Agent ${status.state.replace("_", " ")}`;
  $("#agentStatus").classList.toggle("online", online);
  $("#agentStatus").lastChild.textContent = ` ${label}`;
}

function renderActivity() {
  $("#activityList").innerHTML = [...state.activity].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((item) => `<article class="activity-item"><div>${escapeHtml(item.summary)}</div><time>${relativeTime(item.createdAt)}</time></article>`).join("") || '<div class="empty-message">No workspace activity yet.</div>';
}

function selectRightTab(tab) {
  $$('[data-right-tab]').forEach((button) => button.classList.toggle("active", button.dataset.rightTab === tab));
  $$('[data-right-panel]').forEach((panel) => panel.classList.toggle("active", panel.dataset.rightPanel === tab));
}

function closeModal(id) {
  $(id).hidden = true;
}

function openTaskModal(parentTaskId = null) {
  const parent = parentTaskId ? state.tasks.find((task) => task.id === parentTaskId) : null;
  if (!isLead() && (!parent || !(parent.primaryContributorId === state.profile.id || parent.collaboratorIds.includes(state.profile.id)))) return showToast("An accepted assignment is required to propose a subtask.", "error");
  state.pendingTaskParentId = parent?.id || null;
  $("#taskForm").reset();
  $("#taskModalEyebrow").textContent = parent ? "Scoped proposal" : "Official blueprint";
  $("#taskModalTitle").textContent = parent ? "Propose subtask" : "Add task";
  $("#taskSubmitLabel").textContent = parent && !isLead() ? "Send proposal" : "Add official task";
  const officialTasks = state.tasks.filter((task) => task.approvalState === "official");
  $("#taskParent").innerHTML = `<option value="">Top level</option>` + officialTasks.map((task) => `<option value="${task.id}">${escapeHtml(task.title)}</option>`).join("");
  $("#taskParent").value = parent?.id || "";
  $("#taskParent").disabled = Boolean(parent && !isLead());
  $("#taskTarget").innerHTML = `<option value="">No target yet</option>` + state.results.map((result) => `<option value="${result.id}">${escapeHtml(result.title)}</option>`).join("");
  if (parent?.targetResultId) $("#taskTarget").value = parent.targetResultId;
  if (parent?.expectedRelation) $("#taskRelation").value = parent.expectedRelation;
  $("#taskModal").hidden = false;
  $("#taskTitle").focus();
  refreshIcons($("#taskModal"));
}

async function submitTaskForm(event) {
  event.preventDefault();
  try {
    const task = await api("/api/tasks", { method: "POST", body: {
      spaceId: state.space.id,
      title: $("#taskTitle").value,
      goal: $("#taskGoal").value,
      priority: $("#taskPriority").value,
      parentTaskId: $("#taskParent").value || state.pendingTaskParentId || null,
      targetResultId: $("#taskTarget").value || null,
      expectedRelation: $("#taskRelation").value || null
    } });
    upsert(state.tasks, task);
    closeModal("#taskModal");
    renderWork();
    showToast(task.approvalState === "proposed" ? "Subtask sent to the lead" : "Official task added");
  } catch (error) { showToast(error.message, "error"); }
}

async function submitSpaceForm(event) {
  event.preventDefault();
  try {
    const payload = await api("/api/spaces", { method: "POST", body: { name: $("#spaceName").value, rootTitle: $("#spaceRootTitle").value, rootStatement: $("#spaceRootStatement").value } });
    upsert(state.spaces, payload.space);
    await api("/api/profiles/me", { method: "PATCH", body: { activeSpaceId: payload.space.id } });
    closeModal("#spaceModal");
    $("#spaceForm").reset();
    stage.dataset.fitted = "";
    await loadWorkspace(payload.space.id);
    showToast("Theorem space created");
  } catch (error) { showToast(error.message, "error"); }
}

async function setRootProblem() {
  try {
    const updated = await api(`/api/spaces/${state.space.id}/root`, { method: "POST", body: { resultId: $("#rootResultSelect").value } });
    state.space = updated;
    upsert(state.spaces, updated);
    renderWorkspace();
    renderNodes();
    showToast("Root problem updated");
  } catch (error) { showToast(error.message, "error"); }
}

async function offerLeadTransfer() {
  try {
    const updated = await api(`/api/spaces/${state.space.id}/lead-transfer`, { method: "POST", body: { profileId: $("#leadTransferSelect").value } });
    state.space = updated;
    upsert(state.spaces, updated);
    renderSpaceSettings();
    showToast("Lead transfer offered");
  } catch (error) { showToast(error.message, "error"); }
}

async function respondLeadTransfer(accept) {
  try {
    await api(`/api/spaces/${state.space.id}/lead-transfer/respond`, { method: "POST", body: { accept } });
    await loadWorkspace(state.space.id);
    showToast(accept ? "Lead transfer accepted" : "Lead transfer declined");
  } catch (error) { showToast(error.message, "error"); }
}

function goToRoot() {
  const root = state.results.find((result) => result.id === state.space.rootResultId);
  const element = root && $(`[data-node-id="${root.id}"]`);
  if (!element) return showToast("The lead has not designated a root problem yet.", "error");
  state.pan.x = viewport.clientWidth / 2 - (Number(root.x) + element.offsetWidth / 2) * state.zoom;
  state.pan.y = viewport.clientHeight / 2 - (Number(root.y) + element.offsetHeight / 2) * state.zoom;
  applyStageTransform();
  element.focus();
}

async function copyInvite() {
  const url = `${location.origin}/join/${state.space?.inviteSlug || inviteSlug()}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Invite URL copied");
  } catch {
    showToast(url);
  }
}

let workspaceRenameActive = false;

function startWorkspaceRename() {
  if (!state.space || workspaceRenameActive || !isLead()) return;
  workspaceRenameActive = true;
  $("#workspacePopover").classList.remove("open");
  $("#workspaceNameButton").hidden = true;
  const input = $("#workspaceNameInput");
  input.hidden = false;
  input.value = state.space.name;
  input.focus();
  input.select();
}

function cancelWorkspaceRename() {
  workspaceRenameActive = false;
  $("#workspaceNameInput").hidden = true;
  $("#workspaceNameButton").hidden = false;
}

async function saveWorkspaceRename() {
  if (!workspaceRenameActive) return;
  const input = $("#workspaceNameInput");
  const name = input.value.trim();
  if (name === state.space.name) return cancelWorkspaceRename();
  if (name.length < 2) {
    showToast("Use at least two characters for the space name.", "error");
    input.focus();
    return;
  }
  workspaceRenameActive = false;
  input.hidden = true;
  $("#workspaceNameButton").hidden = false;
  try {
    const updated = await api(`/api/spaces/${state.space.id}`, { method: "PATCH", body: { name } });
    upsert(state.spaces, updated);
    state.space = updated;
    renderWorkspace();
    renderSpaces();
    showToast("Theorem space renamed");
  } catch (error) {
    showToast(error.message, "error");
    startWorkspaceRename();
  }
}

async function logout() {
  const button = $("#logoutButton");
  button.disabled = true;
  try {
    await api("/api/logout", { method: "POST", body: {} });
  } catch (error) {
    if (error.status !== 401) showToast("Server logout failed; this browser will still be signed out.", "error");
  } finally {
    state.token = null;
    clearTimeout(state.reconnectTimer);
    state.socket?.close();
    sessionStorage.removeItem(tokenKey);
    localStorage.removeItem(tokenKey);
    location.reload();
  }
}

function bindEvents() {
  $("#joinForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector("button[type=submit]");
    submit.disabled = true;
    $("#joinError").textContent = "";
    try {
      const requested = state.spaces.find((space) => space.inviteSlug === inviteSlug()) || state.spaces[0];
      const joined = await api("/api/join", { auth: false, method: "POST", body: { inviteSlug: requested.inviteSlug, displayName: $("#joinName").value, pin: $("#joinPin").value } });
      state.token = joined.token;
      sessionStorage.setItem(tokenKey, joined.token);
      await loadWorkspace(joined.space.id);
      $("#joinGate").hidden = true;
    } catch (error) {
      $("#joinError").textContent = error.message;
    } finally { submit.disabled = false; }
  });

  $("#workspaceNameButton").addEventListener("click", startWorkspaceRename);
  $("#workspaceNameInput").addEventListener("blur", saveWorkspaceRename);
  $("#workspaceNameInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); saveWorkspaceRename(); }
    if (event.key === "Escape") { event.preventDefault(); cancelWorkspaceRename(); }
  });
  $("#workspaceMenu").addEventListener("click", () => $("#workspacePopover").classList.toggle("open"));
  $("#copyInvite").addEventListener("click", copyInvite);
  $("#copySpaceUrl").addEventListener("click", copyInvite);
  $("#newSpace").addEventListener("click", () => { $("#spaceModal").hidden = false; $("#spaceName").focus(); refreshIcons($("#spaceModal")); });
  $("#closeSpaceModal").addEventListener("click", () => closeModal("#spaceModal"));
  $("#cancelSpace").addEventListener("click", () => closeModal("#spaceModal"));
  $("#spaceForm").addEventListener("submit", submitSpaceForm);
  $("#setRootResult").addEventListener("click", setRootProblem);
  $("#offerLeadTransfer").addEventListener("click", offerLeadTransfer);
  $("#acceptLeadTransfer").addEventListener("click", () => respondLeadTransfer(true));
  $("#declineLeadTransfer").addEventListener("click", () => respondLeadTransfer(false));
  $("#goRoot").addEventListener("click", goToRoot);
  $("#addTask").addEventListener("click", () => openTaskModal());
  $("#closeTaskModal").addEventListener("click", () => closeModal("#taskModal"));
  $("#cancelTask").addEventListener("click", () => closeModal("#taskModal"));
  $("#taskForm").addEventListener("submit", submitTaskForm);
  $("#closeTaskChooser").addEventListener("click", () => closeModal("#taskChooserModal"));
  $("#cancelTaskChooser").addEventListener("click", () => closeModal("#taskChooserModal"));
  $("#taskChooserForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const taskId = $("#contributionTask").value;
    closeModal("#taskChooserModal");
    createResult(state.pendingContributionKind || "result", taskId);
  });
  $$('[data-right-tab]').forEach((button) => button.addEventListener("click", () => selectRightTab(button.dataset.rightTab)));
  $$('[data-task-filter]').forEach((button) => button.addEventListener("click", () => {
    state.taskFilter = button.dataset.taskFilter;
    $$('[data-task-filter]').forEach((item) => item.classList.toggle("active", item === button));
    renderWork();
  }));
  $("#newResult").addEventListener("click", () => {
    $("#creationPopover").hidden = true;
    $("#creationMenuToggle").setAttribute("aria-expanded", "false");
    requestCreateResult("result");
  });
  $("#creationMenuToggle").addEventListener("click", () => {
    const popover = $("#creationPopover");
    popover.hidden = !popover.hidden;
    $("#creationMenuToggle").setAttribute("aria-expanded", String(!popover.hidden));
  });
  $("#newConjecture").addEventListener("click", () => {
    $("#creationPopover").hidden = true;
    $("#creationMenuToggle").setAttribute("aria-expanded", "false");
    requestCreateResult("conjecture");
  });
  $("#newProof").addEventListener("click", () => {
    $("#creationPopover").hidden = true;
    $("#creationMenuToggle").setAttribute("aria-expanded", "false");
    requestCreateResult("proof");
  });
  $("#newCounterexample").addEventListener("click", () => {
    $("#creationPopover").hidden = true;
    $("#creationMenuToggle").setAttribute("aria-expanded", "false");
    requestCreateResult("counterexample");
  });
  $("#fitView").addEventListener("click", fitStage);
  $("#layoutButton").addEventListener("click", async () => {
    try {
      const updated = await api(`/api/spaces/${state.space.id}/layout`, { method: "POST", body: {} });
      updated.forEach((result) => upsert(state.results, result));
      renderNodes();
      fitStage();
      showToast("Graph arranged by dependency");
    } catch (error) { showToast(error.message, "error"); }
  });
  $("#filterButton").addEventListener("click", () => $("#filterPopover").classList.toggle("open"));
  $$("#filterPopover input").forEach((input) => input.addEventListener("change", () => {
    input.checked ? state.filters.add(input.value) : state.filters.delete(input.value);
    renderNodes();
    const hiddenCount = $$("#filterPopover input:not(:checked)").length;
    $("#activeFilterCount").textContent = hiddenCount ? String(hiddenCount) : "";
    $("#activeFilterCount").classList.toggle("visible", hiddenCount > 0);
  }));
  $("#clearFilters").addEventListener("click", () => {
    $$("#filterPopover input").forEach((input) => { input.checked = true; state.filters.add(input.value); });
    $("#activeFilterCount").textContent = "";
    $("#activeFilterCount").classList.remove("visible");
    renderNodes();
  });
  $("#collaboratorSearch").addEventListener("input", (event) => renderPresence(event.target.value));
  $("#sidebarToggle").addEventListener("click", () => $(".app-shell").classList.toggle("left-collapsed"));
  $("#closeAssistant").addEventListener("click", () => $(".app-shell").classList.add("assistant-closed"));
  $("#assistantFab").addEventListener("click", () => { $(".app-shell").classList.remove("assistant-closed"); $("#rightPanel").classList.add("open"); selectRightTab("codex"); });
  $("#notificationTrigger").addEventListener("click", () => { $(".app-shell").classList.remove("assistant-closed"); $("#rightPanel").classList.add("open"); selectRightTab("notices"); });
  $("#markAllRead").addEventListener("click", () => readNotifications(null));
  $("#viewActivity").addEventListener("click", () => { $("#activityModal").hidden = false; });
  $("#closeActivity").addEventListener("click", () => { $("#activityModal").hidden = true; });
  $("#profileButton").addEventListener("click", () => {
    const popover = $("#profilePopover");
    popover.hidden = !popover.hidden;
    $("#profileButton").setAttribute("aria-expanded", String(!popover.hidden));
  });
  $("#logoutButton").addEventListener("click", logout);

  $("#closeEditor").addEventListener("click", closeEditor);
  editorScrim.addEventListener("click", closeEditor);
  $$('[data-editor-tab]').forEach((button) => button.addEventListener("click", () => selectEditorTab(button.dataset.editorTab)));
  $$("#resultForm input, #resultForm textarea").forEach((input) => input.addEventListener("input", () => {
    if (input.name === "resultKind") {
      populateRelatedResults();
      updateContributionKindUI();
    }
    renderEditorPreview();
    scheduleSave();
  }));
  $("#resultCollaborators").addEventListener("change", scheduleSave);
  $("#resultDependency").addEventListener("change", () => {
    if (["proof", "counterexample"].includes(selectedContributionKind())) {
      const target = state.results.find((item) => item.id === $("#resultDependency").value);
      if (target) {
        $("#resultStatement").value = target.statementLatex || "";
        $("#resultHypotheses").value = (target.hypothesesLatex || []).join("\n");
        renderEditorPreview();
        scheduleSave();
      }
    }
    renderLocalChecks();
  });
  $("#editorStar").addEventListener("click", async () => {
    const result = await api(`/api/results/${state.selectedResultId}/star`, { method: "POST", body: {} });
    upsert(state.results, result);
    updateEditorHeader(result);
    renderNodes();
  });
  $("#reviewDraft").addEventListener("click", requestDraftReview);
  $("#addRelationship").addEventListener("click", addRelationship);
  $("#submitResult").addEventListener("click", submitCurrentResult);
  $("#commentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = $("#commentBody").value.trim();
    if (!body) return;
    try {
      const comment = await api(`/api/results/${state.selectedResultId}/comments`, { method: "POST", body: { body } });
      upsert(state.comments, comment);
      $("#commentBody").value = "";
      renderComments();
    } catch (error) { showToast(error.message, "error"); }
  });

  viewport.addEventListener("pointerdown", beginPan);
  viewport.addEventListener("pointermove", movePointer);
  window.addEventListener("pointerup", endPointer);
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    hidePointerPlacement();
    const rect = viewport.getBoundingClientRect();
    setZoom(state.zoom + (event.deltaY < 0 ? .08 : -.08), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  $("#placePointerHere").addEventListener("click", placeWorkPointer);
  $("#closePointerPlacement").addEventListener("click", hidePointerPlacement);
  $("#zoomIn").addEventListener("click", () => setZoom(state.zoom + .1));
  $("#zoomOut").addEventListener("click", () => setZoom(state.zoom - .1));
  $$('[data-tool]').forEach((button) => button.addEventListener("click", () => {
    hidePointerPlacement();
    state.activeTool = button.dataset.tool;
    $$('[data-tool]').forEach((item) => item.classList.toggle("active", item === button));
  }));
  window.addEventListener("resize", () => requestAnimationFrame(renderEdges));
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") hidePointerPlacement(); });
}

bindEvents();
refreshIcons();
initialize().catch((error) => showToast(error.message, "error"));
