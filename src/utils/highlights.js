function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectNewline(raw) {
    return raw.includes("\r\n") ? "\r\n" : "\n";
}

function extractStyleAttribute(openTag) {
    const styleMatch = openTag.match(/\sstyle=(["'])([\s\S]*?)\1/i);
    if (!styleMatch) return null;
    return {
        quote: styleMatch[1],
        value: styleMatch[2],
        index: styleMatch.index ?? -1,
        length: styleMatch[0].length,
    };
}

function extractBackgroundFromStyle(styleValue) {
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

function normalizeTagsText(tagsText) {
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

export function parseFootnotes(raw) {
    const newline = detectNewline(raw);
    const lines = raw.split(/\r?\n/);
    const results = new Map();
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

export function parseHighlights(raw) {
    const newline = detectNewline(raw);
    const footnotes = parseFootnotes(raw);
    const highlights = [];

    const lines = raw.split(/\r?\n/);
    let lineOffset = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        let matchIndex = 0;

        const markdownPattern = /==(.*?)==/g;
        const htmlPattern = /<mark\b[^>]*>(.*?)<\/mark>/gi;

        let match;
        while ((match = markdownPattern.exec(line)) !== null) {
            const start = lineOffset + match.index;
            const end = start + match[0].length;
            const innerStart = start + 2;
            const innerEnd = end - 2;

            const { tagsText, tagsStart, tagsEnd } = extractLeadingTagsRange(line, lineOffset, match.index);
            const footnote = detectFootnoteForHighlight({
                line,
                lineOffset,
                wrapperEndInLine: match.index + match[0].length,
                innerText: match[1],
                innerStart,
            });

            highlights.push({
                id: `${lineIdx}:${matchIndex}`,
                text: (match[1] ?? "").trim(),
                line: lineIdx,
                type: "markdown",
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

            matchIndex++;
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
            const color = styleAttr ? extractBackgroundFromStyle(styleAttr.value) : null;

            const { tagsText, tagsStart, tagsEnd } = extractLeadingTagsRange(line, lineOffset, match.index);
            const footnote = detectFootnoteForHighlight({
                line,
                lineOffset,
                wrapperEndInLine: match.index + match[0].length,
                innerText: match[1],
                innerStart,
            });

            highlights.push({
                id: `${lineIdx}:${matchIndex}`,
                text: (match[1] ?? "").trim(),
                line: lineIdx,
                type: "html",
                color: color ? color.trim() : null,
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

            matchIndex++;
        }

        lineOffset += line.length + (lineIdx < lines.length - 1 ? newline.length : 0);
    }

    highlights.sort((a, b) => a.start - b.start);
    return { highlights, footnotes };
}

function extractLeadingTagsRange(line, lineOffset, wrapperStartInLine) {
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

function detectFootnoteForHighlight({ line, lineOffset, wrapperEndInLine, innerText, innerStart }) {
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

export function findHighlightById(parsed, id) {
    return parsed.highlights.find((h) => h.id === id) || null;
}

export function removeHighlightFromRaw(raw, highlight) {
    if (!highlight) return raw;
    const before = raw.slice(0, highlight.openTagStart);
    const inner = raw.slice(highlight.innerStart, highlight.innerEnd);
    const after = raw.slice(highlight.closeTagEnd);
    return before + inner + after;
}

export function updateHighlightTagsInRaw(raw, highlight, newTagsText) {
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

function buildUpdatedOpenTag(openTag, newColor) {
    const styleAttr = extractStyleAttribute(openTag);
    if (!styleAttr) {
        return openTag.replace(/^<mark\b/i, `<mark style="background: ${newColor}; color: black;"`);
    }

    const styleValue = styleAttr.value;
    const decls = styleValue
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
    let updated = [];
    let replaced = false;

    for (const decl of decls) {
        const colon = decl.indexOf(":");
        if (colon === -1) {
            updated.push(decl);
            continue;
        }
        const key = decl.slice(0, colon).trim();
        const value = decl.slice(colon + 1).trim();
        const keyLc = key.toLowerCase();
        if (keyLc === "background" || keyLc === "background-color") {
            updated.push(`${key}: ${newColor}`);
            replaced = true;
        } else {
            updated.push(`${key}: ${value}`);
        }
    }

    if (!replaced) {
        updated.unshift(`background: ${newColor}`);
    }

    const newStyleValue = updated.join("; ") + (updated.length ? ";" : "");
    const quoted = `${styleAttr.quote}${newStyleValue}${styleAttr.quote}`;

    return openTag.replace(/\sstyle=(["'])([\s\S]*?)\1/i, ` style=${quoted}`);
}

export function updateHighlightColorInRaw(raw, highlight, newColor) {
    if (!highlight) return raw;
    if (!newColor) return raw;

    if (highlight.type === "html") {
        const openTag = raw.slice(highlight.openTagStart, highlight.openTagEnd);
        const updatedOpenTag = buildUpdatedOpenTag(openTag, newColor);
        return raw.slice(0, highlight.openTagStart) + updatedOpenTag + raw.slice(highlight.openTagEnd);
    }

    // Markdown highlight -> convert to HTML mark
    const inner = raw.slice(highlight.innerStart, highlight.innerEnd);
    const replacement = `<mark style="background: ${newColor}; color: black;">${inner}</mark>`;
    return raw.slice(0, highlight.openTagStart) + replacement + raw.slice(highlight.closeTagEnd);
}

function nextNumericFootnoteId(raw) {
    const pattern = /\[\^(\d+)\]/g;
    let maxNumber = 0;
    let match;
    while ((match = pattern.exec(raw)) !== null) {
        const num = parseInt(match[1]);
        if (num > maxNumber) maxNumber = num;
    }
    return String(maxNumber + 1);
}

function countFootnoteRefs(raw, footnoteId) {
    const re = new RegExp(`\\[\\^${escapeRegex(footnoteId)}\\]`, "g");
    const matches = raw.match(re);
    return matches ? matches.length : 0;
}

export function updateHighlightAnnotationInRaw(raw, highlight, newAnnotationText) {
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
export function removeFootnoteFromRaw(raw, footnoteId) {
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
export function removeAllFootnotesFromRaw(raw) {
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

function applyDeletions(raw, deletions) {
    const ranges = (deletions || [])
        .filter((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start)
        .sort((a, b) => b.start - a.start);

    let updated = raw;
    for (const range of ranges) {
        updated = updated.slice(0, range.start) + updated.slice(range.end);
    }
    return updated;
}

export function mergeAdjacentHighlightsInRaw(raw) {
    let updated = String(raw ?? "");
    let mergedCount = 0;
    let passes = 0;

    while (passes < 250) {
        passes++;
        const parsed = parseHighlights(updated);
        const highlights = parsed.highlights;
        const deletions = [];
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

export function recolorMarkHighlightsInRaw(raw, { fromColor = "", toColor = "" } = {}) {
    let updated = String(raw ?? "");
    const targetColor = String(toColor || "").trim();
    if (!targetColor) {
        return { raw: updated, changedCount: 0 };
    }

    const from = String(fromColor || "")
        .trim()
        .toLowerCase();
    const parsed = parseHighlights(updated);
    const candidates = parsed.highlights
        .filter((h) => h.type === "html")
        .filter((h) => {
            if (!from) return true;
            return (
                String(h.color || "")
                    .trim()
                    .toLowerCase() === from
            );
        })
        .sort((a, b) => b.openTagStart - a.openTagStart);

    let changedCount = 0;
    for (const highlight of candidates) {
        const before = updated;
        updated = updateHighlightColorInRaw(updated, highlight, targetColor);
        if (updated !== before) changedCount++;
    }

    return { raw: updated, changedCount };
}

export function migrateSpanHighlightsInRaw(raw) {
    let updated = String(raw ?? "");
    let changedCount = 0;

    // Convert <span style="background...">...</span> into <mark style="background...">...</mark>
    // This is intentionally conservative: only spans with a background/background-color declaration are migrated.
    const spanRe = /<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
    updated = updated.replace(spanRe, (full, attrs, inner) => {
        const styleMatch = String(attrs || "").match(/\sstyle=(["'])([\s\S]*?)\1/i);
        if (!styleMatch) return full;
        const background = extractBackgroundFromStyle(styleMatch[2]);
        if (!background) return full;
        changedCount++;
        return `<mark style="background: ${background}; color: black;">${inner}</mark>`;
    });

    return { raw: updated, changedCount };
}
