# MCP Playground (local)

A localhost chat app that emulates the playground from the Headless 360 workshop
("Explore Salesforce-hosted MCPs → Test Salesforce servers"), but backed by the
**local Claude Code agent** running inside this project.

Nothing about MCP is configured in the app itself: the agent is started with this
project as its working directory, so it uses the project's own `.mcp.json`
(the three Salesforce-hosted servers), `CLAUDE.md` and `.claude/settings*.json`.
OAuth tokens for the Salesforce MCP servers are the ones you already created by
authenticating in an interactive `claude` session on this machine.

## Run

```bash
cd agent-playground
npm install        # first time only
npm start          # http://127.0.0.1:3777
```

Environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3777` | HTTP port (bound to 127.0.0.1 only) |
| `PLAYGROUND_MODEL` | `claude-sonnet-5-5` | Model for every agent session |
| `PLAYGROUND_EFFORT` | `medium` | Reasoning effort |
| `PLAYGROUND_INCLUDE_ACCOUNT_MCP` | `false` | When `false`, tools from claude.ai account connectors (`mcp__claude_ai_*`) are disabled so the agent only uses the project's MCP servers. |
| `ENABLE_TOOL_SEARCH` | `false` | The app disables tool-search deferral so every MCP tool schema is in context from the first turn (fewer "wrong input" first calls). Set to `true` to restore the Claude Code default and a smaller first-turn context. |

## What you get

- Chat with streaming answers (Markdown rendered). The agent is told it runs in
  "Playground mode" (see the project `CLAUDE.md`), so it answers with inline
  HTML snippets that the chat renders in sandboxed frames (no scripts), with a
  "View source" toggle.
- Every tool call shown inline as a card: server, tool name, input JSON, result.
- MCP server list from `.mcp.json` with live connection status and tool lists.
- Tool approval modes: auto-approve project MCP tools (default), ask for every
  tool, or bypass all prompts. Permission prompts appear as cards with
  Allow / Allow for this session / Deny.
- Multi-turn conversations (the Claude Code session is resumed between messages),
  Stop button, New conversation, cost / tokens / duration of the last run.
- Conversation history that survives server restarts: every conversation is
  saved as JSON under `agent-playground/.data/conversations/` and listed in the
  sidebar. Open one to replay it (messages, tool cards, HTML answers) and keep
  chatting in the same Claude Code session, or delete it (click ✕ twice).
- Optional raw event log and thinking display for debugging.

## How it works

`server.mjs` exposes a small HTTP API and calls `query()` from
`@anthropic-ai/claude-agent-sdk`:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Project path, servers found in `.mcp.json`, last init/status |
| `POST /api/chat` | `{prompt, sessionId?, approval}` → Server-Sent Events with the agent activity |
| `POST /api/permission` | `{runId, requestId, decision}` answers a permission prompt |
| `POST /api/abort` | `{runId}` cancels a running request |
| `GET /api/conversations` | Saved conversations (newest first) |
| `GET /api/conversations/:id` | Full transcript of one conversation |
| `DELETE /api/conversations/:id` | Remove a saved conversation |

The browser (`public/app.js`) consumes the SSE stream and renders it.

## Notes

- Outside the playground the project's `CLAUDE.md` makes the agent write HTML
  report files; inside the playground it returns HTML snippets instead, so
  `Write` permission prompts should be rare.
- If a Salesforce server shows `needs-auth`, run `claude` interactively in the
  project and use `/mcp` to authenticate, then retry.
