// Split Markdown source into the ranges that Reading view turns into single
// block elements (<p>, <li>, <h2>, <pre>, …). The matcher needs this to tell
// "the same word later in *this* paragraph" apart from "the same word in a
// different paragraph": the first is disambiguated by the caret's occurrence
// ordinal, the second by which block the user's context text belongs to.
//
// The important case is a paragraph containing soft line breaks (Shift+Enter).
// Those lines are separated by a single newline in the source but render as one
// <p> with <br> elements, so they must stay in one block here.

/** Which kind of element Reading view renders this block as. */
export type BlockKind = "heading" | "list" | "table" | "code" | "footnote" | "paragraph";

export interface SourceBlock {
    start: number;
    end: number;
    kind: BlockKind;
}

/** Map a rendered element's tag onto the block kind it came from. */
export function kindForTag(tag: string | null | undefined): BlockKind | null {
    if (!tag) return null;
    const upper = tag.toUpperCase();
    if (/^H[1-6]$/.test(upper)) return "heading";
    if (upper === "LI") return "list";
    if (upper === "TD" || upper === "TH") return "table";
    if (upper === "PRE") return "code";
    if (upper === "P" || upper === "BLOCKQUOTE") return "paragraph";
    return null;
}

const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;
const FOOTNOTE_DEF_RE = /^\s{0,3}\[\^[^\]]+\]:/;
const TABLE_ROW_RE = /^\s*\|/;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const THEMATIC_BREAK_RE = /^\s{0,3}(?:\*\s*\*\s*\*|-\s*-\s*-|_\s*_\s*_)[\s*\-_]*$/;

/**
 * Cell ranges within a table row, split on unescaped pipes. `\|` is content —
 * an escaped pipe inside a wiki link or code span — not a column boundary.
 */
function tableCellRanges(line: string, lineStart: number): SourceBlock[] {
    const cells: SourceBlock[] = [];
    let cursor = 0;
    const push = (from: number, to: number): void => {
        let start = from;
        let end = to;
        while (start < end && /\s/.test(line[start])) start++;
        while (end > start && /\s/.test(line[end - 1])) end--;
        if (end > start) cells.push({ start: lineStart + start, end: lineStart + end, kind: "table" });
    };
    for (let i = 0; i < line.length; i++) {
        if (line[i] === "\\") {
            i++;
            continue;
        }
        if (line[i] === "|") {
            push(cursor, i);
            cursor = i + 1;
        }
    }
    push(cursor, line.length);
    return cells;
}

const TABLE_DELIMITER_RE = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

/** The kind a line starts, or null when it continues the current block. */
function ownBlockKind(line: string): BlockKind | null {
    if (HEADING_RE.test(line)) return "heading";
    if (LIST_ITEM_RE.test(line)) return "list";
    if (FOOTNOTE_DEF_RE.test(line)) return "footnote";
    if (TABLE_ROW_RE.test(line)) return "table";
    if (THEMATIC_BREAK_RE.test(line)) return "paragraph";
    return null;
}

/**
 * Return the block ranges of `text`, as offsets shifted by `offset` so they line
 * up with candidate positions taken from the full file.
 *
 * Ranges cover only the block's own text; the blank lines between blocks are not
 * part of any range, so a candidate can sit in at most one block.
 */
export function splitSourceBlocks(text: string, offset = 0): SourceBlock[] {
    const blocks: SourceBlock[] = [];
    if (!text) return blocks;

    let lineStart = 0;
    let blockStart = -1;
    let blockEnd = -1;
    let blockKind: BlockKind = "paragraph";
    let inFence = false;

    const flush = (): void => {
        if (blockStart !== -1 && blockEnd > blockStart) {
            blocks.push({ start: blockStart + offset, end: blockEnd + offset, kind: blockKind });
        }
        blockStart = -1;
        blockEnd = -1;
    };

    while (lineStart <= text.length) {
        const newlineAt = text.indexOf("\n", lineStart);
        const lineEnd = newlineAt === -1 ? text.length : newlineAt;
        const rawLine = text.substring(lineStart, lineEnd);
        const line = rawLine.replace(/\r$/, "");
        const contentEnd = lineStart + line.length;

        if (inFence) {
            blockEnd = contentEnd;
            if (FENCE_RE.test(line)) {
                inFence = false;
                flush();
            }
        } else if (FENCE_RE.test(line)) {
            // A fenced code block renders as a single <pre>, however many lines.
            flush();
            inFence = true;
            blockStart = lineStart;
            blockEnd = contentEnd;
            blockKind = "code";
        } else if (!line.trim()) {
            // Blank line: hard block boundary.
            flush();
        } else if (TABLE_ROW_RE.test(line)) {
            // Reading view renders every table cell as its own <td>/<th>, and
            // those are the elements a selection is anchored to. Treating the
            // whole row as one block would compare a one-word cell against the
            // entire row, so each cell becomes its own block. The delimiter row
            // renders as nothing at all.
            flush();
            if (!TABLE_DELIMITER_RE.test(line)) {
                for (const cell of tableCellRanges(line, lineStart)) {
                    blocks.push({ start: cell.start + offset, end: cell.end + offset, kind: "table" });
                }
            }
        } else if (ownBlockKind(line)) {
            flush();
            blockStart = lineStart;
            blockEnd = contentEnd;
            blockKind = ownBlockKind(line) ?? "paragraph";
        } else if (blockStart === -1) {
            blockStart = lineStart;
            blockEnd = contentEnd;
            blockKind = "paragraph";
        } else {
            // Soft line break inside the current block — same rendered element.
            blockEnd = contentEnd;
        }

        if (newlineAt === -1) break;
        lineStart = newlineAt + 1;
    }
    flush();

    return blocks;
}

/** The block containing `position`, or null if it falls between blocks. */
export function findBlockAt(blocks: SourceBlock[], position: number): SourceBlock | null {
    for (const block of blocks) {
        if (position >= block.start && position < block.end) return block;
    }
    return null;
}
