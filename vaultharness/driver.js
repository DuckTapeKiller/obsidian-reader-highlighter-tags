// Drives the real plugin against a rendered note: the actual
// buildSelectionRequest, the actual locateSelection, the actual write through
// applyMarkdownModification. Nothing in the selection pipeline is
// reimplemented, so a result says something about the plugin, not the harness.

import ReadingHighlighterPlugin from "../src/main";
import { SelectionLogic } from "../src/core/SelectionLogic";
import { TFile } from "../tests/obsidian-stub.js";
import { createObsidianWindow } from "../tests/dom-helpers.js";
import { bodyStartOf, splitBlocks, renderInline, isUnsupported } from "./render.js";

let sharedWindow = null;
function getWindow() {
    if (!sharedWindow) sharedWindow = createObsidianWindow();
    return sharedWindow;
}

function buildInto(doc, el, spec, chars) {
    const build = (nodes, parent) => {
        for (const node of nodes) {
            if (node.t === "text") {
                const textNode = doc.createTextNode(node.chars.map((c) => c.ch).join(""));
                parent.appendChild(textNode);
                node.chars.forEach((c, idx) => chars.push({ ch: c.ch, off: c.off, node: textNode, nodeOffset: idx }));
                continue;
            }
            if (node.t === "br") {
                parent.appendChild(doc.createElement("br"));
                chars.push({ ch: "\n", off: null, node: null, nodeOffset: 0 });
                continue;
            }
            if (node.t === "opaque") {
                const opaque = doc.createElement(node.tag);
                if (node.text) {
                    const textNode = doc.createTextNode(node.text);
                    opaque.appendChild(textNode);
                    [...node.text].forEach((ch, idx) => chars.push({ ch, off: null, node: textNode, nodeOffset: idx }));
                }
                parent.appendChild(opaque);
                continue;
            }
            const child = doc.createElement(node.tag);
            parent.appendChild(child);
            build(node.children, child);
        }
    };

    build(spec, el);
}

function appendBlock(doc, container, tag, spec) {
    const el = doc.createElement(tag);
    const chars = [];
    buildInto(doc, el, spec, chars);
    container.appendChild(el);
    return { el, chars };
}

/**
 * Build a real <table> for a table block and register every cell as its own
 * selectable entry. Reading view renders each cell as a <td>/<th>, and those
 * are the elements the plugin treats as selection blocks.
 */
