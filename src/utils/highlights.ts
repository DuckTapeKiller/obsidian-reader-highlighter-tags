import { colorAt, nearestHighlightColor, stripHighlightMarkers, wrapHighlight, type HighlightColor } from "./colors";

export type HighlightType = "markdown" | "html";
export type FootnotePlacement = "after" | "inside";

export interface Highlight {
    id: string;
    text: string;
    line: number;
    type: HighlightType;
    /**
     * The native colour, or null for the theme's default. An HTML highlight
     * left by an older version reports the native colour nearest its own.
     */
    color: HighlightColor | null;
    start: number;
    end: number;
    innerStart: number;
    innerEnd: number;
    openTagStart: number;
    openTagEnd: number;
    closeTagStart: number;
    closeTagEnd: number;
    openTag?: string;
    tagsText: string;
    tagsStart: number | null;
    tagsEnd: number | null;
    footnoteId: string | null;
    footnoteStart: number | null;
    footnoteEnd: number | null;
    footnotePlacement: FootnotePlacement | null;
    annotation: string;
}

export interface Footnote {
    id: string;
    text: string;
    line: number;
    start: number;
    end: number;
}

export interface ParsedHighlights {
    highlights: Highlight[];
    footnotes: Map<string, Footnote>;
}

interface StyleAttr {
    quote: string;
    value: string;
    index: number;
    length: number;
}

interface TagsRange {
    tagsText: string;
    tagsStart: number | null;
    tagsEnd: number | null;
}

interface FootnoteInfo {
    id: string;
    start: number;
    end: number;
    placement: FootnotePlacement;
}

interface Deletion {
    start: number;
    end: number;
}

