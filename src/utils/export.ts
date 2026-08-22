/**
 * Export highlights from a file to a new markdown file.
 * Finds all ==text== and <mark>text</mark> elements and creates a summary.
 */
import { App, TFile } from "obsidian";
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

function ensureBlockIdsForHighlightLines(raw: string, highlights: Highlight[]): EnsuredBlockIds {
    const newline = detectNewline(raw);
    const lines = raw.split(/\r?\n/);
    const lineSet = new Set(highlights.map((h) => h.line).filter((n) => Number.isInteger(n)));

    let changed = false;
    const lineToBlockId = new Map<number, string>();

    for (const lineIdx of lineSet) {
        if (lineIdx < 0 || lineIdx >= lines.length) continue;
        const line = lines[lineIdx];
        const blockMatch = line.match(/\s(\^[a-zA-Z0-9-]+)$/);
        if (blockMatch) {
            lineToBlockId.set(lineIdx, blockMatch[1]);
            continue;
        }
        const blockId = "^" + Math.random().toString(36).substring(2, 8);
        lines[lineIdx] = line + " " + blockId;
        lineToBlockId.set(lineIdx, blockId);
        changed = true;
    }

    return {
        raw: lines.join(newline),
        changed,
        lineToBlockId,
    };
}

function parentPath(file: TFile): string {
    return file.parent?.path ?? "";
}

export async function exportHighlightsToMD(app: App, file: TFile): Promise<string> {
    const raw = await app.vault.read(file);
    let changed = false;

    const lines = raw.split("\n");
    const highlights: { text: string }[] = [];

    const markdownPattern = /==(.*?)==/g;
    const htmlPattern = /<mark[^>]*>(.*?)<\/mark>/g;

    lines.forEach((line, lineIdx) => {
        let hasHighlight = false;

        // reset regex state if not creating new ones per line
        const mdRegex = new RegExp(markdownPattern);
        while (mdRegex.exec(line) !== null) {
            hasHighlight = true;
        }

        const htmlRegex = new RegExp(htmlPattern);
        while (htmlRegex.exec(line) !== null) {
            hasHighlight = true;
        }

        if (hasHighlight) {
            const blockMatch = lines[lineIdx].match(/\s(\^[a-zA-Z0-9-]+)$/);
            let blockId = "";
            if (blockMatch) {
                blockId = blockMatch[1];
            } else {
                blockId = "^" + Math.random().toString(36).substring(2, 8);
                lines[lineIdx] = lines[lineIdx] + " " + blockId;
                changed = true;
            }

            highlights.push({
                text: `![[${file.basename}#${blockId}]]`,
            });
        }
    });

    if (highlights.length === 0) {
        throw new Error("No highlights found in this file.");
    }

    if (changed) {
        await app.vault.modify(file, lines.join("\n"));
    }

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

    // Create unique filename
    let exportPath = `${parentPath(file)}/${file.basename} - Highlights.md`;

    // Check if file exists, if so add timestamp
    const existingFile = app.vault.getAbstractFileByPath(exportPath);
    if (existingFile) {
        const timestamp = formatDate("YYYYMMDD-HHmmss");
        exportPath = `${parentPath(file)}/${file.basename} - Highlights ${timestamp}.md`;
    }

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

    let exportPath = `${parentPath(file)}/${file.basename} - Highlights.json`;
    const existingFile = app.vault.getAbstractFileByPath(exportPath);
    if (existingFile) {
        const timestamp = formatDate("YYYYMMDD-HHmmss");
        exportPath = `${parentPath(file)}/${file.basename} - Highlights ${timestamp}.json`;
    }

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

    let exportPath = `${parentPath(file)}/${file.basename} - Highlights.csv`;
    const existingFile = app.vault.getAbstractFileByPath(exportPath);
    if (existingFile) {
        const timestamp = formatDate("YYYYMMDD-HHmmss");
        exportPath = `${parentPath(file)}/${file.basename} - Highlights ${timestamp}.csv`;
    }

    await app.vault.create(exportPath, csv);
    return exportPath;
}
