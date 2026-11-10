#!/usr/bin/env python3
"""Static readability checker for HTML reports - no browser required.

Usage:  python3 check_html.py <file.html> [more.html ...]
Exit code 0 = no errors (warnings allowed), 1 = at least one error.

It catches the layout problems that previously needed a Playwright screenshot:
  * malformed markup (unclosed / mismatched tags)
  * missing <title>, charset, viewport
  * unescaped "<" in text (typical in SOQL: "CloseDate < TODAY")
  * broken in-page anchors (#id that does not exist)
  * tables not wrapped in a horizontal-scroll container (.table-wrap)
  * table cells with a nowrap class that hold long text (squeezes other columns)
  * long unbreakable tokens in prose/cards with no wrapping rule
  * external resources (reports must be self-contained / work offline)
  * hard-coded colours in inline styles (break dark mode)
  * WCAG contrast of the theme tokens (--ink/--muted on --bg/--surface), light + dark
  * heading structure (one h1, no skipped levels) and empty sections
  * SVG diagrams: labels overlapping each other, crossing box borders,
    being crossed by connector lines/curves, or falling outside the viewBox
"""
import re
import sys
from html.parser import HTMLParser

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "param", "source", "track", "wbr"}
SVG_SELF = {"path", "line", "rect", "circle", "ellipse", "polyline", "polygon", "stop", "use"}
KNOWN_TAGS = VOID | SVG_SELF | {
    "html", "head", "body", "title", "style", "script", "div", "span", "p", "a", "ul", "ol", "li",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "h1", "h2", "h3",
    "h4", "h5", "h6", "header", "footer", "section", "article", "nav", "main", "aside", "pre",
    "code", "strong", "em", "b", "i", "u", "small", "sup", "sub", "blockquote", "details",
    "summary", "figure", "figcaption", "svg", "g", "text", "tspan", "defs", "marker", "title",
    "desc", "lineargradient", "radialgradient", "clippath", "mask", "pattern", "symbol",
    "foreignobject", "label", "button", "select", "option", "textarea", "form", "kbd", "mark",
    "abbr", "time", "dl", "dt", "dd", "noscript", "template", "picture", "video", "audio", "canvas",
    "iframe", "object", "s", "del", "ins", "q", "cite", "var", "samp", "fieldset", "legend",
}
LONG_TOKEN = 24          # chars without a break opportunity (~190px of 13px monospace = a narrow card)
NOWRAP_CELL_TEXT = 36    # chars of text in a nowrap cell before it squeezes the table


class Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def err(self, line, msg):
        self.errors.append((line, msg))

    def warn(self, line, msg):
        self.warnings.append((line, msg))


