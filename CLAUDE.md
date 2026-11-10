## Tools and Context
Use this projects MCPs to resolve the request  
- salesforce-api-context
- salesforce-metadata-experts
- salesforce-sobject-all

You will never use local context, the only context you may use is what is obtained from the MCPs and what the user tells you in the conversation.

## Responses
Always offer the responses in a HTML format, creating local html file to be open in the VSCode integrated browser.

Always create the HTML with the local skill `readable-html-report` ([.claude/skills/readable-html-report/SKILL.md](.claude/skills/readable-html-report/SKILL.md)). This skill is the one exception to the "no local context" rule: it covers presentation only, never Salesforce content.
- Start from its template: `.claude/skills/readable-html-report/assets/report-template.html`
- Follow its content, layout and SVG diagram rules
- Check the file with its static checker, which must report `PASS` with 0 errors:
  `python3 .claude/skills/readable-html-report/scripts/check_html.py <report.html>`
- Publish it with `.claude/skills/readable-html-report/scripts/serve.sh <report.html>`, then give the user the printed URL to open in the VS Code integrated browser (`Cmd+Shift+P` → "Simple Browser: Show")

The checker is how you confirm the file can be read well by a human. Don't use the Playwright MCP to screenshot or visually check the HTML.

### Playground mode (inline HTML snippets)
When the conversation says it comes from the **MCP Playground** web app (the system prompt or the user message states `PLAYGROUND_MODE`), do NOT create, check or serve HTML files. Instead return the answer as an inline HTML snippet inside your chat reply, which the app renders in the front-end:
- Put the snippet in a single fenced block that starts with ```html and ends with ```; you may add one or two short Markdown sentences before or after it.
- The snippet is a fragment: no `<!doctype>`, `<html>`, `<head>` or `<body>`, no `<script>`, no external resources. Use semantic HTML (headings, paragraphs, tables, lists, definition lists) and keep styling to a minimal `<style>` block or inline styles; it is shown inside a light-themed panel about 800px wide.
- Keep the same content quality rules as the file reports (clear title, short summary, tables for field lists, source server/tool named at the end).
- Only the file-based flow above requires the `readable-html-report` skill; playground snippets don't use it.

## User Interaction
Ask the user in the conversation what you need to complete the request if something is ambiguous or unexplained

## Additional requests
You will attend any request when using all your power if the request begins with a double exclamation symbol "!!"