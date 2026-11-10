---
name: readable-html-report
description: Create human-readable, self-contained HTML report files (Salesforce schema/data answers, field guides, analyses, diagrams) that render well in the VS Code integrated browser WITHOUT a visual check via Playwright. Use whenever a response in this project must be delivered as an HTML file, or when an existing HTML report needs to be created, extended or fixed. Provides a proven template, layout/writing/SVG rules, and a static checker script that replaces screenshot verification.
---

# Readable HTML report

Every answer in this project is delivered as a local HTML file opened in the VS Code integrated browser.
This skill makes that page readable **by construction** and verifies it **statically**, so no Playwright
screenshots are needed.

## Workflow

1. **Gather the content first** (from the project MCPs, per CLAUDE.md). Decide the reader's question and the
   2–4 sections that answer it before writing any HTML.
2. **Start from the template.** Copy `assets/report-template.html` (in this skill folder) to the project root with a
   descriptive kebab-case name (e.g. `opportunity-pipeline-health.html`), then replace every `{{...}}`
   placeholder and delete components you don't use. Keep the `<style>` block; extend it only with token-based rules.
3. **Follow the rules below** while writing.
4. **Run the checker** and fix everything it reports. It must say `PASS` with **0 errors**. Fix warnings too
   unless you can say why one doesn't apply:
   ```bash
   python3 .claude/skills/readable-html-report/scripts/check_html.py <report.html>
   ```
5. **Publish locally** and give the user the URL to open in the VS Code integrated browser:
   ```bash
   .claude/skills/readable-html-report/scripts/serve.sh <report.html>
   ```
   Tell the user: `Cmd+Shift+P` → **Simple Browser: Show** → paste the printed URL. Also give the clickable
   markdown link to the file. Don't use Playwright to check the page; the checker replaces it.

## Content rules (what makes it readable)

- **Lead with the answer.** The `<h1>` names the subject; the sub-line says what the page answers. Put data caveats
  (empty org, partial data, assumptions) in a callout right under the header. Never bury them.
- **One idea per section**; a one-line purpose sentence under each `h2`.
- **Tables for fields/records**: columns `Field | Type | (Theme) | What it tells you`. Write full sentences in the
  last column. Put picklist values in `<span class="vals">A · B · C</span>`. Mark custom fields with
  `<span class="badge">custom</span>`. Highlight missing or gap rows with `<tr class="gap">`.
- **Tags** (`.tag.c1`–`.tag.c4`) for up to 4 recurring themes; define them once in a summary grid at the top.
- **Queries/code** go in `<pre><code>`. **Escape `<` as `&lt;` and `>` as `&gt;`** (SOQL comparisons!). Only show
  queries that were actually run against the org, and state that they were.
- Be explicit about **what was verified vs. inferred** (e.g. "schema-based, org has 0 records").
- Footer: list the sources (MCP tools, objects, queries) that produced the content.
- Keep prose under ~80 characters per line (the template's `max-width` handles it); avoid walls of text.

## Layout rules (bugs found in earlier reports, now prevented)

| Rule | Why |
|---|---|
| Every `<table>` inside `<div class="table-wrap">` | wide tables scroll instead of breaking the page |
| Field-name column = `<td class="k">`; nowrap applies only to the `<code>` inside | putting `white-space:nowrap` on a whole cell with several field names squeezed the description column into a narrow strip |
| Inline `<code>` in prose, lists and tiles may wrap (`overflow-wrap:anywhere`, already in the template) | 25+ character API names (`Account.UpsellOpportunity__c`) overflowed 240px grid cards |
| Colours only through CSS tokens (`var(--ink)`, `var(--c2)`…), never hex in `style=""` | the dark palette (VS Code dark theme) only works through tokens |
| No external CSS/JS/fonts/images | the page must work offline and in the VS Code browser; use system fonts and inline SVG |
| Grids use `repeat(auto-fit,minmax(240px,1fr))`; never fixed pixel widths on containers | the VS Code browser pane is often narrow |
| Exactly one `h1`, no skipped heading levels, unique `id`s, every `#anchor` link resolves | navigation chips (`.toc`) must work |

## SVG diagram rules

Use a diagram only when relationships matter more than lists (e.g. an object model). Start from the commented
diagram block in the template.

- Fixed grid: boxes `200×60`, columns at x = 30 / 350 / 670, rows at y = 30 / 210 / 380 inside `viewBox="0 0 900 470"`.
  Box title at (x+16, y+26) 15px, subtitle at (x+16, y+46) 12px. Box titles must fit (≈ 0.56 × 15px per character,
  so at most 20 characters in a 200px box).
- Draw **edges before boxes** so boxes cover the line ends; arrows from child to parent with `marker-end`.
- **Labels never sit on a line.** Horizontal edge: label 8–10px *above* the line, centred with
  `text-anchor="middle"`. Vertical edge: label 8px to the *right* of the line. Diagonal or curved edge: put the label
  on the outer side of the curve and use `text-anchor="end"` when it sits to the left. Keep at least 6px between
  labels.
- All colours via tokens inside the SVG `<style>` (`fill:var(--ink)` etc.); `role="img"` and `aria-label` on `<svg>`.
- Add a `.legend` under the diagram for each line style (solid / dashed / dotted).
- The checker estimates every label's bounding box and fails if a label overlaps another label, is crossed by a
  line or curve, straddles a box border, overflows its box, or is clipped by the viewBox. Trust it, and fix the
  coordinates rather than guessing.

## What the checker verifies

`scripts/check_html.py` (pure Python, no dependencies). Errors fail the check; warnings are advisory.

- Well-formed markup (unclosed or mismatched tags), `<title>`, `charset`, `viewport`, doctype
- Unescaped `<` and unknown tags (text that the browser would swallow)
- Broken in-page anchors, duplicate ids, heading structure, near-empty sections
- Tables outside `.table-wrap`; nowrap cells holding long text (error)
- Long unbreakable `<code>` tokens outside tables when no wrap rule targets `code`
- External resources; hard-coded colours in inline styles
- WCAG contrast of `--ink`/`--muted` on `--bg`/`--surface` (light and dark), and tag text on its `-soft` background
- SVG label collisions as described above

If you add a new component that the checker can't reason about (e.g. a complex chart), keep it simple: inline SVG
with the same token colours, labels outside marks, and a data table beside it so the content stays readable even
if the graphic doesn't.
