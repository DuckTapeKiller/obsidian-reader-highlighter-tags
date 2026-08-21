// A Reading-view-shaped renderer used only by the vault sweeps. It turns note
// source into the block structure Obsidian would render, so a selection can be
// made across a whole article the way a user would.
//
// Constructs it cannot model faithfully (raw HTML, tables, code fences, math,
// comments) mark the block unsupported so the sweep skips it rather than
// measuring against a wrong picture.

const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const HEADING_RE = /^(\s{0,3}#{1,6}[ \t]+)/;
const LIST_ITEM_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;
const FOOTNOTE_DEF_RE = /^\s{0,3}\[\^[^\]]+\]:/;
const TABLE_ROW_RE = /^\s*\|/;
const QUOTE_RE = /^\s{0,3}>/;
const THEMATIC_BREAK_RE = /^\s{0,3}(?:\*\s*\*\s*\*|-\s*-\s*-|_\s*_\s*_)[\s*\-_]*$/;

const DELIMITER_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Split a table row on unescaped pipes, keeping each cell's source offsets. */
export function parseTableRow(raw, lineStart, line) {
    const cells = [];
    let i = 0;
    // Skip the leading pipe and any indent.
    while (i < line.length && /\s/.test(line[i])) i++;
    if (line[i] === "|") i++;

    let cellStart = i;
    const push = (end) => {
        let s = cellStart;
        let e = end;
        while (s < e && /\s/.test(line[s])) s++;
        while (e > s && /\s/.test(line[e - 1])) e--;
        cells.push({ start: lineStart + s, end: lineStart + e });
    };
    for (; i < line.length; i++) {
        if (line[i] === "\\") {
            i++;
            continue;
        }
        if (line[i] === "|") {
            push(i);
            cellStart = i + 1;
        }
    }
    // Trailing content after the last pipe, if the row has no closing pipe.
    if (cellStart < line.length && line.slice(cellStart).trim()) push(line.length);
    return cells;
}

/** True when `line` is a table row (not the delimiter). */
export function isTableRow(line) {
    return /^\s{0,3}\|/.test(line) && !DELIMITER_RE.test(line);
}

export function isDelimiterRow(line) {
    return line.includes("|") && DELIMITER_RE.test(line);
}

/** Offset of the body, after YAML frontmatter — the plugin's own rule. */
export function bodyStartOf(raw) {
    if (!raw.startsWith("---")) return 0;
    const second = raw.indexOf("---", 3);
    if (second === -1) return 0;
    let i = second + 3;
    while (i < raw.length && (raw[i] === "\n" || raw[i] === "\r")) i++;
    return i;
}

/**
 * Split the body into rendered blocks, recording where each block's *content*
 * starts so a list marker or heading hash is excluded from the rendered text
 * while remaining part of the source range.
 */