function escapeRegex(text: string): string {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectNewline(raw: string): string {
    return raw.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Which lines sit inside a fenced code block, fences included. A fence opened
 * with backticks only closes on backticks, and at least as many of them.
 */
function fencedLines(lines: string[]): boolean[] {
    const result: boolean[] = [];
    let fence: string | null = null;
    for (const line of lines) {
        const marker = line.match(/^[ \t]{0,3}(?:>[ \t]?)*(`{3,}|~{3,})/)?.[1] ?? null;
        if (fence === null) {
            if (marker) fence = marker;
            result.push(fence !== null);
        } else {
            result.push(true);
            if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        }
    }
    return result;
}

function extractStyleAttribute(openTag: string): StyleAttr | null {
    const styleMatch = openTag.match(/\sstyle=(["'])([\s\S]*?)\1/i);
    if (!styleMatch) return null;
    return {
        quote: styleMatch[1],
        value: styleMatch[2],
        index: styleMatch.index ?? -1,
        length: styleMatch[0].length,
    };
}

function extractBackgroundFromStyle(styleValue: string | null | undefined): string | null {
    if (!styleValue) return null;
    const parts = styleValue
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
    for (const part of parts) {
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        const key = part.slice(0, colon).trim().toLowerCase();
        const value = part.slice(colon + 1).trim();
        if (key === "background" || key === "background-color") {
            return value || null;
        }
    }
    return null;
}

function normalizeTagsText(tagsText: string): string {
    const tokens = String(tagsText || "")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
    const cleaned = tokens
        .map((token) => token.replace(/^#/, ""))
        .filter(Boolean)
        .map((token) => `#${token}`);
    return cleaned.join(" ");
}

export function parseFootnotes(raw: string): Map<string, Footnote> {
    const newline = detectNewline(raw);
    const lines = raw.split(/\r?\n/);
    const results = new Map<string, Footnote>();
    let offset = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
        if (match) {
            results.set(match[1], {
                id: match[1],
                text: match[2] ?? "",
                line: lineIdx,
                start: offset,
                end: offset + line.length,
            });
        }
        offset += line.length + (lineIdx < lines.length - 1 ? newline.length : 0);
    }

    return results;
}

export function parseHighlights(raw: string): ParsedHighlights {
    const newline = detectNewline(raw);
    const footnotes = parseFootnotes(raw);
    const highlights: Highlight[] = [];

    const lines = raw.split(/\r?\n/);
    let lineOffset = 0;

    const inFence = fencedLines(lines);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];

        // `==` inside a code block is code (`a == b`), not a highlight.
        if (inFence[lineIdx]) {
            lineOffset += line.length + (lineIdx < lines.length - 1 ? newline.length : 0);
            continue;
        }

        const markdownPattern = /==(.*?)==/g;
        const htmlPattern = /<mark\b[^>]*>(.*?)<\/mark>/gi;

        let match: RegExpExecArray | null;
        while ((match = markdownPattern.exec(line)) !== null) {
            const start = lineOffset + match.index;
            const end = start + match[0].length;
            // A colour emoji straight after the opening marker belongs to the
            // marker: Obsidian reads it as the colour and never shows it.
            const colour = colorAt(match[1] ?? "");
            const innerText = (match[1] ?? "").slice(colour.length);
            const innerStart = start + 2 + colour.length;
            const innerEnd = end - 2;

            const { tagsText, tagsStart, tagsEnd } = extractLeadingTagsRange(line, lineOffset, match.index);
            const footnote = detectFootnoteForHighlight({
                line,
                lineOffset,
                wrapperEndInLine: match.index + match[0].length,
                innerText,
                innerStart,
            });

            highlights.push({
                id: "",
                text: innerText.trim(),
                line: lineIdx,
                type: "markdown",
                color: colour.color,
                start,
                end,
                innerStart,
                innerEnd,
                openTagStart: start,
                openTagEnd: innerStart,
                closeTagStart: innerEnd,
                closeTagEnd: end,
                tagsText,
                tagsStart,
                tagsEnd,
                footnoteId: footnote?.id ?? null,
                footnoteStart: footnote?.start ?? null,
                footnoteEnd: footnote?.end ?? null,
                footnotePlacement: footnote?.placement ?? null,
                annotation: footnote?.id ? (footnotes.get(footnote.id)?.text ?? "") : "",
            });
        }

        while ((match = htmlPattern.exec(line)) !== null) {
            const start = lineOffset + match.index;
            const end = start + match[0].length;

            const full = match[0];
            const openTagMatch = full.match(/^<mark\b[^>]*>/i);
            const openTag = openTagMatch ? openTagMatch[0] : "<mark>";
            const openTagEndInMatch = openTag.length;
            const closeTagLength = "</mark>".length;

            const openTagStart = start;
            const openTagEnd = start + openTagEndInMatch;
            const innerStart = openTagEnd;
            const innerEnd = end - closeTagLength;

            const styleAttr = extractStyleAttribute(openTag);
            const color = nearestHighlightColor(styleAttr ? extractBackgroundFromStyle(styleAttr.value) : null);

            const { tagsText, tagsStart, tagsEnd } = extractLeadingTagsRange(line, lineOffset, match.index);
            const footnote = detectFootnoteForHighlight({
                line,
                lineOffset,
                wrapperEndInLine: match.index + match[0].length,
                innerText: match[1],
                innerStart,
            });

            highlights.push({
                id: "",
                text: (match[1] ?? "").trim(),
                line: lineIdx,
                type: "html",
                color,
                start,
                end,
                innerStart,
                innerEnd,
                openTagStart,
                openTagEnd,
                closeTagStart: innerEnd,
                closeTagEnd: end,
                openTag,
                tagsText,
                tagsStart,
                tagsEnd,
                footnoteId: footnote?.id ?? null,
                footnoteStart: footnote?.start ?? null,
                footnoteEnd: footnote?.end ?? null,
                footnotePlacement: footnote?.placement ?? null,
                annotation: footnote?.id ? (footnotes.get(footnote.id)?.text ?? "") : "",
            });
        }

        lineOffset += line.length + (lineIdx < lines.length - 1 ? newline.length : 0);
    }

    highlights.sort((a, b) => a.start - b.start);
    // Ids count by position within the line, not by syntax, so converting an
    // HTML highlight to a native one leaves every id on the line unchanged.
    const perLine = new Map<number, number>();
    for (const highlight of highlights) {
        const n = perLine.get(highlight.line) ?? 0;
        highlight.id = `${highlight.line}:${n}`;
        perLine.set(highlight.line, n + 1);
    }
    return { highlights, footnotes };
}

function extractLeadingTagsRange(line: string, lineOffset: number, wrapperStartInLine: number): TagsRange {
    if (wrapperStartInLine <= 0) return { tagsText: "", tagsStart: null, tagsEnd: null };
    const before = line.slice(0, wrapperStartInLine);

    const tagsRegex = /(?:^|\s)(#[^\s#]+(?:\s+#[^\s#]+)*)\s*$/u;
    const match = tagsRegex.exec(before);
    if (!match) return { tagsText: "", tagsStart: null, tagsEnd: null };

    const fullMatch = match[0];
    const group = match[1];
    if (!group) return { tagsText: "", tagsStart: null, tagsEnd: null };

    const groupOffsetInFull = fullMatch.lastIndexOf(group);
    if (groupOffsetInFull < 0) return { tagsText: "", tagsStart: null, tagsEnd: null };

    const groupStartInBefore = (match.index ?? 0) + groupOffsetInFull;
    const groupEndInBefore = groupStartInBefore + group.length;

    const trailingWhitespace = before.slice(groupEndInBefore);
    const endsWithSpace = /\s/.test(trailingWhitespace.slice(-1) || "");
    const tagsEndInLine = endsWithSpace ? before.length : groupEndInBefore;

    return {
        tagsText: group.trim(),
        tagsStart: lineOffset + groupStartInBefore,
        tagsEnd: lineOffset + tagsEndInLine,
    };
}

function detectFootnoteForHighlight({
    line,
    lineOffset,
    wrapperEndInLine,
    innerText,
    innerStart,
}: {
    line: string;
    lineOffset: number;
    wrapperEndInLine: number;
    innerText: string;
    innerStart: number;
}): FootnoteInfo | null {
    const after = line.slice(wrapperEndInLine);
    const afterMatch = after.match(/^\[\^([^\]]+)\]/);
    if (afterMatch) {
        return {
            id: afterMatch[1],
            start: lineOffset + wrapperEndInLine,
            end: lineOffset + wrapperEndInLine + afterMatch[0].length,
            placement: "after",
        };
    }

    const innerMatch = String(innerText ?? "").match(/\[\^([^\]]+)\]\s*$/);
    if (!innerMatch) return null;

    const id = innerMatch[1];
    const needle = `[^${id}]`;
    const idx = String(innerText ?? "").lastIndexOf(needle);
    if (idx === -1) return null;

    return {
        id,
        start: innerStart + idx,
        end: innerStart + idx + needle.length,
        placement: "inside",
    };
}

export function findHighlightById(parsed: ParsedHighlights, id: string): Highlight | null {
    return parsed.highlights.find((h) => h.id === id) || null;
}

export function removeHighlightFromRaw(raw: string, highlight: Highlight | null): string {
    if (!highlight) return raw;
    const before = raw.slice(0, highlight.openTagStart);
    const inner = raw.slice(highlight.innerStart, highlight.innerEnd);
    const after = raw.slice(highlight.closeTagEnd);
    return before + inner + after;
}

export function updateHighlightTagsInRaw(raw: string, highlight: Highlight | null, newTagsText: string): string {
    if (!highlight) return raw;
    const normalized = normalizeTagsText(newTagsText);
    const replacement = normalized ? `${normalized} ` : "";

    if (highlight.tagsStart !== null && highlight.tagsEnd !== null) {
        return raw.slice(0, highlight.tagsStart) + replacement + raw.slice(highlight.tagsEnd);
    }

    // No existing tags: insert before wrapper start.
    if (!replacement) return raw;
    return raw.slice(0, highlight.openTagStart) + replacement + raw.slice(highlight.openTagStart);
}

/**
 * Give a highlight a native colour, or none for the theme's default.
 *
 * An HTML highlight left by an older version becomes a native one: the plugin
 * no longer writes HTML into notes.
 */
export function updateHighlightColorInRaw(
    raw: string,
    highlight: Highlight | null,
    newColor: HighlightColor | null
): string {
    if (!highlight) return raw;
    // Markers nested inside would end up inside the new pair, so drop them.
    const inner = stripHighlightMarkers(
        raw.slice(highlight.innerStart, highlight.innerEnd).replace(/<mark\b[^>]*>|<\/mark>/gi, "")
    );
    return raw.slice(0, highlight.openTagStart) + wrapHighlight(inner, newColor) + raw.slice(highlight.closeTagEnd);
}

/** Highlights that do not sit inside another one, so each can be rewritten whole. */
function outermost(highlights: Highlight[]): Highlight[] {
    return highlights.filter(
        (h) =>
            !highlights.some(
                (other) => other !== h && other.openTagStart <= h.openTagStart && other.closeTagEnd >= h.closeTagEnd
            )
    );
}

function nextNumericFootnoteId(raw: string): string {
    const pattern = /\[\^(\d+)\]/g;
    let maxNumber = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(raw)) !== null) {
        const num = parseInt(match[1]);
        if (num > maxNumber) maxNumber = num;
    }
    return String(maxNumber + 1);
}

