/* MCP Playground front-end: talks to server.mjs over fetch + Server-Sent Events. */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    messages: $("messages"), empty: $("empty"), prompt: $("prompt"), send: $("send"), stop: $("stop"),
    composer: $("composer"), runState: $("runState"), newChat: $("newChat"), approval: $("approval"),
    projectDir: $("projectDir"), model: $("model"), sessionId: $("sessionId"), ccVersion: $("ccVersion"),
    projectServers: $("projectServers"), otherServers: $("otherServers"), otherServersWrap: $("otherServersWrap"),
    serverCount: $("serverCount"), otherCount: $("otherCount"),
    statTurns: $("statTurns"), statDuration: $("statDuration"), statTokens: $("statTokens"), statCost: $("statCost"),
    modelSelect: $("modelSelect"), convList: $("convList"), convCount: $("convCount"), showTools: $("showTools"), showThinking: $("showThinking"), showLog: $("showLog"), eventLog: $("eventLog"),
  };

  const state = {
    sessionId: null,
    runId: null,
    running: false,
    projectServerNames: [],
    turn: null, // current assistant turn container
    blocks: {}, // streaming content blocks by index
    tools: {}, // tool cards by tool_use id
    pendingPerms: {}, // permission cards by requestId
    totalCost: 0,
  };

  // ---------- rendering helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Complete ```html fenced blocks are rendered as sandboxed snippets; everything else is Markdown.
  const HTML_FENCE = /```html[ \t]*\r?\n([\s\S]*?)```/g;
  function md(text) {
    const snippets = [];
    const withPlaceholders = text.replace(HTML_FENCE, (_, code) => { snippets.push(code); return `\n\n<div class="html-snippet" data-snippet="${snippets.length - 1}"></div>\n\n`; });
    let html;
    try {
      if (window.marked && window.DOMPurify) html = DOMPurify.sanitize(marked.parse(withPlaceholders, { breaks: true, gfm: true }));
    } catch { /* fall through */ }
    if (html == null) html = `<p>${esc(withPlaceholders).replace(/\n/g, "<br>")}</p>`;
    return { html, snippets };
  }
  function renderMd(el, text) {
    const { html, snippets } = md(text);
    el.innerHTML = html;
    el.querySelectorAll(".html-snippet").forEach((slot) => mountSnippet(slot, snippets[Number(slot.dataset.snippet)] || ""));
  }
  function mountSnippet(slot, code) {
    const frame = document.createElement("iframe");
    frame.className = "snippet-frame";
    frame.setAttribute("sandbox", "allow-same-origin"); // no scripts, no forms, no navigation
    frame.setAttribute("title", "HTML answer");
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
      html,body{margin:0;padding:0}
      body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#16325c;padding:4px 2px;overflow-wrap:anywhere}
      table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #e1e5ea;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f4f6f9}
      h1,h2,h3{margin:.4em 0 .3em;line-height:1.25}h1{font-size:20px}h2{font-size:16px}h3{font-size:14px}
      code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}pre{background:#f4f6f9;padding:8px;border-radius:6px;overflow:auto}
      img{max-width:100%}</style></head><body>${code}</body></html>`;
    const fit = () => { try { frame.style.height = Math.min(1600, frame.contentDocument.documentElement.scrollHeight + 8) + "px"; } catch { frame.style.height = "400px"; } };
    frame.addEventListener("load", () => { fit(); setTimeout(fit, 150); setTimeout(scroll, 160); });
    const bar = document.createElement("div");
    bar.className = "snippet-bar";
    bar.innerHTML = `<span>HTML answer</span><button type="button" class="link">View source</button>`;
    const src = document.createElement("pre");
    src.className = "snippet-source"; src.hidden = true; src.textContent = code;
    bar.querySelector("button").addEventListener("click", (e) => { src.hidden = !src.hidden; e.target.textContent = src.hidden ? "View source" : "Hide source"; });
    slot.replaceWith(bar, frame, src);
  }
  const pretty = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { return String(v); } };
  const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
  const scroll = () => { els.messages.scrollTop = els.messages.scrollHeight; };
  function splitToolName(name) {
    const m = /^mcp__(.+?)__(.+)$/.exec(name);
    return m ? { server: m[1], tool: m[2] } : { server: null, tool: name };
  }
  function log(event, data) {
    if (!els.showLog.checked) return;
    const line = document.createElement("div");
    line.textContent = `${new Date().toLocaleTimeString()} ${event} ${JSON.stringify(data).slice(0, 400)}`;
    els.eventLog.appendChild(line);
    els.eventLog.scrollTop = els.eventLog.scrollHeight;
  }
  function setRunState(kind, label) {
    els.runState.className = `run-state ${kind}`;
    els.runState.textContent = label;
  }

  // ---------- message DOM ----------
  function addUserMessage(text) {
    els.empty.hidden = true;
    const wrap = document.createElement("div");
    wrap.className = "msg user";
    wrap.innerHTML = `<div class="bubble"></div>`;
    wrap.firstChild.textContent = text;
    els.messages.appendChild(wrap);
    scroll();
  }
  function newTurn() {
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    const turn = document.createElement("div");
    turn.className = "turn";
    wrap.appendChild(turn);
    els.messages.appendChild(wrap);
    state.turn = turn;
    state.blocks = {};
    return turn;
  }
  function addNotice(text, isError) {
    const n = document.createElement("div");
    n.className = `notice${isError ? " error" : ""}`;
    n.textContent = text;
    els.messages.appendChild(n);
    scroll();
  }
  function textBubble() {
    const b = document.createElement("div");
    b.className = "bubble assistant streaming";
    b.dataset.raw = "";
    state.turn.appendChild(b);
    return b;
  }
  function thinkingBlock() {
    const t = document.createElement("div");
    t.className = "thinking";
    t.hidden = !els.showThinking.checked;
    t.dataset.raw = "";
    state.turn.appendChild(t);
    return t;
  }
  function toolCard(id, name, nested) {
    const frag = document.getElementById("tplTool").content.cloneNode(true);
    const card = frag.querySelector(".tool");
    const { server, tool } = splitToolName(name);
    card.dataset.id = id;
    if (nested) card.classList.add("nested");
    card.querySelector(".tool-name").textContent = tool;
    const srv = card.querySelector(".tool-server");
    if (server) srv.textContent = server; else srv.remove();
    card.querySelector(".tool-head").addEventListener("click", () => {
      card.classList.toggle("open");
      card.querySelector(".tool-body").hidden = !card.classList.contains("open");
    });
    card.querySelector(".tool-more").addEventListener("click", (e) => { card.classList.toggle("full"); e.target.textContent = card.classList.contains("full") ? "Collapse result" : "Show full result"; });
    card.hidden = !els.showTools.checked;
    state.turn.appendChild(card);
    state.tools[id] = card;
    scroll();
    return card;
  }
  function setToolInput(card, input) { card.querySelector(".tool-input").textContent = pretty(input); }
  function setToolResult(card, text, isError) {
    const st = card.querySelector(".tool-status");
    if (!st.classList.contains("denied")) st.className = `tool-status ${isError ? "err" : "ok"}`;
    const wrap = card.querySelector(".tool-result-wrap");
    wrap.hidden = false;
    const pre = card.querySelector(".tool-result");
    pre.textContent = text || "(empty result)";
    if ((text || "").length > 1500) card.querySelector(".tool-more").hidden = false;
    card.querySelector(".tool-elapsed").textContent = "";
  }

  function permissionCard(p) {
    const card = document.createElement("div");
    card.className = "perm";
    card.dataset.toolUseId = p.toolUseId || "";
    const { server, tool } = splitToolName(p.toolName);
    card.innerHTML = `
      <div class="perm-title">Permission required: ${esc(tool)}${server ? ` <span class="tool-server">${esc(server)}</span>` : ""}</div>
      <div class="sub-note">${p.reason ? esc(p.reason) : "The agent wants to run this tool. Allow it?"}</div>
      <pre></pre>
      <div class="perm-actions">
        <button class="btn btn-ok" data-d="allow">Allow once</button>
        <button class="btn btn-secondary" data-d="allow_always" ${p.hasSuggestions ? "" : "hidden"}>Allow for this session</button>
        <button class="btn btn-danger" data-d="deny">Deny</button>
      </div>`;
    card.querySelector("pre").textContent = pretty(p.input);
    card.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => decide(p.requestId, b.dataset.d, card)));
    state.turn.appendChild(card);
    state.pendingPerms[p.requestId] = card;
    setRunState("waiting", "Waiting for your approval");
    scroll();
  }
  async function decide(requestId, decision, card) {
    card.classList.add("resolved");
    card.querySelector(".perm-actions").innerHTML = `<span class="sub-note">${decision === "deny" ? "Denied" : "Allowed"}</span>`;
    delete state.pendingPerms[requestId];
    if (!Object.keys(state.pendingPerms).length) setRunState("running", "Working…");
    await fetch("/api/permission", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: state.runId, requestId, decision }) });
    const t = state.tools[card.dataset.toolUseId];
    if (t && decision === "deny") t.querySelector(".tool-status").className = "tool-status denied";
  }

  // ---------- sidebar ----------
  function renderServers(init, detailed) {
    const projectNames = new Set((init?.projectServers || []).map((s) => s.name));
    state.projectServerNames = [...projectNames];
    const byName = {};
    for (const s of init?.mcpServers || []) byName[s.name] = { ...s };
    for (const s of detailed || []) byName[s.name] = { ...(byName[s.name] || {}), ...s };
    // Make sure every .mcp.json server shows even before the first run.
    for (const s of init?.projectServers || []) byName[s.name] = { name: s.name, status: "not started", url: s.url, ...(byName[s.name] || {}) , config: byName[s.name]?.config || s };

    const open = new Set([...document.querySelectorAll(".server.open")].map((n) => n.dataset.name));
    const project = [], other = [];
    for (const s of Object.values(byName)) (projectNames.has(s.name) ? project : other).push(s);
    els.projectServers.innerHTML = project.map(serverHtml).join("") || `<div class="hint">No servers found in .mcp.json</div>`;
    els.otherServers.innerHTML = other.map(serverHtml).join("");
    els.serverCount.textContent = project.length;
    els.otherCount.textContent = other.length;
    els.otherServersWrap.hidden = other.length === 0;
    document.querySelectorAll(".server").forEach((n) => { if (open.has(n.dataset.name)) n.classList.add("open"); n.querySelector(".server-head").addEventListener("click", () => n.classList.toggle("open")); });
  }
  function serverHtml(s) {
    const tools = s.tools || [];
    const url = s.url || s.config?.url || "";
    return `<div class="server" data-name="${esc(s.name)}">
      <div class="server-head"><span class="dot ${esc(s.status)}"></span><span class="server-name" title="${esc(s.name)}">${esc(s.name)}</span><span class="server-status">${esc(s.status)}${tools.length ? ` · ${tools.length} tools` : ""}</span></div>
      ${url ? `<div class="server-url">${esc(url)}</div>` : ""}
      ${s.error ? `<div class="server-url" style="color:var(--err)">${esc(s.error)}</div>` : ""}
      <ul class="server-tools">${tools.map((t) => `<li title="${esc(t.description || "")}">${esc(t.name)}</li>`).join("") || "<li>(tool list not reported yet)</li>"}</ul>
    </div>`;
  }
  function applyInit(init) {
    if (!init) return;
    els.projectDir.textContent = init.cwd || init.projectDir || "";
    els.projectDir.title = els.projectDir.textContent;
    els.model.textContent = init.model || "–";
    els.ccVersion.textContent = init.claudeCodeVersion || "–";
  }

  // ---------- SSE parsing ----------
  async function streamSSE(response, onEvent) {
    const reader = response.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let event = "message", data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data) onEvent(event, JSON.parse(data));
      }
    }
  }

  // ---------- main send flow ----------
  async function send(text) {
    if (state.running || !text.trim()) return;
    state.running = true;
    els.send.disabled = true; els.stop.hidden = false; els.prompt.value = "";
    setRunState("running", "Working…");
    addUserMessage(text);
    newTurn();
    state.tools = {};
    let currentText = null;

    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, sessionId: state.sessionId, approval: els.approval.value, model: els.modelSelect.value }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);

      await streamSSE(res, (event, d) => {
        log(event, d);
        switch (event) {
          case "run": state.runId = d.runId; break;
          case "init":
            applyInit(d);
            if (!state.sessionId) { state.sessionId = d.sessionId; els.sessionId.textContent = d.sessionId; els.sessionId.title = d.sessionId; }
            renderServers(d, null);
            break;
          case "mcp_status": renderServersWithStatus(d); break;
          case "block_start":
            if (d.kind === "text") state.blocks[d.index] = { kind: "text", el: textBubble() };
            else if (d.kind === "thinking") state.blocks[d.index] = { kind: "thinking", el: thinkingBlock() };
            else if (d.kind === "tool_use") { const card = toolCard(d.id, d.name, false); card.querySelector(".tool-input").textContent = "…"; state.blocks[d.index] = { kind: "tool_use", el: card, json: "" }; }
            break;
          case "delta": {
            const b = state.blocks[d.index]; if (!b) break;
            if (b.kind === "text" || b.kind === "thinking") { b.el.dataset.raw += d.text; if (b.kind === "text") renderMd(b.el, b.el.dataset.raw); else b.el.innerHTML = esc(b.el.dataset.raw); scroll(); }
            else if (b.kind === "tool_use") { b.json += d.text; b.el.querySelector(".tool-input").textContent = b.json; }
            break;
          }
          case "block_stop": { const b = state.blocks[d.index]; if (b?.kind === "text") b.el.classList.remove("streaming"); else if (!b) document.querySelectorAll(".bubble.streaming").forEach((x) => x.classList.remove("streaming")); break; }
          case "assistant":
            // Reconcile final content (also covers subagent turns, which are not streamed).
            for (const blk of d.blocks) {
              if (blk.type === "tool_use") {
                const card = state.tools[blk.id] || toolCard(blk.id, blk.name, Boolean(d.parentToolUseId));
                setToolInput(card, blk.input);
              } else if (blk.type === "text" && d.parentToolUseId) {
                const n = document.createElement("div"); n.className = "sub-note"; n.textContent = `subagent: ${blk.text.slice(0, 300)}`; state.turn.appendChild(n);
              } else if (blk.type === "text" && !Object.values(state.blocks).some((b) => b.kind === "text")) {
                const el = textBubble(); el.classList.remove("streaming"); renderMd(el, blk.text);
              }
            }
            if (d.error) addNotice(`Assistant error: ${d.error}`, true);
            for (const b of Object.values(state.blocks)) if (b.kind === "text") b.el.classList.remove("streaming");
            state.blocks = {};
            scroll();
            break;
          case "tool_result": { const card = state.tools[d.toolUseId]; if (card) setToolResult(card, d.text, d.isError); break; }
          case "tool_progress": { const card = state.tools[d.toolUseId]; if (card) card.querySelector(".tool-elapsed").textContent = `${Math.round(d.elapsed)}s`; break; }
          case "permission_request": permissionCard(d); break;
          case "task": break;
          case "rate_limit": if (d.status !== "allowed") addNotice(`Rate limit: ${d.status}`, d.status === "rejected"); break;
          case "stderr": break;
          case "result":
            state.sessionId = d.sessionId; els.sessionId.textContent = d.sessionId; els.sessionId.title = d.sessionId;
            state.totalCost += d.totalCostUsd || 0;
            els.statTurns.textContent = d.numTurns;
            els.statDuration.textContent = `${fmtMs(d.durationMs)} (API ${fmtMs(d.durationApiMs)})`;
            els.statTokens.textContent = `${(d.usage?.input_tokens || 0) + (d.usage?.cache_read_input_tokens || 0) + (d.usage?.cache_creation_input_tokens || 0)} / ${d.usage?.output_tokens || 0}`;
            els.statCost.textContent = `$${(d.totalCostUsd || 0).toFixed(4)} (session $${state.totalCost.toFixed(4)})`;
            if (d.subtype !== "success") addNotice(`Run ended: ${d.subtype}${d.errors?.length ? ` – ${d.errors.join("; ")}` : ""}`, true);
            if (d.permissionDenials?.length) addNotice(`${d.permissionDenials.length} tool call(s) were denied.`);
            break;
          case "error": addNotice(d.message, true); break;
          case "done": break;
        }
      });
    } catch (err) {
      addNotice(`Request failed: ${err.message}`, true);
    } finally {
      document.querySelectorAll(".bubble.streaming").forEach((x) => x.classList.remove("streaming"));
      // Disable any permission card that is still waiting: the run is over.
      for (const card of Object.values(state.pendingPerms)) { card.classList.add("resolved"); card.querySelector(".perm-actions").innerHTML = `<span class="sub-note">Run ended before a decision was made</span>`; }
      for (const card of Object.values(state.tools)) { const st = card.querySelector(".tool-status"); if (st.classList.contains("spinner")) st.className = "tool-status denied"; }
      state.running = false; state.runId = null; state.pendingPerms = {};
      els.send.disabled = false; els.stop.hidden = true;
      setRunState("idle", "Idle");
      els.prompt.focus();
      loadConversations();
    }
  }
  // ---------- conversation history (persisted by the server) ----------
  function resetView() {
    els.messages.querySelectorAll(".msg, .notice, .replay-note").forEach((n) => n.remove());
    els.empty.hidden = false;
    ["statTurns", "statDuration", "statTokens", "statCost"].forEach((k) => (els[k].textContent = "–"));
    state.sessionId = null; state.totalCost = 0; state.tools = {}; state.blocks = {};
    els.sessionId.textContent = "new"; els.sessionId.title = "";
  }
  async function loadConversations() {
    try {
      const list = await (await fetch("/api/conversations")).json();
      els.convCount.textContent = list.length;
      if (!list.length) { els.convList.innerHTML = `<div class="hint">No saved conversations yet.</div>`; return; }
      els.convList.innerHTML = list.map((c) => `
        <div class="conv${c.id === state.sessionId ? " active" : ""}" data-id="${esc(c.id)}" title="${esc(c.title)}">
          <div class="conv-main"><div class="conv-title">${esc(c.title)}</div>
          <div class="conv-meta">${new Date(c.updatedAt || c.createdAt).toLocaleString()} · ${c.messages} msg · $${(c.totalCostUsd || 0).toFixed(3)}</div></div>
          <button type="button" class="conv-del" title="Delete conversation">✕</button>
        </div>`).join("");
      els.convList.querySelectorAll(".conv").forEach((row) => {
        row.addEventListener("click", () => openConversation(row.dataset.id));
        row.querySelector(".conv-del").addEventListener("click", async (e) => {
          e.stopPropagation();
          if (row.dataset.confirm !== "1") { row.dataset.confirm = "1"; e.target.textContent = "Delete?"; setTimeout(() => { row.dataset.confirm = ""; e.target.textContent = "✕"; }, 3000); return; }
          await fetch(`/api/conversations/${encodeURIComponent(row.dataset.id)}`, { method: "DELETE" });
          if (row.dataset.id === state.sessionId) resetView();
          loadConversations();
        });
      });
    } catch { /* server unreachable; ignore */ }
  }
  async function openConversation(id) {
    if (state.running) return;
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
    if (!res.ok) return addNotice("Conversation not found on disk.", true);
    const conv = await res.json();
    resetView();
    state.sessionId = conv.id; els.sessionId.textContent = conv.id; els.sessionId.title = conv.id;
    if (conv.model) els.model.textContent = conv.model;
    state.totalCost = conv.totalCostUsd || 0;
    replay(conv.events || []);
    loadConversations();
    const note = document.createElement("div"); note.className = "replay-note";
    note.textContent = "Restored from history. Send a message to continue this conversation.";
    els.messages.appendChild(note); scroll();
  }
  function replay(events) {
    let turn = null;
    for (const ev of events) {
      if (ev.type === "user") { addUserMessage(ev.text); turn = newTurn(); state.tools = {}; }
      else if (!turn) continue;
      else if (ev.type === "assistant") {
        for (const blk of ev.blocks || []) {
          if (blk.type === "text" && blk.text) {
            if (ev.parentToolUseId) { const n = document.createElement("div"); n.className = "sub-note"; n.textContent = `subagent: ${blk.text.slice(0, 300)}`; turn.appendChild(n); }
            else { const el = textBubble(); el.classList.remove("streaming"); renderMd(el, blk.text); }
          } else if (blk.type === "tool_use") { const card = toolCard(blk.id, blk.name, Boolean(ev.parentToolUseId)); setToolInput(card, blk.input); }
        }
      } else if (ev.type === "tool_result") { const card = state.tools[ev.toolUseId]; if (card) setToolResult(card, ev.text, ev.isError); }
      else if (ev.type === "result") {
        els.statTurns.textContent = ev.numTurns; els.statDuration.textContent = `${fmtMs(ev.durationMs)} (API ${fmtMs(ev.durationApiMs)})`;
        els.statTokens.textContent = `${(ev.usage?.input_tokens || 0) + (ev.usage?.cache_read_input_tokens || 0) + (ev.usage?.cache_creation_input_tokens || 0)} / ${ev.usage?.output_tokens || 0}`;
        els.statCost.textContent = `$${(ev.totalCostUsd || 0).toFixed(4)} (session $${state.totalCost.toFixed(4)})`;
        if (ev.subtype !== "success") addNotice(`Run ended: ${ev.subtype}`, true);
      } else if (ev.type === "error") addNotice(ev.message, true);
    }
    for (const card of Object.values(state.tools)) { const st = card.querySelector(".tool-status"); if (st.classList.contains("spinner")) st.className = "tool-status denied"; }
    state.tools = {}; state.blocks = {};
    scroll();
  }

  function renderServersWithStatus(detailed) {
    // mcp_status carries tool lists; merge with the init already rendered.
    fetch("/api/config").then((r) => r.json()).then((cfg) => renderServers(cfg.lastInit || { projectServers: cfg.projectServers }, detailed)).catch(() => {});
  }

  // ---------- events ----------
  els.composer.addEventListener("submit", (e) => { e.preventDefault(); send(els.prompt.value); });
  els.prompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(els.prompt.value); } });
  els.stop.addEventListener("click", () => state.runId && fetch("/api/abort", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: state.runId }) }));
  els.newChat.addEventListener("click", () => {
    if (state.running) return;
    resetView();
    loadConversations();
    els.prompt.focus();
  });
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.dataset.prompt)));
  els.showTools.addEventListener("change", () => document.querySelectorAll(".tool").forEach((t) => (t.hidden = !els.showTools.checked)));
  els.showThinking.addEventListener("change", () => document.querySelectorAll(".thinking").forEach((t) => (t.hidden = !els.showThinking.checked)));
  els.showLog.addEventListener("change", () => (els.eventLog.hidden = !els.showLog.checked));

  // ---------- boot ----------
  fetch("/api/config").then((r) => r.json()).then((cfg) => {
    els.projectDir.textContent = cfg.projectDir; els.projectDir.title = cfg.projectDir;
    applyInit(cfg.lastInit);
    if (!cfg.lastInit) els.model.textContent = cfg.defaultModel || "–";
    if (cfg.defaultModel && ![...els.modelSelect.options].some((o) => o.value === cfg.defaultModel)) els.modelSelect.add(new Option(cfg.defaultModel, cfg.defaultModel));
    if (cfg.defaultModel) els.modelSelect.value = cfg.defaultModel;
    renderServers(cfg.lastInit || { projectServers: cfg.projectServers }, cfg.lastMcpStatus);
  }).catch(() => addNotice("Could not reach the local server.", true));
  loadConversations();
  els.prompt.focus();
})();
