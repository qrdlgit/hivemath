import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import dagre from "@dagrejs/dagre";
import { WebSocket, WebSocketServer } from "ws";
import { MathHiveStore, StoreError } from "./store.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(moduleDir, "..");

function bearerToken(req) {
  const header = req.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function layoutGraph(results, edges) {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", ranksep: 100, nodesep: 55, marginx: 28, marginy: 28 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const result of results) graph.setNode(result.id, { width: 220, height: 132 });
  for (const edge of edges) {
    if (graph.hasNode(edge.sourceResultId) && graph.hasNode(edge.targetResultId)) {
      graph.setEdge(edge.sourceResultId, edge.targetResultId);
    }
  }
  dagre.layout(graph);
  const positions = {};
  for (const result of results) {
    const node = graph.node(result.id);
    positions[result.id] = { x: Math.max(0, node.x - 110), y: Math.max(0, node.y - 66) };
  }
  return positions;
}

export async function createMathHiveServer(options = {}) {
  const rootDir = options.rootDir || defaultRoot;
  const host = options.host || process.env.HOST || "127.0.0.1";
  const port = Number(options.port ?? process.env.PORT ?? 4173);
  const store = options.store || await new MathHiveStore({
    rootDir,
    storeFile: options.storeFile || process.env.STORE_FILE || "data/store.json"
  }).init({ reset: options.reset === true || process.env.RESET_STORE === "1" });

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map();
  const locks = new Map();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/vendor/katex", express.static(path.join(rootDir, "node_modules/katex/dist")));
  app.use("/vendor/markdown-it", express.static(path.join(rootDir, "node_modules/markdown-it/dist")));
  app.use("/vendor/lucide", express.static(path.join(rootDir, "node_modules/lucide/dist/umd")));

  app.get("/api/health", (req, res) => res.json({ ok: true, revision: store.data.storeRevision, pendingWorkCount: store.pendingWorkCount() }));
  app.get("/api/spaces", (req, res) => res.json(store.snapshot().spaces));
  app.post("/api/join", asyncRoute(async (req, res) => {
    res.status(201).json(await store.join(req.body || {}));
  }));

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/internal/")) return next();
    req.token = bearerToken(req);
    req.auth = store.requireSession(req.token);
    next();
  });

  app.get("/api/bootstrap", (req, res) => res.json(store.bootstrap({ token: req.token, spaceId: req.query.spaceId })));
  app.post("/api/logout", asyncRoute(async (req, res) => res.json(await store.logout(req.token))));
  app.patch("/api/profiles/me", asyncRoute(async (req, res) => res.json(await store.updateProfile(req.token, req.body || {}))));
  app.patch("/api/spaces/:spaceId", asyncRoute(async (req, res) => res.json(await store.renameSpace(req.token, req.params.spaceId, req.body?.name))));
  app.post("/api/results", asyncRoute(async (req, res) => res.status(201).json(await store.createResult(req.token, req.body || {}))));
  app.patch("/api/results/:id", asyncRoute(async (req, res) => {
    const result = await store.updateResult(req.token, req.params.id, req.body || {});
    if (["title", "statementLatex", "hypothesesLatex", "proofMarkdown", "tags", "dependencyIds", "citation", "bibtex"].some((field) => field in req.body)) {
      store.scheduleDraftReview(result.id);
    }
    res.json(result);
  }));
  app.post("/api/results/:id/star", asyncRoute(async (req, res) => res.json(await store.toggleStar(req.token, req.params.id))));
  app.post("/api/results/:id/draft-review", asyncRoute(async (req, res) => res.status(202).json(await store.requestDraftReview(req.token, req.params.id, { manual: true }))));
  app.post("/api/results/:id/submit", asyncRoute(async (req, res) => res.status(202).json(await store.submitResult(req.token, req.params.id))));
  app.get("/api/results/:id/revisions", (req, res) => res.json(store.listRevisions(req.token, req.params.id)));
  app.post("/api/results/:id/revisions/:revisionId/clone", asyncRoute(async (req, res) => res.status(201).json(await store.cloneRevision(req.token, req.params.id, req.params.revisionId))));
  app.post("/api/results/:id/comments", asyncRoute(async (req, res) => res.status(201).json(await store.addComment(req.token, req.params.id, req.body?.body))));
  app.post("/api/edges", asyncRoute(async (req, res) => res.status(201).json(await store.createEdge(req.token, req.body || {}))));
  app.delete("/api/edges/:id", asyncRoute(async (req, res) => res.json(await store.deleteEdge(req.token, req.params.id))));
  app.post("/api/spaces/:spaceId/layout", asyncRoute(async (req, res) => {
    const snapshot = store.snapshot();
    const results = snapshot.results.filter((item) => item.spaceId === req.params.spaceId);
    const edges = snapshot.edges.filter((item) => item.spaceId === req.params.spaceId);
    res.json(await store.applyLayout(req.token, req.params.spaceId, layoutGraph(results, edges)));
  }));
  app.post("/api/notifications/read", asyncRoute(async (req, res) => res.json(await store.readNotifications(req.token, req.body?.ids || null))));
  app.post("/api/suggestions/:id/accept", asyncRoute(async (req, res) => res.json(await store.acceptSuggestion(req.token, req.params.id))));
  app.post("/api/suggestions/:id/dismiss", asyncRoute(async (req, res) => res.json(await store.dismissSuggestion(req.token, req.params.id))));

  app.use("/api/internal", (req, res, next) => {
    if (!isLoopback(req)) return res.status(403).json({ error: "loopback_only", message: "Agent commands are only available from this host." });
    next();
  });
  app.get("/api/internal/work/count", (req, res) => res.json({ pendingWorkCount: store.pendingWorkCount(), agentStatus: store.data.agentStatus }));
  app.post("/api/internal/work/next", asyncRoute(async (req, res) => res.json(await store.getNextWork())));
  app.get("/api/internal/work/:id/context", (req, res) => res.json(store.getWorkContext(req.params.id)));
  app.post("/api/internal/work/:id/research-context", (req, res) => res.json(store.researchContext(req.params.id, req.body || {})));
  app.post("/api/internal/work/:id/draft-review", asyncRoute(async (req, res) => res.json(await store.submitDraftReview({ ...req.body, workId: req.params.id }))));
  app.post("/api/internal/work/:id/validation", asyncRoute(async (req, res) => res.json(await store.submitValidation({ ...req.body, workId: req.params.id }))));
  app.post("/api/internal/work/:id/integrations", asyncRoute(async (req, res) => res.json(await store.submitIntegrations({ ...req.body, workId: req.params.id }))));
  app.post("/api/internal/work/:id/fail", asyncRoute(async (req, res) => res.json(await store.failWork({ ...req.body, workId: req.params.id }))));
  app.get("/api/internal/projection/:spaceId", (req, res) => res.json(store.inspectProjection(req.params.spaceId)));
  app.post("/api/internal/agent-status", asyncRoute(async (req, res) => res.json(await store.setAgentStatus(req.body || {}))));

  app.use(express.static(path.join(rootDir, "public")));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(rootDir, "public/index.html"));
  });

  function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function lockSnapshot(spaceId) {
    return [...locks.values()].filter((lock) => lock.spaceId === spaceId);
  }

  function presenceSnapshot(spaceId) {
    return [...sockets.values()].filter((client) => client.spaceId === spaceId).map((client) => ({
      profileId: client.profile.id,
      displayName: client.profile.displayName,
      initials: client.profile.initials,
      color: client.profile.color,
      activity: client.activity || "Viewing graph",
      activeResultId: client.activeResultId || null
    }));
  }

  function broadcast(spaceId, message, audienceUserIds = null, except = null) {
    for (const [socket, client] of sockets) {
      if (socket === except || client.spaceId !== spaceId) continue;
      if (audienceUserIds?.length && !audienceUserIds.includes(client.profile.id)) continue;
      send(socket, message);
    }
  }

  function publishPresence(spaceId) {
    broadcast(spaceId, { type: "presence.sync", presence: presenceSnapshot(spaceId) });
  }

  store.on("event", (event) => {
    broadcast(event.spaceId, event, event.audienceUserIds || null);
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") return socket.destroy();
    const auth = store.getSession(url.searchParams.get("token"));
    const space = store.getSpace(url.searchParams.get("space") || auth?.profile.activeSpaceId);
    if (!auth || !space) return socket.destroy();
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, { auth, space, token: url.searchParams.get("token") });
    });
  });

  wss.on("connection", (socket, request, context) => {
    const client = { profile: context.auth.profile, token: context.token, spaceId: context.space.id, activity: "Viewing graph", activeResultId: null };
    sockets.set(socket, client);
    send(socket, { type: "ready", storeRevision: store.data.storeRevision, profileId: client.profile.id });
    send(socket, { type: "editing.sync", locks: lockSnapshot(client.spaceId) });
    publishPresence(client.spaceId);

    socket.on("message", async (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      try {
        if (message.type === "presence.update") {
          client.activity = String(message.activity || "Viewing graph").slice(0, 100);
          client.activeResultId = message.activeResultId || null;
          publishPresence(client.spaceId);
        }
        if (message.type === "cursor.move") {
          broadcast(client.spaceId, { type: "cursor.move", profileId: client.profile.id, displayName: client.profile.displayName, color: client.profile.color, x: Number(message.x) || 0, y: Number(message.y) || 0 }, null, socket);
        }
        if (message.type === "editing.acquire") {
          const current = locks.get(message.resultId);
          if (!current || current.profileId === client.profile.id || message.force === true) {
            const lock = { resultId: message.resultId, profileId: client.profile.id, displayName: client.profile.displayName, color: client.profile.color, spaceId: client.spaceId, acquiredAt: new Date().toISOString() };
            locks.set(message.resultId, lock);
            broadcast(client.spaceId, { type: "editing.lock", lock });
          } else send(socket, { type: "editing.denied", lock: current });
        }
        if (message.type === "editing.release") {
          const current = locks.get(message.resultId);
          if (current?.profileId === client.profile.id) {
            locks.delete(message.resultId);
            broadcast(client.spaceId, { type: "editing.unlock", resultId: message.resultId });
          }
        }
        if (message.type === "node.drag") {
          const updated = await store.updateResult(client.token, message.resultId, { x: message.x, y: message.y });
          send(socket, { type: "node.drag.saved", resultId: updated.id });
        }
        if (message.type === "ping") send(socket, { type: "pong", at: Date.now() });
      } catch (error) {
        send(socket, { type: "error", code: error.code || "realtime_error", message: error.message });
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      for (const [resultId, lock] of locks) {
        if (lock.profileId !== client.profile.id) continue;
        locks.delete(resultId);
        broadcast(client.spaceId, { type: "editing.unlock", resultId });
      }
      publishPresence(client.spaceId);
    });
  });

  app.use((req, res) => res.status(404).json({ error: "not_found", message: "Not found." }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof StoreError ? error.status : error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.code || "server_error", message: error.message || "Unexpected server error." });
  });

  let listening = false;
  return {
    app,
    server,
    store,
    host,
    port,
    async start() {
      if (listening) return server.address();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          listening = true;
          resolve();
        });
      });
      return server.address();
    },
    async stop() {
      for (const socket of sockets.keys()) socket.close();
      await new Promise((resolve) => wss.close(resolve));
      if (listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      listening = false;
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = await createMathHiveServer();
  const address = await runtime.start();
  const url = `http://${runtime.host}:${address.port}`;
  console.log(`MathHive POC listening on ${url}`);
  const shutdown = async () => {
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
