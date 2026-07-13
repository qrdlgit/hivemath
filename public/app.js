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
  agentStatus: { state: "offline" },
  pendingWorkCount: 0,
  selectedResultId: null,
  socket: null,
  reconnectTimer: null,
  saveTimer: null,
  suppressEditorSync: false,
  zoom: 1,
  pan: { x: 0, y: 0 },
  drag: null,
  activeTool: "pan",
  filters: new Set(["validated", "pending", "imported", "conflict"])
};

const stage = $("#graphStage");
const viewport = $("#graphViewport");
const nodeLayer = $("#nodesLayer");
const edgeLayer = $("#edgesLayer");
const cursorLayer = $("#liveCursors");
const editor = $("#resultEditor");
const editorScrim = $("#editorScrim");
const markdown = window.markdownit({ html: false, breaks: true, linkify: true });

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
  const withTokens = String(source || "").replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (match, block, inline) => {
    const index = expressions.push({ value: block || inline, displayMode: Boolean(block) }) - 1;
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
  if (result.status === "validated") return "validated";
  if (result.status === "imported") return "imported";
  if (["conflict_resolved", "rejected"].includes(result.status)) return "conflict";
  if (result.status === "draft") return "draft";
  return "pending";
}

function statusLabel(status) {
  return ({
    validated: "Validated",
    imported: "Imported",
    pending_review: "Pending review",
    conflict_resolved: "Conflict resolved",
    rejected: "Rejected",
    draft: "Draft"
  })[status] || status;
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
    <span class="collaborator-copy"><strong>${escapeHtml(person.displayName)}</strong><small>${escapeHtml(person.profileId === state.profile.id ? "You" : person.activity || "Viewing graph")}</small></span>
    <span class="status-dot green"></span>
  </div>`).join("") || '<div class="empty-message">No matching collaborators</div>';
  $(".avatar-stack").innerHTML = unique.slice(0, 4).map((person) => avatar(person)).join("") + (unique.length > 4 ? `<span class="avatar avatar-count">+${unique.length - 4}</span>` : "");
  $("#onlineCount").textContent = `${unique.length} online`;
}

function nodeStatusIcon(type) {
  if (type === "validated") return icon("check");
  if (type === "imported") return icon("download");
  if (type === "conflict") return icon("x");
  return "";
}

function renderNodes() {
  if (!nodeLayer) return;
  nodeLayer.innerHTML = state.results.map((result) => {
    const type = resultType(result);
    const filterType = ["draft", "pending"].includes(type) ? "pending" : type;
    const filtered = !state.filters.has(filterType);
    const starred = Boolean(result.starredBy?.length);
    const lock = state.locks.get(result.id);
    return `<article class="result-node ${type} ${filtered ? "filtered" : ""}" data-node-id="${result.id}" style="left:${result.x}px;top:${result.y}px" tabindex="0">
      <header class="node-heading"><span class="node-status">${nodeStatusIcon(type)}</span><strong>${escapeHtml(result.title)}</strong>
        <button class="star-button ${starred ? "starred" : ""}" data-star-id="${result.id}" title="${result.starredBy?.length || 0} star${result.starredBy?.length === 1 ? "" : "s"}" aria-label="Star result">${icon("star")}</button>
      </header>
      <div class="node-body"><div class="formula" data-result-math="${result.id}"></div>
        <div class="status-row"><span class="status-pill">${escapeHtml(statusLabel(result.status))}</span><span class="version">v${result.version || 0}.${result.draftRevision || 0}</span></div>
        <div class="citation">${lock ? `${escapeHtml(lock.displayName)} editing` : escapeHtml(result.citation || authorName(result.createdBy))}</div>
      </div>
    </article>`;
  }).join("");

  for (const result of state.results) renderLatex($(`[data-result-math="${result.id}"]`), result.statementLatex, false);
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

function edgeClass(relation) {
  return ({ depends_on: "depends", supports: "support", conflicts_with: "alternative", contributes_to: "import" })[relation] || "depends";
}

function renderEdges() {
  edgeLayer.querySelectorAll(".graph-edge").forEach((element) => element.remove());
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
    path.setAttribute("class", `graph-edge ${edgeClass(edge.relation)}`);
    edgeLayer.append(path);
  });
}

function applyStageTransform() {
  stage.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  $("#zoomValue").textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitStage() {
  if (!viewport.clientWidth || !viewport.clientHeight) return;
  const margin = 36;
  state.zoom = Math.max(.48, Math.min(1, (viewport.clientWidth - margin * 2) / 960, (viewport.clientHeight - margin * 2) / 920));
  state.pan.x = Math.max(margin, (viewport.clientWidth - 960 * state.zoom) / 2);
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
  const element = event.currentTarget;
  state.drag = {
    type: "node", element, resultId: element.dataset.nodeId, moved: false,
    startX: event.clientX, startY: event.clientY,
    left: parseFloat(element.style.left), top: parseFloat(element.style.top)
  };
  element.classList.add("dragging");
}

function beginPan(event) {
  if (event.button !== 0 || state.activeTool !== "pan" || event.target.closest(".result-node, button, .minimap")) return;
  state.drag = { type: "pan", moved: false, startX: event.clientX, startY: event.clientY, x: state.pan.x, y: state.pan.y };
}

function movePointer(event) {
  sendCursor(event);
  if (!state.drag) return;
  const dx = event.clientX - state.drag.startX;
  const dy = event.clientY - state.drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) state.drag.moved = true;
  if (state.drag.type === "pan") {
    state.pan.x = state.drag.x + dx;
    state.pan.y = state.drag.y + dy;
    applyStageTransform();
    return;
  }
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

let lastCursorAt = 0;
function sendCursor(event) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN || Date.now() - lastCursorAt < 80) return;
  const rect = viewport.getBoundingClientRect();
  const x = (event.clientX - rect.left - state.pan.x) / state.zoom;
  const y = (event.clientY - rect.top - state.pan.y) / state.zoom;
  if (x < 0 || y < 0 || x > 960 || y > 920) return;
  lastCursorAt = Date.now();
  sendRealtime({ type: "cursor.move", x, y });
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
    renderPresence();
    renderWorkspace();
    return;
  }
  if (event.type === "cursor.move") {
    state.cursors.set(event.profileId, event);
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
    return;
  }
  if (event.type === "entity.delete" && event.entityType === "edge") {
    state.edges = state.edges.filter((edge) => edge.id !== event.id);
    renderEdges();
    return;
  }
  if (event.type !== "entity.upsert") return;
  const collections = { result: "results", edge: "edges", review: "reviews", comment: "comments", suggestion: "suggestions", notification: "notifications" };
  const collection = collections[event.entityType];
  if (!collection) return;
  if (event.entityType === "suggestion" && event.entity.status !== "open") state.suggestions = state.suggestions.filter((item) => item.id !== event.entity.id);
  else upsert(state[collection], event.entity);
  if (event.entityType === "result") {
    renderNodes();
    if (state.selectedResultId === event.entity.id && !state.suppressEditorSync) updateEditorHeader(event.entity);
  }
  if (event.entityType === "edge") renderEdges();
  if (event.entityType === "suggestion") renderSuggestions();
  if (event.entityType === "notification") renderNotifications();
  if (event.entityType === "comment" && state.selectedResultId === event.entity.resultId) renderComments();
  if (event.entityType === "review" && state.selectedResultId === event.entity.resultId) renderFeedback();
}

function currentResult() {
  return state.results.find((result) => result.id === state.selectedResultId);
}

function updateEditorHeader(result) {
  $("#editorHeading").textContent = result.title;
  $("#editorStatus").textContent = `${statusLabel(result.status)} · v${result.version || 0}.${result.draftRevision || 0}`;
  $("#editorStar").classList.toggle("starred", Boolean(result.starredBy?.length));
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
  $("#resultDependency").innerHTML = '<option value="">Choose a result</option>' + state.results.filter((item) => item.id !== result.id).map((item) => `<option value="${item.id}">${escapeHtml(item.title)}</option>`).join("");
  $("#resultDependency").value = result.dependencyIds?.[0] || "";
  $("#resultRelation").value = "depends_on";
  renderEditorPreview();
  renderFeedback();
  renderRevisions();
  renderComments();
  selectEditorTab("write");
  if (result.status === "draft") sendRealtime({ type: "editing.acquire", resultId });
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
  const readOnly = result.status !== "draft" || otherEditor;
  $$("#resultForm input, #resultForm textarea, #resultForm select").forEach((input) => { input.disabled = readOnly; });
  $("#reviewDraft").disabled = readOnly;
  $("#addRelationship").disabled = readOnly;
  $("#submitResult").disabled = readOnly;
  $("#lockBanner").hidden = !otherEditor && result.status === "draft";
  $("#lockBanner").textContent = otherEditor ? `${lock.displayName} is editing. You have a read-only view.` : `${statusLabel(result.status)} results are read-only. Clone a revision to continue the argument.`;
}

function renderEditorPreview() {
  renderLatex($("#statementPreview"), $("#resultStatement").value, true);
  $("#proofPreview").innerHTML = renderMarkdown($("#resultProof").value) || '<span class="empty-math">Proof preview</span>';
  renderLocalChecks();
}

function renderLocalChecks() {
  const statement = $("#resultStatement").value.trim();
  const proof = $("#resultProof").value.trim();
  const hypotheses = $("#resultHypotheses").value.trim();
  const checks = [
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
  const source = feedback || review;
  if (!source) {
    $("#codexFeedback").innerHTML = state.pendingWorkCount ? '<article><h4>Codex review queued</h4><p>The local agent can claim this work through the review command endpoints.</p></article>' : "";
    return;
  }
  const issues = (source.issues || []).map((issue) => typeof issue === "string" ? issue : issue.message || issue.description || JSON.stringify(issue));
  const checks = (source.proofStepChecks || []).filter((check) => check.status && check.status !== "pass").map((check) => check.explanation || check.summary || `Step ${check.stepId || ""} needs attention`);
  const allIssues = [...issues, ...checks];
  $("#codexFeedback").innerHTML = `<article><h4>${review ? `Validation: ${escapeHtml(review.decision.replace("_", " "))}` : "Codex draft feedback"}</h4><p>${escapeHtml(source.summary || "Review completed.")}</p>${allIssues.length ? `<ul>${allIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>` : ""}</article>`;
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
    const updated = await api(`/api/results/${result.id}`, { method: "PATCH", body: {
      title: $("#resultTitle").value.trim() || "Untitled result",
      statementLatex: $("#resultStatement").value,
      hypothesesLatex: $("#resultHypotheses").value.split("\n").map((line) => line.trim()).filter(Boolean),
      proofMarkdown: $("#resultProof").value,
      tags: $("#resultTags").value.split(",").map((tag) => tag.trim()).filter(Boolean),
      citation: $("#resultCitation").value
    }});
    upsert(state.results, updated);
    $("#saveStatus").textContent = `Saved · draft ${updated.draftRevision}`;
    updateEditorHeader(updated);
    renderNodes();
    return updated;
  } finally {
    state.suppressEditorSync = false;
  }
}

async function createResult() {
  try {
    const result = await api("/api/results", { method: "POST", body: { spaceId: state.space.id, title: "Untitled result", x: 390, y: 330 } });
    upsert(state.results, result);
    renderNodes();
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
    const edge = await api("/api/edges", { method: "POST", body: { sourceResultId: relatedId, targetResultId: result.id, relation } });
    upsert(state.edges, edge);
    if (relation === "depends_on" && !result.dependencyIds.includes(relatedId)) {
      const updated = await api(`/api/results/${result.id}`, { method: "PATCH", body: { dependencyIds: [...result.dependencyIds, relatedId] } });
      upsert(state.results, updated);
    }
    renderEdges();
    showToast("Graph relation added");
  } catch (error) { showToast(error.message, "error"); }
}

async function requestDraftReview() {
  try {
    await saveEditor();
    await api(`/api/results/${state.selectedResultId}/draft-review`, { method: "POST", body: {} });
    state.pendingWorkCount += 1;
    renderAgentStatus();
    renderFeedback();
    showToast("Draft review queued for Codex");
  } catch (error) { showToast(error.message, "error"); }
}

async function submitCurrentResult() {
  try {
    const result = await saveEditor();
    if (!result.statementLatex.trim() || !result.proofMarkdown.trim()) return showToast("Add a statement and proof before submitting.", "error");
    const payload = await api(`/api/results/${result.id}/submit`, { method: "POST", body: {} });
    upsert(state.results, payload.result);
    if (payload.result.submittedRevisionId) state.revisions.push({ id: payload.result.submittedRevisionId, resultId: payload.result.id, revisionNumber: payload.result.version, status: payload.result.status, snapshot: payload.result, createdAt: new Date().toISOString() });
    state.pendingWorkCount += 1;
    updateEditorHeader(payload.result);
    applyEditorLock();
    renderNodes();
    renderRevisions();
    showToast("Submitted revision queued for AI validation");
  } catch (error) { showToast(error.message, "error"); }
}

function renderSuggestions() {
  $("#suggestionCount").textContent = `${state.suggestions.length} suggestion${state.suggestions.length === 1 ? "" : "s"}`;
  $("#suggestionsList").innerHTML = state.suggestions.map((suggestion) => `<article class="suggestion-card ${suggestion.type === "conflict" ? "conflict" : "validated"}" data-suggestion-id="${suggestion.id}">
    <div class="suggestion-title"><span class="status-symbol validated">${icon("sparkles")}</span><strong>${escapeHtml(suggestion.title)}</strong></div>
    <p class="suggestion-copy">${escapeHtml(suggestion.explanation)}</p>
    <div class="confidence-row"><span>Confidence</span><span class="confidence-bar"><span style="width:${Math.max(0, Math.min(100, suggestion.confidence))}%"></span></span><strong>${suggestion.confidence}%</strong></div>
    <div class="suggestion-actions"><button class="primary" data-suggestion-action="accept">${icon("git-merge")} Integrate</button><button data-suggestion-action="dismiss">Dismiss</button></div>
  </article>`).join("") || '<div class="empty-message">Codex suggestions relevant to your active work will appear here.</div>';
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
  return ({ validation: "badge-check", relevance: "network", draft_feedback: "sparkles", agent_failed: "circle-alert" })[type] || "bell";
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

async function copyInvite() {
  const url = `${location.origin}/join/${state.space?.inviteSlug || inviteSlug()}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Invite URL copied");
  } catch {
    showToast(url);
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

  $("#workspaceMenu").addEventListener("click", () => $("#workspacePopover").classList.toggle("open"));
  $("#copyInvite").addEventListener("click", copyInvite);
  $("#copySpaceUrl").addEventListener("click", copyInvite);
  $("#newResult").addEventListener("click", createResult);
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
    $("#activeFilterCount").textContent = state.filters.size < 3 ? String(3 - state.filters.size) : "";
  }));
  $("#clearFilters").addEventListener("click", () => {
    $$("#filterPopover input").forEach((input) => { input.checked = true; state.filters.add(input.value); });
    renderNodes();
  });
  $("#collaboratorSearch").addEventListener("input", (event) => renderPresence(event.target.value));
  $("#sidebarToggle").addEventListener("click", () => $(".app-shell").classList.toggle("left-collapsed"));
  $("#closeAssistant").addEventListener("click", () => $(".app-shell").classList.add("assistant-closed"));
  $("#assistantFab").addEventListener("click", () => { $(".app-shell").classList.remove("assistant-closed"); $("#rightPanel").classList.add("open"); });
  $("#notificationTrigger").addEventListener("click", () => { $(".app-shell").classList.remove("assistant-closed"); $("#rightPanel").classList.add("open"); });
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
    renderEditorPreview();
    scheduleSave();
  }));
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
    const rect = viewport.getBoundingClientRect();
    setZoom(state.zoom + (event.deltaY < 0 ? .08 : -.08), { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });
  $("#zoomIn").addEventListener("click", () => setZoom(state.zoom + .1));
  $("#zoomOut").addEventListener("click", () => setZoom(state.zoom - .1));
  $$('[data-tool]').forEach((button) => button.addEventListener("click", () => {
    state.activeTool = button.dataset.tool;
    $$('[data-tool]').forEach((item) => item.classList.toggle("active", item === button));
  }));
  window.addEventListener("resize", () => requestAnimationFrame(renderEdges));
}

bindEvents();
refreshIcons();
initialize().catch((error) => showToast(error.message, "error"));
