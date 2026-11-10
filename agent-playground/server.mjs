// Local MCP playground: a tiny HTTP server that drives the Claude Code agent
// (via @anthropic-ai/claude-agent-sdk) inside THIS project, so the agent picks
// up the project's .mcp.json, CLAUDE.md and .claude/ settings automatically.
//
//   npm start            -> http://127.0.0.1:3777
//   PORT=4000 npm start  -> custom port

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(HERE, "public");
const PORT = Number(process.env.PORT || 3777);
const DEFAULT_MODEL = process.env.PLAYGROUND_MODEL || "claude-sonnet-5-5";
const DEFAULT_EFFORT = process.env.PLAYGROUND_EFFORT || "medium";
// By default only the project's MCP servers are usable by the agent. The claude.ai account
// connectors (Gmail, Drive, ...) are still listed for information but their tools are disabled,
// which keeps the first-turn context small. Set PLAYGROUND_INCLUDE_ACCOUNT_MCP=true to enable them.
const INCLUDE_ACCOUNT_MCP = process.env.PLAYGROUND_INCLUDE_ACCOUNT_MCP === "true";
const HOST = "127.0.0.1";

// ---------------------------------------------------------------------------
// Project MCP configuration (read-only: the playground never edits it)
// ---------------------------------------------------------------------------
function readProjectMcpServers() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, ".mcp.json"), "utf8"));
    return Object.entries(raw.mcpServers || {}).map(([name, cfg]) => ({
      name,
      type: cfg.type || (cfg.command ? "stdio" : "http"),
      url: cfg.url || null,
      command: cfg.command ? [cfg.command, ...(cfg.args || [])].join(" ") : null,
    }));
  } catch {
    return [];
  }
}

// MCP tool names are mcp__<server>__<tool>; "." and spaces in the server name become "_".
const mcpToolPattern = (serverName) => `mcp__${serverName.replace(/[.\s]/g, "_")}__*`;