function countFootnoteRefs(raw: string, footnoteId: string): number {
    const re = new RegExp(`\\[\\^${escapeRegex(footnoteId)}\\]`, "g");
    const matches = raw.match(re);
    return matches ? matches.length : 0;
}

export function updateHighlightAnnotationInRaw(
    raw: string,
    highlight: Highlight | null,
    newAnnotationText: string
): string {
    if (!highlight) return raw;
    const annotation = String(newAnnotationText ?? "").trim();
    const newline = detectNewline(raw);
    const parsed = parseFootnotes(raw);

    const existingId = highlight.footnoteId;
    const existingRefStart = highlight.footnoteStart;
    const existingRefEnd = highlight.footnoteEnd;

    if (!annotation) {
        // Remove annotation reference, and remove its definition if orphaned.
        let updatedRaw = raw;
        if (existingId && existingRefStart !== null && existingRefEnd !== null) {
            updatedRaw = updatedRaw.slice(0, existingRefStart) + updatedRaw.slice(existingRefEnd);
        }
        if (existingId) {
            const refCount = countFootnoteRefs(updatedRaw, existingId);
            if (refCount === 0) {
                const def = parsed.get(existingId);
                if (def) {
                    let defStart = def.start;
                    let defEnd = def.end;
                    // Remove a single trailing newline if present.
                    if (updatedRaw.slice(defEnd, defEnd + newline.length) === newline) {
                        defEnd += newline.length;
                    }
                    // If there is an extra blank line before definition, remove one.
                    if (
                        defStart >= newline.length * 2 &&
                        updatedRaw.slice(defStart - newline.length * 2, defStart) === newline + newline
                    ) {
                        defStart -= newline.length;
                    }
                    updatedRaw = updatedRaw.slice(0, defStart) + updatedRaw.slice(defEnd);
                }
            }
        }
        return updatedRaw;
    }

    // Ensure reference exists.
    let updatedRaw = raw;
    let footnoteId = existingId;
    void existingRefStart;
    void existingRefEnd;

    if (!footnoteId) {
        footnoteId = nextNumericFootnoteId(updatedRaw);
        const footnoteRef = `[^${footnoteId}]`;

        // Insert at end of the highlighted range (inside the wrapper, to match current behavior).
        const insertAt = highlight.innerEnd;
        updatedRaw = updatedRaw.slice(0, insertAt) + footnoteRef + updatedRaw.slice(insertAt);
    }

    // Update or insert definition
    const def = parsed.get(footnoteId);
    if (def) {
        const newLine = `[^${footnoteId}]: ${annotation}`;
        updatedRaw = updatedRaw.slice(0, def.start) + newLine + updatedRaw.slice(def.end);
        return updatedRaw;
    }

    // Append definition to end, preserving existing trim behavior.
    const defText = `${newline}${newline}[^${footnoteId}]: ${annotation}${newline}`;
    updatedRaw = updatedRaw.trimEnd() + defText;
    return updatedRaw;
}