function appendTable(doc, container, raw, block, rendered) {
    const table = doc.createElement("table");
    const thead = doc.createElement("thead");
    const tbody = doc.createElement("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    container.appendChild(table);

    const info = { el: table, rows: [], cells: [] };
    let bodyRow = 0;

    block.rows.forEach((row, rowIndex) => {
        if (row.delimiter) return;
        const isHeader = rowIndex === 0;
        const tr = doc.createElement("tr");
        (isHeader ? thead : tbody).appendChild(tr);
        const rowInfo = { el: tr, isHeader, index: isHeader ? 0 : bodyRow++, cells: [] };

        row.cells.forEach((cell, colIndex) => {
            const source = raw.substring(cell.start, cell.end);
            const td = doc.createElement(isHeader ? "th" : "td");
            tr.appendChild(td);

            const chars = [];
            const spec = renderInline(source, cell.start);
            buildInto(doc, td, spec, chars);
            const norm = normalizeChars(chars);
            const entry = {
                block,
                el: td,
                chars,
                norm,
                text: textOf(norm),
                unsupported: isUnsupported(source),
                source,
                cell,
                rowIndex,
                colIndex,
                isHeader,
                table: info,
            };
            rendered.push(entry);
            rowInfo.cells.push(entry);
            info.cells.push(entry);
        });
        info.rows.push(rowInfo);
    });

    return info;
}

/** Collapse whitespace the way the plugin's context text does. */
export function normalizeChars(chars) {
    const out = [];
    let gap = false;
    for (const c of chars) {
        if (/\s/.test(c.ch)) {
            gap = true;
            continue;
        }
        if (gap && out.length > 0) out.push({ ch: " ", off: null, node: null, nodeOffset: 0 });
        gap = false;
        out.push(c);
    }
    return out;
}

export const textOf = (chars) => chars.map((c) => c.ch).join("");

export async function buildNote(raw, path = "note.md") {
    const window = getWindow();
    const doc = window.document;
    doc.body.innerHTML = "<div id='content'></div>";
    const container = doc.getElementById("content");

    const rendered = [];
    const tables = [];
    for (const block of splitBlocks(raw, bodyStartOf(raw))) {
        if (block.tag === "table") {
            tables.push(appendTable(doc, container, raw, block, rendered));
            continue;
        }
        const source = raw.substring(block.contentStart, block.contentEnd);
        if (!source.trim()) continue;
        const { el, chars } = appendBlock(doc, container, block.tag, renderInline(source, block.contentStart));
        const norm = normalizeChars(chars);
        rendered.push({ block, el, chars, norm, text: textOf(norm), unsupported: isUnsupported(source), source });
    }

    const file = new TFile(path);
    let current = raw;
    const view = {
        file,
        contentEl: container,
        containerEl: container,
        getMode: () => "preview",
        getViewType: () => "markdown",
    };
    const app = {
        vault: {
            read: async () => current,
            modify: async (_f, c) => {
                current = c;
            },
            process: async (_f, fn) => {
                current = fn(current);
                return current;
            },
            getAbstractFileByPath: () => null,
        },
        metadataCache: { getFileCache: () => ({ embeds: [] }) },
        fileManager: { processFrontMatter: async () => {} },
        workspace: { getActiveViewOfType: () => view, on: () => {}, off: () => {} },
    };

    const plugin = new ReadingHighlighterPlugin(app, { id: "test", version: "0.0.0" });
    await plugin.loadSettings();
    plugin.settings.enableSmartParagraphSelection = false;
    plugin.settings.enableColorHighlighting = false;
    plugin.settings.enableFrontmatterTag = false;
    plugin.settings.enableHaptics = false;
    plugin.settings.defaultTagPrefix = "";
    plugin.settings.learnedNormRules = [];
    plugin.logic = new SelectionLogic(app, () => []);
    plugin.handleSelectionFailure = () => {
        plugin._failed = true;
    };

    return {
        window,
        doc,
        container,
        plugin,
        view,
        file,
        rendered,
        raw,
        tables,
        getCurrent: () => current,
        reset: () => {
            current = raw;
        },
    };
}

export function occurrencePositions(text, term) {
    const out = [];
    let from = 0;
    for (;;) {
        const at = text.indexOf(term, from);
        if (at === -1) break;
        out.push(at);
        from = at + term.length;
    }
    return out;
}

export function rangeForSlice(doc, norm, from, to) {
    const start = norm[from];
    if (!start || !start.node) return null;
    let endIdx = to - 1;
    while (endIdx > from && (!norm[endIdx].node || norm[endIdx].off === null)) endIdx--;
    const end = norm[endIdx];
    if (!end || !end.node) return null;
    const range = doc.createRange();
    range.setStart(start.node, start.nodeOffset);
    range.setEnd(end.node, end.nodeOffset + 1);
    return range;
}

/**
 * Did the plugin highlight the occurrence the user selected?
 *
 * Marker counting cannot answer this on real notes: paragraphs are often
 * already highlighted, so new markers nest inside old ones. Diffing cannot
 * either — highlighting the first word of `==Erasmus and…==` yields
 * `==Erasmus== and…`, whose first differing character sits after the word.
 * Ask locally instead: find the occurrence in the written text, then look
 * outward for a `==` on each side, allowing only what auto-expansion may absorb.
 */
const EXPANSION_SLACK = 40;

export function analyzeHighlight(raw, output, expectedStart, expectedEnd, term) {
    const text = raw.substring(expectedStart, expectedEnd);
    const delta = output.length - raw.length;

    let at = -1;
    for (let shift = 0; shift <= Math.abs(delta) + 4 && at === -1; shift++) {
        for (const cand of [expectedStart + shift, expectedStart - shift]) {
            if (cand >= 0 && output.startsWith(text, cand)) {
                at = cand;
                break;
            }
        }
    }
    if (at === -1) return { ok: false, reason: "occurrence-missing-from-output" };

    const before = output.lastIndexOf("==", at);
    if (before === -1) return { ok: false, reason: "no-opening-marker" };
    const leading = output.substring(before + 2, at);
    if (leading.length > EXPANSION_SLACK) return { ok: false, reason: "not-highlighted" };

    const after = output.indexOf("==", at + text.length);
    if (after === -1) return { ok: false, reason: "no-closing-marker" };
    const trailing = output.substring(at + text.length, after);
    if (trailing.length > EXPANSION_SLACK) return { ok: false, reason: "not-highlighted" };

    const inner = leading + text + trailing;
    if (occurrencePositions(inner, term).length > 1) {
        return { ok: false, reason: "covers-multiple-occurrences", inner: inner.slice(0, 60) };
    }
    return { ok: true, inner };
}

/**
 * Is `[start, end)` already inside a highlight in `raw`? Highlighting a span
 * that is already highlighted has nothing to do, so the plugin writing nothing
 * is the correct outcome rather than a failure.
 */
export function alreadyHighlighted(raw, start, end) {
    const spans = [];
    for (const re of [/==([\s\S]*?)==/g, /<mark\b[^>]*>([\s\S]*?)<\/mark>/gi]) {
        let m;
        while ((m = re.exec(raw)) !== null) spans.push([m.index, m.index + m[0].length]);
    }
    return spans.some(([s, e]) => s <= start && end <= e);
}

/** Select the `ordinal`-th occurrence of `term` in a block and highlight it. */
export async function selectAndHighlight(note, blockIndex, term, ordinal) {
    const entry = note.rendered[blockIndex];
    if (!entry) return { skipped: "no-block" };

    const positions = occurrencePositions(entry.text, term);
    const at = positions[ordinal];
    if (at === undefined) return { skipped: "no-occurrence" };

    const slice = entry.norm.slice(at, at + term.length);
    if (slice.length !== term.length || slice.some((c) => c.off === null)) return { skipped: "spans-unmapped" };

    const range = rangeForSlice(note.doc, entry.norm, at, at + term.length);
    if (!range) return { skipped: "no-range" };

    const selection = note.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    note.plugin._failed = false;
    await note.plugin.highlightSelection(note.view, { text: range.toString(), range });

    const output = note.getCurrent();
    return {
        selectionText: range.toString(),
        expectedStart: slice[0].off,
        expectedEnd: slice[slice.length - 1].off + 1,
        output,
        changed: output !== note.raw,
        failed: note.plugin._failed,
        occurrences: positions.length,
        blockEntry: entry,
    };
}

/** Select every rendered block in the note at once — "highlight the article". */
export async function selectWholeNote(note) {
    const blocks = note.rendered.filter((b) => b.norm.length > 0);
    if (blocks.length < 2) return { skipped: "too-few-blocks" };
    const first = blocks[0];
    const last = blocks[blocks.length - 1];

    const startChar = first.norm.find((c) => c.node);
    const endIdx = (() => {
        for (let i = last.norm.length - 1; i >= 0; i--) if (last.norm[i].node) return i;
        return -1;
    })();
    if (!startChar || endIdx === -1) return { skipped: "no-anchors" };
    const endChar = last.norm[endIdx];

    const range = note.doc.createRange();
    range.setStart(startChar.node, startChar.nodeOffset);
    range.setEnd(endChar.node, endChar.nodeOffset + 1);

    const selection = note.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    // jsdom performs no layout, so `Range.toString()` runs the blocks together.
    // A real browser separates block elements with newlines, and the matcher's
    // multi-block strategy depends on seeing them — without this the whole
    // article arrives as one enormous single-line snippet.
    const text = blocks.map((b) => b.el.innerText.replace(/\s+$/, "")).join("\n\n");

    note.plugin._failed = false;
    await note.plugin.highlightSelection(note.view, { text, range });

    return {
        output: note.getCurrent(),
        changed: note.getCurrent() !== note.raw,
        failed: note.plugin._failed,
        snippet: text,
    };
}
