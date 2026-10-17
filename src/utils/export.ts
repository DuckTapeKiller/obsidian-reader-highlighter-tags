/**
 * Export highlights from a file to a new markdown file.
 * Finds all ==text== and <mark>text</mark> elements and creates a summary.
 */
import { App, TFile, normalizePath } from "obsidian";
import { parseHighlights, type Highlight } from "./highlights";
import { formatDate } from "./time";

function detectNewline(raw: string): string {
    return raw.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Stringify a value that may be anything. Objects have no useful string form —
 * `String({})` is `"[object Object]"` — so they become empty rather than noise.
 */
function asText(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    return "";
}

function csvEscape(value: unknown): string {
    const str = asText(value);
    if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

interface EnsuredBlockIds {
    raw: string;
    changed: boolean;
    lineToBlockId: Map<number, string>;
}

const BLOCK_ID_AT_END = /\s(\^[a-zA-Z0-9-]+)$/;
const BLOCK_ID_LINE = /^\s*(\^[a-zA-Z0-9-]+)\s*$/;
const isTableLine = (line: string) => /^\s*\|/.test(line);

function newBlockId(): string {
    return "^" + Math.random().toString(36).substring(2, 8);
}

/**
 * Give every line holding a highlight a block id, so it can be embedded.
 *
 * A table row cannot carry one — text after its last pipe becomes a stray cell
 * — so a table gets a single id on the line after it, which is where Obsidian
 * looks for a table's block id.
 */
function ensureBlockIdsForHighlightLines(raw: string, highlights: Highlight[]): EnsuredBlockIds {
    const newline = detectNewline(raw);
    const lines = raw.split(/\r?\n/);
    const lineSet = new Set(highlights.map((h) => h.line).filter((n) => Number.isInteger(n)));

    let changed = false;
    const lineToBlockId = new Map<number, string>();
    // Lines after which a new block-id line goes: the last row of a table.
    const insertAfter = new Map<number, string>();

    for (const lineIdx of lineSet) {
        if (lineIdx < 0 || lineIdx >= lines.length) continue;
        const line = lines[lineIdx];

        if (isTableLine(line)) {
            let end = lineIdx;
            while (end + 1 < lines.length && isTableLine(lines[end + 1])) end++;
            const existing = insertAfter.get(end) ?? lines[end + 1]?.match(BLOCK_ID_LINE)?.[1];
            const blockId = existing ?? newBlockId();
            if (!existing) {
                insertAfter.set(end, blockId);
                changed = true;
            }
            lineToBlockId.set(lineIdx, blockId);
            continue;
        }

        const blockMatch = line.match(BLOCK_ID_AT_END);
        if (blockMatch) {
            lineToBlockId.set(lineIdx, blockMatch[1]);
            continue;
        }
        const blockId = newBlockId();
        lines[lineIdx] = line + " " + blockId;
        lineToBlockId.set(lineIdx, blockId);
        changed = true;
    }

    const out: string[] = [];
    lines.forEach((line, index) => {
        out.push(line);
        const blockId = insertAfter.get(index);
        if (blockId) out.push(blockId);
    });

    return {
        raw: out.join(newline),
        changed,
        lineToBlockId,
    };
}

/**
 * `<folder>/<basename> - Highlights<suffix>.<ext>`, beside the note. A note at
 * the vault root has the parent path "/", so the path is normalised rather
 * than left starting with "//".
 */
function exportPathFor(file: TFile, ext: string, suffix = ""): string {
    return normalizePath(`${file.parent?.path ?? ""}/${file.basename} - Highlights${suffix}.${ext}`);
}

/** The export path, or a timestamped one if that file already exists. */
function freeExportPath(app: App, file: TFile, ext: string): string {
    const path = exportPathFor(file, ext);
    if (!app.vault.getAbstractFileByPath(path)) return path;
    return exportPathFor(file, ext, ` ${formatDate("YYYYMMDD-HHmmss")}`);
}

export async function exportHighlightsToMD(app: App, file: TFile): Promise<string> {
    let raw = await app.vault.read(file);
    const parsed = parseHighlights(raw);
    if (!parsed.highlights.length) {
        throw new Error("No highlights found in this file.");
    }

    // One embed per line holding highlights, in note order. The shared helper
    // keeps CRLF notes intact and reuses a block id the line already has.
    const ensured = ensureBlockIdsForHighlightLines(raw, parsed.highlights);
    raw = ensured.raw;
    if (ensured.changed) {
        await app.vault.modify(file, raw);
    }
    // Rows of one table share its block id, so embed each id once.
    const blockIds = [...ensured.lineToBlockId.entries()].sort(([a], [b]) => a - b).map(([, id]) => id);
    const highlights = [...new Set(blockIds)].map((blockId) => ({ text: `![[${file.basename}#${blockId}]]` }));

    // Get current date
    const date = formatDate("YYYY-MM-DD HH:mm");

    // Generate export content
    const exportContent = `# Highlights from [[${file.basename}]]

> Exported: ${date}
> Source: [[${file.path}]]
> Total highlights: ${highlights.length}

---

${highlights.map((h, i) => `${i + 1}. ${h.text}`).join("\n\n")}

---

*Exported by Reader Highlighter Tags*
`;

    const exportPath = freeExportPath(app, file, "md");
    await app.vault.create(exportPath, exportContent);

    return exportPath;
}

/**
 * Get all highlights from a file for the navigator view.
 */
export function getHighlightsFromContent(raw: string): Highlight[] {
    const parsed = parseHighlights(raw);
    return parsed.highlights;
}

export async function exportHighlightsToJSON(app: App, file: TFile): Promise<string> {
    let raw = await app.vault.read(file);
    const parsed = parseHighlights(raw);
    if (!parsed.highlights.length) {
        throw new Error("No highlights found in this file.");
    }

    const ensured = ensureBlockIdsForHighlightLines(raw, parsed.highlights);
    raw = ensured.raw;
    if (ensured.changed) {
        await app.vault.modify(file, raw);
    }

    const date = formatDate("YYYY-MM-DD HH:mm");

    const exportData = {
        exported: date,
        source: { path: file.path, basename: file.basename },
        total: parsed.highlights.length,
        highlights: parsed.highlights.map((h) => {
            const blockId = ensured.lineToBlockId.get(h.line) || null;
            return {
                id: h.id,
                text: h.text,
                type: h.type,
                color: h.color ?? null,
                tagsText: h.tagsText ?? "",
                tags: (h.tagsText || "").split(/\s+/).filter(Boolean),
                annotation: h.annotation ?? "",
                footnoteId: h.footnoteId ?? null,
                line: h.line,
                blockId,
                blockEmbed: blockId ? `![[${file.basename}#${blockId}]]` : null,
            };
        }),
    };

    const exportPath = freeExportPath(app, file, "json");

    await app.vault.create(exportPath, JSON.stringify(exportData, null, 2));
    return exportPath;
}

export async function exportHighlightsToCSV(app: App, file: TFile): Promise<string> {
    let raw = await app.vault.read(file);
    const parsed = parseHighlights(raw);
    if (!parsed.highlights.length) {
        throw new Error("No highlights found in this file.");
    }

    const ensured = ensureBlockIdsForHighlightLines(raw, parsed.highlights);
    raw = ensured.raw;
    if (ensured.changed) {
        await app.vault.modify(file, raw);
    }

    const header = [
        "source_path",
        "source_basename",
        "highlight_id",
        "type",
        "color",
        "tags",
        "annotation",
        "footnote_id",
        "line",
        "block_id",
        "block_embed",
        "text",
    ].join(",");

    const rows = parsed.highlights.map((h) => {
        const blockId = ensured.lineToBlockId.get(h.line) || "";
        const blockEmbed = blockId ? `![[${file.basename}#${blockId}]]` : "";
        return [
            csvEscape(file.path),
            csvEscape(file.basename),
            csvEscape(h.id),
            csvEscape(h.type),
            csvEscape(h.color ?? ""),
            csvEscape((h.tagsText || "").trim()),
            csvEscape(h.annotation ?? ""),
            csvEscape(h.footnoteId ?? ""),
            csvEscape(h.line),
            csvEscape(blockId),
            csvEscape(blockEmbed),
            csvEscape(h.text ?? ""),
        ].join(",");
    });

    const csv = [header, ...rows].join("\n");

    const exportPath = freeExportPath(app, file, "csv");

    await app.vault.create(exportPath, csv);
    return exportPath;
}