/**
 * Remove a footnote-style annotation entirely: every inline reference `[^id]`
 * in the body plus its `[^id]: ...` definition line. This is the counterpart to
 * removing a highlight, but for standalone annotations that are not attached to
 * a `==`/`<mark>` wrapper (those created via "Add annotation to selection").
 */
export function removeFootnoteFromRaw(raw: string, footnoteId: string): { raw: string; changed: boolean } {
    let updated = String(raw ?? "");
    const id = String(footnoteId ?? "").trim();
    if (!id) return { raw: updated, changed: false };

    const newline = detectNewline(updated);
    let changed = false;

    // 1. Remove inline references `[^id]` (but never the definition's `[^id]:` token).
    const refRe = new RegExp(`\\[\\^${escapeRegex(id)}\\](?!:)`, "g");
    if (refRe.test(updated)) {
        updated = updated.replace(refRe, "");
        changed = true;
    }

    // 2. Remove the definition line `[^id]: ...` (re-parse: ref removal shifted offsets).
    const def = parseFootnotes(updated).get(id);
    if (def) {
        let defStart = def.start;
        let defEnd = def.end;
        // Consume the definition's trailing newline.
        if (updated.slice(defEnd, defEnd + newline.length) === newline) {
            defEnd += newline.length;
        }
        // Collapse a preceding blank line if one was separating the definition.
        if (
            defStart >= newline.length * 2 &&
            updated.slice(defStart - newline.length * 2, defStart) === newline + newline
        ) {
            defStart -= newline.length;
        }
        updated = updated.slice(0, defStart) + updated.slice(defEnd);
        changed = true;
    }

    return { raw: updated, changed };
}