# ----------------------------------------------------------------------------- CSS helpers
def css_blocks(css):
    """Yield (selector, body) for flat rules, also inside @media blocks."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        yield m.group(1).strip(), m.group(2)


def tokens_from(body):
    return {k: v.strip() for k, v in re.findall(r"(--[\w-]+)\s*:\s*([^;]+)", body)}


def hex_to_rgb(v):
    v = v.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})", v)
    if not m:
        return None
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def luminance(rgb):
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def check_theme_contrast(css, rep):
    css_nc = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    light, dark = {}, {}
    # light = bare :root rules outside @media; dark = :root inside a prefers-color-scheme:dark block
    dark_media = re.search(r"@media\s*\(prefers-color-scheme:\s*dark\)\s*\{(.*?\})\s*\}", css_nc, re.S)
    outside = css_nc
    if dark_media:
        outside = css_nc.replace(dark_media.group(0), "")
        for sel, body in css_blocks(dark_media.group(1)):
            if ":root" in sel:
                dark.update(tokens_from(body))
    for sel, body in css_blocks(outside):
        if sel.strip() == ":root":
            light.update(tokens_from(body))
    if not light:
        rep.warn(0, "No :root colour tokens found - cannot verify text contrast (use the skill template).")
        return
    if not dark:
        rep.warn(0, "No dark-mode palette (@media (prefers-color-scheme: dark)). VS Code dark theme users "
                    "may get a glaring page; add one (see template).")
    pairs = [("--ink", "--bg", 7.0), ("--ink", "--surface", 7.0),
             ("--muted", "--bg", 4.5), ("--muted", "--surface", 4.5)]
    for name, pal in (("light", light), ("dark", {**light, **dark})):
        if name == "dark" and not dark:
            continue
        for fg, bg, minimum in pairs:
            a, b = hex_to_rgb(pal.get(fg, "")), hex_to_rgb(pal.get(bg, ""))
            if a and b:
                c = contrast(a, b)
                if c < minimum:
                    rep.err(0, f"[{name}] contrast {fg} on {bg} is {c:.2f}:1 (needs >= {minimum}:1).")
        # accent-like tokens used as text on their *-soft background
        for k, v in pal.items():
            soft = pal.get(k + "-soft")
            a, b = hex_to_rgb(v), hex_to_rgb(soft or "")
            if a and b and contrast(a, b) < 4.5:
                rep.warn(0, f"[{name}] tag/badge text {k} on {k}-soft is {contrast(a, b):.2f}:1 (< 4.5:1).")


def nowrap_td_classes(css):
    classes = set()
    for sel, body in css_blocks(css):
        if re.search(r"white-space\s*:\s*nowrap", body):
            for part in sel.split(","):
                part = part.strip()
                m = re.fullmatch(r"td\.([\w-]+)", part)
                if m:
                    classes.add(m.group(1))
                if part in ("td:first-child", "td"):
                    classes.add("__" + part)
    return classes


def has_wrap_rule(css):
    """True when some rule targeting <code> lets long identifiers break."""
    for sel, body in css_blocks(css):
        if "code" in sel and re.search(r"overflow-wrap\s*:\s*(anywhere|break-word)|word-break\s*:\s*break-(all|word)", body):
            return True
    return False


# ----------------------------------------------------------------------------- SVG geometry
def seg_intersects_rect(x1, y1, x2, y2, r):
    """Liang-Barsky clip: does segment touch rect r=(l,t,r,b)?"""
    l, t, rr, b = r
    dx, dy = x2 - x1, y2 - y1
    p = [-dx, dx, -dy, dy]
    q = [x1 - l, rr - x1, y1 - t, b - y1]
    u0, u1 = 0.0, 1.0
    for pi, qi in zip(p, q):
        if pi == 0:
            if qi < 0:
                return False
        else:
            u = qi / pi
            if pi < 0:
                u0 = max(u0, u)
            else:
                u1 = min(u1, u)
            if u0 > u1:
                return False
    return True


def rect_overlap(a, b, pad=0):
    return not (a[2] + pad <= b[0] or b[2] + pad <= a[0] or a[3] + pad <= b[1] or b[3] + pad <= a[1])


def path_to_segments(d):
    """Approximate M/L/C/Q/H/V (absolute) paths as polylines."""
    toks = re.findall(r"[MLCQHVZmlcqhvz]|-?\d*\.?\d+(?:e-?\d+)?", d)
    segs, i, cur, start, cmd = [], 0, (0.0, 0.0), (0.0, 0.0), None

    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v
    while i < len(toks):
        if re.fullmatch(r"[A-Za-z]", toks[i]):
            cmd = toks[i]; i += 1
            if cmd in "Zz":
                segs.append((cur, start)); cur = start
            continue
        if cmd is None:
            break
        rel = cmd.islower()
        c = cmd.upper()
        ox, oy = cur if rel else (0.0, 0.0)
        try:
            if c == "M":
                cur = start = (num() + ox, num() + oy); cmd = "l" if rel else "L"
            elif c == "L":
                p = (num() + ox, num() + oy); segs.append((cur, p)); cur = p
            elif c == "H":
                p = (num() + (cur[0] if rel else 0), cur[1]); segs.append((cur, p)); cur = p
            elif c == "V":
                p = (cur[0], num() + (cur[1] if rel else 0)); segs.append((cur, p)); cur = p
            elif c in "CQ":
                n = 3 if c == "C" else 2
                pts = [(num() + ox, num() + oy) for _ in range(n)]
                ctrl = [cur] + pts
                prev = cur
                for s in range(1, 13):
                    t = s / 12
                    if c == "C":
                        x = sum(coef * pt[0] for coef, pt in zip(
                            [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3], ctrl))
                        y = sum(coef * pt[1] for coef, pt in zip(
                            [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3], ctrl))
                    else:
                        x = sum(coef * pt[0] for coef, pt in zip([(1 - t) ** 2, 2 * (1 - t) * t, t ** 2], ctrl))
                        y = sum(coef * pt[1] for coef, pt in zip([(1 - t) ** 2, 2 * (1 - t) * t, t ** 2], ctrl))
                    segs.append((prev, (x, y))); prev = (x, y)
                cur = pts[-1]
            else:
                i += 1
        except (IndexError, ValueError):
            break
    return segs


class SvgCollector:
    def __init__(self, line):
        self.line = line
        self.viewbox = None
        self.class_font = {}     # class -> (size_px, mono)
        self.texts, self.rects, self.segs = [], [], []
        self.cur_text = None
        self.style_buf = ""
        self.in_style = False
        self.in_defs = 0


def svg_font(attrs, coll):
    size, mono = 12.0, False
    for cls in (attrs.get("class") or "").split():
        if cls in coll.class_font:
            size, mono = coll.class_font[cls]
    fs = attrs.get("font-size")
    if fs:
        try:
            size = float(re.sub(r"px$", "", fs))
        except ValueError:
            pass
    st = attrs.get("style") or ""
    m = re.search(r"font-size\s*:\s*([\d.]+)px", st)
    if m:
        size = float(m.group(1))
    if "mono" in (attrs.get("font-family") or "") or "mono" in st:
        mono = True
    return size, mono


def text_bbox(t):
    size, mono = t["font"]
    width = len(t["text"]) * size * (0.61 if mono else 0.56)
    x, y = t["x"], t["y"]
    anchor = t["anchor"]
    if anchor == "middle":
        x -= width / 2
    elif anchor == "end":
        x -= width
    return (x, y - size * 0.80, x + width, y + size * 0.22)


def analyse_svg(coll, rep):
    texts = [t for t in coll.texts if t["text"].strip()]
    boxes = [(t, text_bbox(t)) for t in texts]
    where = f"SVG@line {coll.line}"
    # labels vs labels
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            if rect_overlap(boxes[i][1], boxes[j][1], pad=1):
                rep.err(coll.line, f"{where}: labels overlap: '{boxes[i][0]['text']}' and '{boxes[j][0]['text']}'.")
    # labels vs rect borders (label partly inside, partly outside a box)
    for t, bb in boxes:
        for r in coll.rects:
            inside = bb[0] >= r[0] and bb[2] <= r[2] and bb[1] >= r[1] and bb[3] <= r[3]
            if rect_overlap(bb, r) and not inside:
                rep.err(coll.line, f"{where}: label '{t['text']}' crosses the border of a box at "
                                   f"x={r[0]:.0f},y={r[1]:.0f}. Move it fully inside or outside.")
        # labels vs connector lines
        shrink = (bb[0] + 1, bb[1] + 1, bb[2] - 1, bb[3] - 1)
        for (a, b) in coll.segs:
            if seg_intersects_rect(a[0], a[1], b[0], b[1], shrink):
                rep.err(coll.line, f"{where}: connector line passes through label '{t['text']}' "
                                   f"(near x={t['x']:.0f}, y={t['y']:.0f}). Offset the label or use text-anchor.")
                break
        # labels inside the viewBox
        if coll.viewbox:
            vx, vy, vw, vh = coll.viewbox
            if bb[0] < vx - 1 or bb[1] < vy - 1 or bb[2] > vx + vw + 1 or bb[3] > vy + vh + 1:
                rep.err(coll.line, f"{where}: label '{t['text']}' is clipped by the viewBox.")
    # text too long for the box it sits in
    for t, bb in boxes:
        for r in coll.rects:
            if bb[0] >= r[0] - 2 and bb[0] < r[2] and r[1] <= t["y"] <= r[3] and bb[2] > r[2]:
                rep.err(coll.line, f"{where}: label '{t['text']}' overflows its box (needs ~{bb[2] - r[0]:.0f}px, "
                                   f"box is {r[2] - r[0]:.0f}px wide).")
    for t in texts:
        if t["font"][0] < 11:
            rep.warn(coll.line, f"{where}: label '{t['text']}' uses {t['font'][0]:.0f}px text - hard to read.")


# ----------------------------------------------------------------------------- main parser
class Checker(HTMLParser):
    def __init__(self, rep, css_nowrap, css_wrap):
        super().__init__(convert_charrefs=True)
        self.rep = rep
        self.stack = []            # (tag, classes, line)
        self.ids, self.anchors = set(), []
        self.title = self.viewport = self.charset = False
        self.headings = []
        self.svg = None
        self.css_nowrap = css_nowrap
        self.css_wrap = css_wrap
        self.cell = None           # [line, classes, text, is_first]
        self.row_cells = 0
        self.section_text = []     # stack of [line, text_len]
        self.pre_depth = 0
        self.code_buf = None

    # -- helpers
    def classes_in_stack(self):
        out = set()
        for _, cls, _ in self.stack:
            out |= cls
        return out

    def tags_in_stack(self):
        return {t for t, _, _ in self.stack}

    def handle_starttag(self, tag, attrs_list):
        attrs = dict(attrs_list)
        line = self.getpos()[0]
        cls = set((attrs.get("class") or "").split())
        if attrs.get("id"):
            if attrs["id"] in self.ids:
                self.rep.err(line, f"Duplicate id '{attrs['id']}'.")
            self.ids.add(attrs["id"])
        if tag == "a" and (attrs.get("href") or "").startswith("#") and len(attrs["href"]) > 1:
            self.anchors.append((line, attrs["href"][1:]))
        if tag == "meta":
            if "charset" in attrs:
                self.charset = True
            if attrs.get("name") == "viewport":
                self.viewport = True
        if tag in ("script", "img", "iframe", "source") and re.match(r"https?://", attrs.get("src") or ""):
            self.rep.err(line, f"External resource <{tag} src={attrs['src']}> - reports must be self-contained.")
        if tag == "link" and re.match(r"https?://", attrs.get("href") or ""):
            self.rep.err(line, f"External stylesheet/font {attrs['href']} - inline it or use system fonts.")
        st = attrs.get("style") or ""
        if re.search(r"(?<![-\w])(color|background(-color)?)\s*:\s*(#[0-9a-fA-F]{3,6}|rgb)", st) and not self.svg:
            self.rep.warn(line, "Hard-coded colour in inline style - use a CSS token (var(--...)) so dark mode works.")
        if re.fullmatch(r"h[1-6]", tag):
            self.headings.append((line, int(tag[1])))
        if tag == "table" and "table-wrap" not in self.classes_in_stack():
            self.rep.err(line, "<table> is not inside a .table-wrap (overflow-x:auto) container - it can overflow on narrow screens.")
        if tag == "tr":
            self.row_cells = 0
        if tag in ("td", "th"):
            self.row_cells += 1
            self.cell = [line, cls, "", self.row_cells == 1, tag]
        if tag == "section":
            self.section_text.append([line, 0])
        if tag == "pre":
            self.pre_depth += 1
        if tag == "code" and not self.pre_depth:
            self.code_buf = ""
        # SVG
        if tag == "svg":
            self.svg = SvgCollector(line)
            vb = attrs.get("viewbox") or attrs.get("viewBox")
            if vb:
                try:
                    self.svg.viewbox = tuple(float(v) for v in re.split(r"[ ,]+", vb.strip()))
                except ValueError:
                    pass
            else:
                self.rep.warn(line, "SVG without viewBox - it will not scale responsively.")
            if not (attrs.get("role") == "img" and attrs.get("aria-label")):
                self.rep.warn(line, "SVG diagram should have role=\"img\" and an aria-label.")
        elif self.svg:
            if tag == "defs":
                self.svg.in_defs += 1
            elif tag == "style":
                self.svg.in_style = True
            elif self.svg.in_defs:
                pass
            elif tag == "text":
                self.svg.cur_text = {"x": float(attrs.get("x", 0) or 0), "y": float(attrs.get("y", 0) or 0),
                                     "anchor": attrs.get("text-anchor", "start"),
                                     "font": svg_font(attrs, self.svg), "text": ""}
            elif tag == "rect":
                try:
                    x, y = float(attrs.get("x", 0)), float(attrs.get("y", 0))
                    w, h = float(attrs["width"]), float(attrs["height"])
                    vb = self.svg.viewbox
                    if not (vb and w >= vb[2] * 0.95 and h >= vb[3] * 0.95):   # ignore background rects
                        self.svg.rects.append((x, y, x + w, y + h))
                except (KeyError, ValueError):
                    pass
            elif tag == "line":
                try:
                    self.svg.segs.append(((float(attrs["x1"]), float(attrs["y1"])),
                                          (float(attrs["x2"]), float(attrs["y2"]))))
                except (KeyError, ValueError):
                    pass
            elif tag == "path" and attrs.get("d"):
                self.svg.segs.extend(path_to_segments(attrs["d"]))
            elif tag in ("polyline", "polygon") and attrs.get("points"):
                nums = [float(n) for n in re.findall(r"-?\d*\.?\d+", attrs["points"])]
                pts = list(zip(nums[::2], nums[1::2]))
                self.svg.segs.extend(zip(pts, pts[1:]))
        if tag not in VOID and not (self.svg and tag in SVG_SELF and self.get_starttag_text().rstrip().endswith("/>")):
            self.stack.append((tag, cls, line))

    def handle_startendtag(self, tag, attrs):
        # self-closing: process attributes but never push on the stack
        self.handle_starttag(tag, attrs)
        if self.stack and self.stack[-1][0] == tag and tag not in VOID:
            self.stack.pop()

    def handle_endtag(self, tag):
        line = self.getpos()[0]
        if tag in VOID:
            return
        if self.svg:
            if tag == "text" and self.svg.cur_text is not None:
                self.svg.texts.append(self.svg.cur_text)
                self.svg.cur_text = None
            elif tag == "style":
                self.svg.in_style = False
                for m in re.finditer(r"\.([\w-]+)\s*\{([^}]*)\}", self.svg.style_buf):
                    size = re.search(r"([\d.]+)px", m.group(2))
                    if size:
                        self.svg.class_font[m.group(1)] = (float(size.group(1)), "mono" in m.group(2) or "Menlo" in m.group(2))
            elif tag == "defs":
                self.svg.in_defs -= 1
            elif tag == "svg":
                analyse_svg(self.svg, self.rep)
                self.svg = None
        if tag in ("td", "th") and self.cell:
            cline, ccls, text, first, ctag = self.cell
            nowrap = (ccls & self.css_nowrap) or (first and "__td:first-child" in self.css_nowrap) \
                or (ctag == "td" and "__td" in self.css_nowrap)
            if nowrap and len(text.strip()) > NOWRAP_CELL_TEXT:
                self.rep.err(cline, f"Cell with white-space:nowrap holds {len(text.strip())} chars "
                                     f"('{text.strip()[:40]}...') - it squeezes the other columns. "
                                     "Apply nowrap to the <code> inside, not to the whole cell.")
            self.cell = None
        if tag == "section" and self.section_text:
            sline, n = self.section_text.pop()
            if n < 20:
                self.rep.warn(sline, "Section has almost no text content.")
        if tag == "pre":
            self.pre_depth -= 1
        if tag == "code" and self.code_buf is not None:
            for tok in re.split(r"[\s,/]+", self.code_buf):
                if len(tok) > LONG_TOKEN and not self.css_wrap and not ({"td", "th"} & self.tags_in_stack()):
                    self.rep.err(line, f"Long unbreakable token '{tok}' outside a table and no "
                                        "overflow-wrap rule for code in CSS - it will overflow narrow cards. Add "
                                        "'p code, li code {overflow-wrap:anywhere}' (template has it).")
            self.code_buf = None
        # pop the matching element
        for idx in range(len(self.stack) - 1, -1, -1):
            if self.stack[idx][0] == tag:
                for unclosed in self.stack[idx + 1:]:
                    if unclosed[0] not in ("p", "li", "td", "th", "tr", "thead", "tbody", "dt", "dd", "option"):
                        self.rep.err(unclosed[2], f"<{unclosed[0]}> opened here is not closed before </{tag}> (line {line}).")
                del self.stack[idx:]
                return
        self.rep.err(line, f"Stray closing tag </{tag}> with no matching open tag.")

    def handle_data(self, data):
        if self.stack and self.stack[-1][0] == "title" and data.strip():
            self.title = True
        if self.svg:
            if self.svg.in_style:
                self.svg.style_buf += data
            elif self.svg.cur_text is not None:
                self.svg.cur_text["text"] += data
        if self.cell is not None:
            self.cell[2] += data
        if self.section_text:
            self.section_text[-1][1] += len(data.strip())
        if self.code_buf is not None:
            self.code_buf += data


def check_file(path):
    rep = Report()
    src = open(path, encoding="utf-8").read()
    css = "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", src, flags=re.S | re.I))

    # unescaped "<" in text (e.g. SOQL "CloseDate < TODAY" or "<5 days")
    body_no_style = re.sub(r"<(style|script)[^>]*>.*?</\1>", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S | re.I)
    body_no_comments = re.sub(r"<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), body_no_style, flags=re.S)
    for m in re.finditer(r"<(?!/?([a-zA-Z][\w:-]*)[\s>/])(?!!)", body_no_comments):
        line = body_no_comments.count("\n", 0, m.start()) + 1
        snippet = body_no_comments[m.start():m.start() + 25].split("\n")[0]
        rep.err(line, f"Unescaped '<' in text: '{snippet}' - write &lt; (common in SOQL comparisons).")
    for m in re.finditer(r"</?([a-zA-Z][\w:-]*)[\s>/]", body_no_comments):
        if m.group(1).lower() not in KNOWN_TAGS:
            line = body_no_comments.count("\n", 0, m.start()) + 1
            rep.err(line, f"Unknown tag <{m.group(1)}> - probably text that should be escaped (&lt;{m.group(1)}...).")

    if not re.search(r"<!doctype html>", src, re.I):
        rep.warn(1, "Missing <!doctype html> - browsers may switch to quirks mode.")
    if css:
        check_theme_contrast(css, rep)
        if "max-width" not in css:
            rep.warn(0, "No max-width in CSS - lines of text will be too long on wide screens.")
    else:
        rep.err(0, "No <style> block - the page will render with browser defaults.")

    p = Checker(rep, nowrap_td_classes(css), has_wrap_rule(css))
    p.feed(src)
    p.close()
    for tag, _, line in p.stack:
        if tag not in ("html", "body", "head", "p", "li"):
            rep.err(line, f"<{tag}> is never closed.")
    if not p.title:
        rep.err(1, "Missing or empty <title>.")
    if not p.charset:
        rep.err(1, "Missing <meta charset=\"utf-8\"> - accents (á, ñ) may render as garbage.")
    if not p.viewport:
        rep.err(1, "Missing <meta name=\"viewport\"> - page will be tiny in narrow panes.")
    for line, target in p.anchors:
        if target not in p.ids:
            rep.err(line, f"Link to #{target} but no element has id=\"{target}\".")
    h1 = [l for l, lv in p.headings if lv == 1]
    if len(h1) != 1:
        rep.warn(h1[1] if len(h1) > 1 else 1, f"Expected exactly one <h1>, found {len(h1)}.")
    prev = 0
    for line, lv in p.headings:
        if prev and lv > prev + 1:
            rep.warn(line, f"Heading jumps from h{prev} to h{lv}.")
        prev = lv
    return rep


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    failed = False
    for path in argv[1:]:
        rep = check_file(path)
        print(f"\n== {path}")
        for line, msg in sorted(rep.errors):
            print(f"  ERROR   line {line:>4}: {msg}")
        for line, msg in sorted(rep.warnings):
            print(f"  warning line {line:>4}: {msg}")
        status = "FAIL" if rep.errors else "PASS"
        print(f"  -> {status}: {len(rep.errors)} error(s), {len(rep.warnings)} warning(s)")
        failed |= bool(rep.errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