export function splitBlocks(raw, bodyStart) {
    const blocks = [];
    let i = bodyStart;
    let current = null;
    let inFence = false;

    const flush = () => {
        if (current && current.contentEnd > current.contentStart) blocks.push(current);
        current = null;
    };

    while (i <= raw.length) {
        const nl = raw.indexOf("\n", i);
        const lineEnd = nl === -1 ? raw.length : nl;
        const line = raw.substring(i, lineEnd).replace(/\r$/, "");
        const contentEnd = i + line.length;

        if (inFence) {
            if (FENCE_RE.test(line)) inFence = false;
        } else if (FENCE_RE.test(line)) {
            flush();
            inFence = true;
        } else if (!line.trim()) {
            flush();
        } else if (TABLE_ROW_RE.test(line) || THEMATIC_BREAK_RE.test(line)) {
            if (TABLE_ROW_RE.test(line)) {
                if (!current || current.tag !== "table") {
                    flush();
                    current = { tag: "table", start: i, contentStart: i, contentEnd, end: contentEnd, rows: [] };
                }
                current.contentEnd = contentEnd;
                current.end = contentEnd;
                current.rows.push({
                    start: i,
                    end: contentEnd,
                    delimiter: isDelimiterRow(line),
                    cells: isDelimiterRow(line) ? [] : parseTableRow(raw, i, line),
                });
            } else {
                flush();
            }
        } else if (QUOTE_RE.test(line)) {
            const marker = line.match(/^\s{0,3}>[ \t]?/)[0];
            if (current && current.tag === "blockquote") {
                current.contentEnd = contentEnd;
                current.end = contentEnd;
            } else {
                flush();
                current = {
                    tag: "blockquote",
                    start: i,
                    contentStart: i + marker.length,
                    contentEnd,
                    end: contentEnd,
                };
            }
        } else if (FOOTNOTE_DEF_RE.test(line)) {
            flush();
        } else if (HEADING_RE.test(line)) {
            flush();
            const marker = line.match(HEADING_RE)[1];
            const level = (marker.match(/#/g) || []).length;
            current = { tag: `h${level}`, start: i, contentStart: i + marker.length, contentEnd, end: contentEnd };
            flush();
        } else if (LIST_ITEM_RE.test(line)) {
            flush();
            const marker = line.match(LIST_ITEM_RE)[1];
            current = { tag: "li", start: i, contentStart: i + marker.length, contentEnd, end: contentEnd };
        } else if (current) {
            // Soft line break: same rendered block.
            current.contentEnd = contentEnd;
            current.end = contentEnd;
        } else {
            current = { tag: "p", start: i, contentStart: i, contentEnd, end: contentEnd };
        }

        if (nl === -1) break;
        i = nl + 1;
    }
    flush();
    return blocks;
}

// `\n>` catches continuation lines of a multi-line blockquote: Obsidian strips
// every `>` marker, this renderer only strips the first, so the ground truth
// would be wrong. Skip those blocks rather than measure them incorrectly.
const UNSUPPORTED_RE = /<(?!\/?mark\b)[a-zA-Z/!]|%%|\$|\\\(|\\\[|\n\s*>/i;

export function isUnsupported(source) {
    return UNSUPPORTED_RE.test(source);
}

const PAIRS = [
    ["**", "strong"],
    ["==", "mark"],
    ["~~", "del"],
    ["`", "code"],
];

const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/**
 * Render inline Markdown into a node spec tree. `base` is the source offset of
 * `src[0]`, so every emitted character carries its true source position.
 */
export function renderInline(src, base) {
    const out = [];
    let text = null;

    const pushChar = (ch, off) => {
        if (!text) {
            text = { t: "text", chars: [] };
            out.push(text);
        }
        text.chars.push({ ch, off });
    };
    const pushNode = (node) => {
        out.push(node);
        text = null;
    };

    let i = 0;
    while (i < src.length) {
        const rest = src.slice(i);
        const ch = src[i];

        if (ch === "\n") {
            pushNode({ t: "br" });
            i++;
            continue;
        }

        // A link wrapping an image — `[![alt](img)](href)` — renders as a
        // clickable image. Must be caught before the inline-link rule, which
        // would otherwise take `![alt` as the label and show the alt text.
        let m = rest.match(/^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/) || rest.match(/^\[!\[\[[^\]]*\]\]\]\([^)]*\)/);
        if (m) {
            pushNode({ t: "opaque", tag: "img", text: "" });
            i += m[0].length;
            continue;
        }

        // Images contribute no text. `![[file|alias]]` is an Obsidian embed: the
        // alias is a size/alt hint, not visible text.
        m = rest.match(/^!\[\[[^\]]*\]\]/) || rest.match(/^!\[[^\]]*\]\([^)]*\)/);
        if (m) {
            pushNode({ t: "opaque", tag: "img", text: "" });
            i += m[0].length;
            continue;
        }

        // `<mark …>` highlights render as a highlight; the tags are not text.
        m = rest.match(/^<mark\b[^>]*>/i);
        if (m) {
            const openLen = m[0].length;
            const close = src.toLowerCase().indexOf("</mark>", i + openLen);
            const innerEnd = close === -1 ? src.length : close;
            pushNode({
                t: "el",
                tag: "mark",
                children: renderInline(src.substring(i + openLen, innerEnd), base + i + openLen),
            });
            i = close === -1 ? src.length : close + "</mark>".length;
            continue;
        }
        // A stray closing tag (notes do contain unbalanced ones) shows nothing.
        m = rest.match(/^<\/mark>/i);
        if (m) {
            i += m[0].length;
            continue;
        }

        // Footnote references render as a superscript marker, not as their id.
        m = rest.match(/^\[\^[^\]]+\]/) || rest.match(/^\^\[[^\]]+\]/);
        if (m) {
            pushNode({ t: "opaque", tag: "sup", text: "1" });
            i += m[0].length;
            continue;
        }

        // Wiki link: only the alias (or target) is visible.
        m = rest.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
        if (m) {
            const shown = m[2] !== undefined ? m[2] : m[1];
            pushNode({ t: "el", tag: "a", children: renderInline(shown, base + i + m[0].indexOf(shown)) });
            i += m[0].length;
            continue;
        }

        // Inline link: only the label is visible.
        m = rest.match(/^\[([^\]]*)\]\(([^)]*)\)/);
        if (m) {
            pushNode({ t: "el", tag: "a", children: renderInline(m[1], base + i + 1) });
            i += m[0].length;
            continue;
        }

        let matchedPair = false;
        for (const [delim, tag] of PAIRS) {
            if (!rest.startsWith(delim)) continue;
            const close = src.indexOf(delim, i + delim.length);
            if (close === -1) continue;
            const inner = src.substring(i + delim.length, close);
            if (!inner || inner.includes("\n")) continue;
            pushNode({ t: "el", tag, children: renderInline(inner, base + i + delim.length) });
            i = close + delim.length;
            matchedPair = true;
            break;
        }
        if (matchedPair) continue;

        // Single-character emphasis, only at word boundaries so `snake_case`
        // and a bare `*` stay literal.
        if (ch === "*" || ch === "_") {
            const prev = i > 0 ? src[i - 1] : "";
            const next = src[i + 1] || "";
            if ((ch === "*" || !isWordChar(prev)) && next && !/\s/.test(next)) {
                const close = src.indexOf(ch, i + 1);
                const afterClose = close === -1 ? "" : src[close + 1] || "";
                const closeOk =
                    close !== -1 &&
                    !/\s/.test(src[close - 1] || "") &&
                    (ch === "*" || !isWordChar(afterClose)) &&
                    !src.substring(i + 1, close).includes("\n");
                if (closeOk) {
                    pushNode({ t: "el", tag: "em", children: renderInline(src.substring(i + 1, close), base + i + 1) });
                    i = close + 1;
                    continue;
                }
            }
        }

        pushChar(ch, base + i);
        i++;
    }

    return out;
}
