import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const once = process.argv.includes("--once");
const intervalMs = Math.max(1000, Number(process.env.AGENT_POLL_MS || 3000));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(rootDir, "mcp/server.mjs")],
  cwd: rootDir,
  env: { ...process.env, MATHHIVE_URL: process.env.MATHHIVE_URL || "http://127.0.0.1:4173" },
  stderr: "inherit"
});
const client = new Client({ name: "mathhive-poller", version: "0.1.0" });
const operatorPrompt = await readFile(path.join(rootDir, "prompts/operator.md"), "utf8");
let running = false;
let stopped = false;

await client.connect(transport);

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content?.[0]?.text || `${name} failed`);
  if (response.structuredContent) return response.structuredContent;
  const text = response.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : {};
}

function runCodex() {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", [
      "exec",
      "--ephemeral",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "-C", rootDir,
      operatorPrompt
    ], { cwd: rootDir, env: process.env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Codex operator exited with ${signal || `code ${code}`}`));
    });
  });
}

async function poll() {
  if (running || stopped) return false;
  const status = await call("get_queue_status");
  if (!status.pendingWorkCount) {
    if (status.agentStatus?.state !== "idle") await call("set_agent_status", { state: "idle", currentWorkType: null });
    return false;
  }
  running = true;
  await call("set_agent_status", { state: "starting", currentWorkType: null });
  console.log(`MathHive agent found ${status.pendingWorkCount} queued item(s). Starting Codex.`);
  try {
    await runCodex();
    await call("set_agent_status", { state: "idle", currentWorkType: null });
  } catch (error) {
    console.error(error.message);
    await call("set_agent_status", { state: "failed", currentWorkType: null }).catch(() => {});
    if (once) throw error;
  } finally {
    running = false;
  }
  return true;
}

async function shutdown() {
  stopped = true;
  await call("set_agent_status", { state: "offline", currentWorkType: null }).catch(() => {});
}

process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));

if (once) {
  await poll();
  await shutdown();
  process.exit(0);
} else {
  await call("set_agent_status", { state: "idle", currentWorkType: null });
  console.log(`MathHive MCP poller watching every ${intervalMs}ms.`);
  while (!stopped) {
    try { await poll(); } catch (error) { console.error(`Poll failed: ${error.message}`); }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