// ---------------------------------------------------------------------------
// In-memory run state
// ---------------------------------------------------------------------------
const runs = new Map(); // runId -> { abort: AbortController, permissions: Map<requestId, resolve> }
const CACHE_FILE = path.join(HERE, ".cache", "last-status.json");
const DATA_DIR = path.join(HERE, ".data", "conversations"); // persisted conversation transcripts
let lastInit = null; // last `system/init` payload, shown in the sidebar on page load
let lastMcpStatus = null; // last detailed MCP status (includes per-server tool lists)
try {
  const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  lastInit = cached.lastInit || null;
  lastMcpStatus = cached.lastMcpStatus || null;
} catch { /* no cache yet */ }
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastInit, lastMcpStatus }));
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Conversation store (one JSON file per Claude Code session id)
// ---------------------------------------------------------------------------
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const convPath = (id) => path.join(DATA_DIR, `${id}.json`);
function loadConversation(id) {
  if (!SAFE_ID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(convPath(id), "utf8"));
  } catch {
    return null;
  }
}
function saveConversation(conv) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = convPath(conv.id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(conv));
  fs.renameSync(tmp, convPath(conv.id));
}
function listConversations() {
  try {
    return fs
      .readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadConversation(f.slice(0, -5)))
      .filter(Boolean)
      .map(({ id, title, createdAt, updatedAt, model, totalCostUsd, events }) => ({
        id, title, createdAt, updatedAt, model, totalCostUsd,
        messages: events.filter((e) => e.type === "user").length,
      }))
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  } catch {
    return [];
  }
}
// Records the events a conversation needs for replay in the UI.
class Recorder {
  constructor(prompt, model) {
    this.conv = null;
    this.pending = [{ type: "user", text: prompt, at: new Date().toISOString() }];
    this.model = model;
    this.prompt = prompt;
  }
  attach(sessionId) {
    if (this.conv) return;
    this.conv = loadConversation(sessionId) || {
      id: sessionId, title: this.prompt.slice(0, 80), createdAt: new Date().toISOString(), updatedAt: null,
      model: this.model, totalCostUsd: 0, events: [],
    };
    this.conv.events.push(...this.pending);
    this.pending = [];
    this.flush();
  }
  record(ev) {
    (this.conv ? this.conv.events : this.pending).push(ev);
    if (this.conv) this.flush();
  }
  flush() {
    this.conv.updatedAt = new Date().toISOString();
    saveConversation(this.conv);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const reqPath = new URL(req.url, `http://${HOST}`).pathname;
  const rel = reqPath === "/" ? "index.html" : reqPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// Flatten a tool_result content payload (string | content blocks) into display text.
function toolResultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b.type === "text") return b.text;
        if (b.type === "image") return "[image]";
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

// ---------------------------------------------------------------------------
// POST /api/chat  -> Server-Sent Events stream of agent activity
// ---------------------------------------------------------------------------
async function handleChat(req, res) {
  const body = await readBody(req);
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json(res, 400, { error: "prompt is required" });

  const sessionId = body.sessionId || null; // resume a previous conversation
  const approval = body.approval || "mcp"; // "mcp" | "ask" | "bypass"
  const model = body.model || DEFAULT_MODEL;
  const runId = randomUUID();
  const abort = new AbortController();
  const permissions = new Map();
  runs.set(runId, { abort, permissions });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => {
    if (res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const keepAlive = setInterval(() => !res.destroyed && res.write(": ping\n\n"), 15000);
  req.on("close", () => abort.abort());

  send("run", { runId, projectDir: PROJECT_DIR, approval });
  const recorder = new Recorder(prompt, model);
  if (sessionId) recorder.attach(sessionId);

  const projectServers = readProjectMcpServers();
  const allowedTools = approval === "ask" ? [] : projectServers.map((s) => mcpToolPattern(s.name));

  // Permission prompts are forwarded to the browser and resolved by POST /api/permission.
  const canUseTool = async (toolName, input, opts) => {
    const requestId = randomUUID();
    send("permission_request", {
      requestId,
      toolName,
      input,
      toolUseId: opts.toolUseID,
      mcpServer: opts.mcpServer?.name || null,
      reason: opts.decisionReason || null,
      hasSuggestions: true, // "Allow for this session" is always offered; it only ever adds a session-scoped rule
    });
    return new Promise((resolve) => {
      permissions.set(requestId, (decision) => {
        permissions.delete(requestId);
        if (decision === "allow") resolve({ behavior: "allow", updatedInput: input });
        else if (decision === "allow_always") {
          const session = (opts.suggestions || []).filter((u) => u.destination === "session");
          const updatedPermissions = session.length
            ? session
            : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
          resolve({ behavior: "allow", updatedInput: input, updatedPermissions });
        }
        else resolve({ behavior: "deny", message: "The user denied this tool call in the playground." });
      });
      opts.signal.addEventListener("abort", () => {
        permissions.delete(requestId);
        resolve({ behavior: "deny", message: "Run aborted." });
      });
    });
  };

  let q;
  try {
    q = query({
      prompt,
      options: {
        cwd: PROJECT_DIR,
        // Only the project's own configuration: .mcp.json, CLAUDE.md, .claude/settings*.json
        settingSources: ["project", "local"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: [
            "PLAYGROUND_MODE: this conversation comes from the MCP Playground web app, which renders your reply in a browser chat.",
            "Follow the 'Playground mode' section of CLAUDE.md: answer with an inline HTML snippet in a single ```html fenced block (a fragment without html/head/body/script tags, minimal inline styling) instead of creating, checking or serving HTML files.",
            "Plain Markdown is fine for very short answers or clarifying questions.",
          ].join(" "),
        },
        includePartialMessages: true,
        resume: sessionId || undefined,
        model,
        effort: DEFAULT_EFFORT,
        abortController: abort,
        permissionMode: approval === "bypass" ? "bypassPermissions" : "default",
        allowedTools,
        disallowedTools: INCLUDE_ACCOUNT_MCP ? [] : ["mcp__claude_ai_*"],
        canUseTool,
        env: { ...process.env, CLAUDE_CODE_MCP_STARTUP_WAIT_MS: "10000", ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || "false", CLAUDE_AGENT_SDK_CLIENT_APP: "mcp-playground/1.0.0" },
        stderr: (line) => send("stderr", { line }),
      },
    });

    for await (const m of q) {
      switch (m.type) {
        case "system": {
          if (m.subtype === "init") {
            lastInit = {
              sessionId: m.session_id,
              model: m.model,
              permissionMode: m.permissionMode,
              claudeCodeVersion: m.claude_code_version,
              cwd: m.cwd,
              tools: m.tools,
              mcpServers: m.mcp_servers,
              projectServers,
            };
            send("init", lastInit);
            saveCache();
            recorder.attach(m.session_id);
            // Detailed status (includes each server's tool list) arrives asynchronously.
            q.mcpServerStatus()
              .then((status) => {
                lastMcpStatus = status;
                saveCache();
                send("mcp_status", status);
              })
              .catch(() => {});
          } else if (m.subtype === "task_started" || m.subtype === "task_notification") {
            send("task", { subtype: m.subtype, description: m.description, status: m.status, taskId: m.task_id });
          }
          break;
        }
        case "stream_event": {
          const ev = m.event;
          if (ev.type === "content_block_start") {
            send("block_start", { index: ev.index, kind: ev.content_block.type, name: ev.content_block.name, id: ev.content_block.id });
          } else if (ev.type === "content_block_delta") {
            const d = ev.delta;
            if (d.type === "text_delta") send("delta", { index: ev.index, kind: "text", text: d.text });
            else if (d.type === "thinking_delta") send("delta", { index: ev.index, kind: "thinking", text: d.thinking });
            else if (d.type === "input_json_delta") send("delta", { index: ev.index, kind: "input_json", text: d.partial_json });
          } else if (ev.type === "content_block_stop") {
            send("block_stop", { index: ev.index });
          }
          break;
        }
        case "assistant": {
          const blocks = (m.message?.content || []).map((b) => {
            if (b.type === "text") return { type: "text", text: b.text };
            if (b.type === "thinking") return { type: "thinking", text: b.thinking || "" };
            if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
            return { type: b.type };
          });
          const assistantEvent = { blocks, parentToolUseId: m.parent_tool_use_id, error: m.error || null, stopReason: m.message?.stop_reason || null };
          send("assistant", assistantEvent);
          recorder.record({ type: "assistant", ...assistantEvent });
          break;
        }
        case "user": {
          const content = m.message?.content;
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b.type === "tool_result") {
                const toolResultEvent = {
                  toolUseId: b.tool_use_id,
                  isError: Boolean(b.is_error),
                  text: toolResultText(b.content),
                  parentToolUseId: m.parent_tool_use_id,
                };
                send("tool_result", toolResultEvent);
                recorder.record({ type: "tool_result", ...toolResultEvent, text: toolResultEvent.text.slice(0, 20000) });
              }
            }
          }
          break;
        }
        case "tool_progress": {
          send("tool_progress", { toolUseId: m.tool_use_id, toolName: m.tool_name, elapsed: m.elapsed_time_seconds });
          break;
        }
        case "result": {
          const resultEvent = {
            subtype: m.subtype,
            sessionId: m.session_id,
            isError: m.is_error,
            result: m.subtype === "success" ? m.result : null,
            errors: m.subtype === "success" ? [] : m.errors || [],
            numTurns: m.num_turns,
            durationMs: m.duration_ms,
            durationApiMs: m.duration_api_ms,
            totalCostUsd: m.total_cost_usd,
            usage: m.usage,
            permissionDenials: m.permission_denials || [],
          };
          send("result", resultEvent);
          recorder.record({ type: "result", ...resultEvent });
          if (recorder.conv) { recorder.conv.totalCostUsd += m.total_cost_usd || 0; recorder.flush(); }
          break;
        }
        case "rate_limit_event":
          send("rate_limit", m.rate_limit_info);
          break;
        default:
          break;
      }
    }
    send("done", {});
  } catch (err) {
    const message = abort.signal.aborted ? "Run aborted." : String(err?.message || err);
    send("error", { message });
    recorder.record({ type: "error", message });
  } finally {
    clearInterval(keepAlive);
    runs.delete(runId);
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${HOST}`);

    if (req.method === "GET" && pathname === "/api/config") {
      return json(res, 200, {
        projectDir: PROJECT_DIR,
        projectServers: readProjectMcpServers(),
        lastInit,
        lastMcpStatus,
        defaultModel: DEFAULT_MODEL,
        defaultEffort: DEFAULT_EFFORT,
        includeAccountMcp: INCLUDE_ACCOUNT_MCP,
        claudeMdPresent: fs.existsSync(path.join(PROJECT_DIR, "CLAUDE.md")),
      });
    }
    if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res);

    if (pathname === "/api/conversations" && req.method === "GET") return json(res, 200, listConversations());
    const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch) {
      const id = decodeURIComponent(convMatch[1]);
      if (!SAFE_ID.test(id)) return json(res, 400, { error: "Invalid conversation id" });
      if (req.method === "GET") {
        const conv = loadConversation(id);
        return conv ? json(res, 200, conv) : json(res, 404, { error: "Conversation not found" });
      }
      if (req.method === "DELETE") {
        try { fs.unlinkSync(convPath(id)); } catch { return json(res, 404, { error: "Conversation not found" }); }
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === "POST" && pathname === "/api/permission") {
      const { runId, requestId, decision } = await readBody(req);
      const run = runs.get(runId);
      const resolve = run?.permissions.get(requestId);
      if (!resolve) return json(res, 404, { error: "No pending permission request with that id" });
      resolve(decision);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && pathname === "/api/abort") {
      const { runId } = await readBody(req);
      const run = runs.get(runId);
      if (!run) return json(res, 404, { error: "Run not found (already finished?)" });
      run.abort.abort();
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405);
    res.end();
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MCP playground running at http://${HOST}:${PORT}`);
  console.log(`Project: ${PROJECT_DIR}`);
  console.log(`MCP servers from .mcp.json: ${readProjectMcpServers().map((s) => s.name).join(", ") || "(none)"}`);
});