/**
 * Remove every footnote annotation in the note (references + definitions).
 * Returns the rewritten raw text and how many distinct footnotes were removed.
 */
export function removeAllFootnotesFromRaw(raw: string): { raw: string; removedCount: number } {
    let updated = String(raw ?? "");
    const ids = [...parseFootnotes(updated).keys()];
    let removedCount = 0;

    for (const id of ids) {
        const result = removeFootnoteFromRaw(updated, id);
        if (result.changed) {
            removedCount++;
            updated = result.raw;
        }
    }

    return { raw: updated, removedCount };
}

function applyDeletions(raw: string, deletions: Deletion[]): string {
    const ranges = (deletions || [])
        .filter((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
        .sort((a, b) => b.start - a.start);

    let updated = raw;
    for (const range of ranges) {
        updated = updated.slice(0, range.start) + updated.slice(range.end);
    }
    return updated;
}

export function mergeAdjacentHighlightsInRaw(raw: string): { raw: string; mergedCount: number } {
    let updated = String(raw ?? "");
    let mergedCount = 0;
    let passes = 0;

    while (passes < 250) {
        passes++;
        const parsed = parseHighlights(updated);
        const highlights = parsed.highlights;
        const deletions: Deletion[] = [];
        let mergedThisPass = 0;

        for (let i = 0; i < highlights.length - 1; i++) {
            const a = highlights[i];
            const b = highlights[i + 1];

            if (a.line !== b.line) continue;
            if (a.type !== b.type) continue;
            if ((a.tagsText || "").trim() || (b.tagsText || "").trim()) continue;
            if (a.footnoteId || b.footnoteId) continue;

            const between = updated.slice(a.closeTagEnd, b.openTagStart);
            if (!/^\s*$/.test(between)) continue;

            // Joining two highlights keeps the first one's opening marker, so
            // they must look the same: same colour, and for HTML the same tag.
            if (a.color !== b.color) continue;
            if (a.type === "html") {
                const aOpen = updated.slice(a.openTagStart, a.openTagEnd);
                const bOpen = updated.slice(b.openTagStart, b.openTagEnd);
                if (aOpen !== bOpen) continue;
            }

            deletions.push({ start: a.closeTagStart, end: a.closeTagEnd });
            deletions.push({ start: b.openTagStart, end: b.openTagEnd });
            mergedThisPass++;
            i++; // skip b - it is merged into a
        }

        if (mergedThisPass === 0) break;
        updated = applyDeletions(updated, deletions);
        mergedCount += mergedThisPass;
    }

    return { raw: updated, mergedCount };
}

/** Which highlights a recolour applies to. */
export type RecolorSource = "any" | "default" | HighlightColor;

/**
 * Recolour every highlight in the note whose colour is `from`. HTML highlights
 * count by their nearest native colour and come out native.
 */
export function recolorHighlightsInRaw(
    raw: string,
    { from = "any", to = null }: { from?: RecolorSource; to?: HighlightColor | null } = {}
): { raw: string; changedCount: number } {
    let updated = String(raw ?? "");
    const candidates = outermost(parseHighlights(updated).highlights)
        .filter((h) => from === "any" || (from === "default" ? h.color === null : h.color === from))
        .sort((a, b) => b.openTagStart - a.openTagStart);

    let changedCount = 0;
    for (const highlight of candidates) {
        const before = updated;
        updated = updateHighlightColorInRaw(updated, highlight, to);
        if (updated !== before) changedCount++;
    }

    return { raw: updated, changedCount };
}

/**
 * Turn the HTML highlights older versions wrote, `<mark style="background:
 * …">` and background-coloured `<span>`s, into native `==` highlights in the
 * nearest native colour. Code blocks are left alone.
 */
export function convertHtmlHighlightsInRaw(raw: string): { raw: string; changedCount: number } {
    const source = String(raw ?? "");
    const newline = detectNewline(source);
    const lines = source.split(/\r?\n/);
    const inFence = fencedLines(lines);
    let changedCount = 0;

    const converted = lines.map((line, index) => {
        if (inFence[index]) return line;
        return line
            .replace(/<mark\b([^>]*)>(.*?)<\/mark>/gi, (_full, attrs: string, inner: string) => {
                changedCount++;
                const style = extractStyleAttribute(` ${attrs}`);
                const color = nearestHighlightColor(style ? extractBackgroundFromStyle(style.value) : null);
                return wrapHighlight(stripHighlightMarkers(inner), color);
            })
            .replace(/<span\b([^>]*)>(.*?)<\/span>/gi, (full: string, attrs: string, inner: string) => {
                const style = extractStyleAttribute(` ${attrs}`);
                const background = style ? extractBackgroundFromStyle(style.value) : null;
                if (!background) return full;
                changedCount++;
                return wrapHighlight(stripHighlightMarkers(inner), nearestHighlightColor(background));
            });
    });

    return { raw: converted.join(newline), changedCount };
}

/**
 * Remove every highlight in the note, keeping its text. Works from the parsed
 * highlights rather than a blanket `==` replace, so code (`a == b`) and lone
 * markers are left as they are.
 */
export function removeAllHighlightsFromRaw(raw: string): { raw: string; removedCount: number } {
    const source = String(raw ?? "");
    const highlights = parseHighlights(source).highlights;
    // Every marker is deleted in one pass, so a highlight nested in another
    // cannot be thrown off by offsets that shifted under it.
    const deletions = highlights.flatMap((h) => [
        { start: h.openTagStart, end: h.openTagEnd },
        { start: h.closeTagStart, end: h.closeTagEnd },
    ]);
    return { raw: applyDeletions(source, deletions), removedCount: highlights.length };
}
