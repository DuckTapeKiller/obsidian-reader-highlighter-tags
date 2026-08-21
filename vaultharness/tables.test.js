// Table sweep: selects every cell of every table in the vault's `tables`
// folder, plus multi-cell, whole-row, header-row and whole-table selections,
// and checks what actually lands in the source.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildNote, rangeForSlice } from "./driver.js";
import { bodyStartOf, splitBlocks } from "./render.js";

const DIR = process.env.TABLES_DIR || "./test-vault";
const REPORT = process.env.REPORT_PATH || "/tmp/tables.json";
const ONLY = process.env.ONLY_KIND || "";

const notes = () =>
    fs
        .readdirSync(DIR)
        .filter((f) => f.endsWith(".md"))
        .sort((a, b) => parseInt(a) - parseInt(b));

/** Structural invariants a table edit must never break. */
function structureIntact(raw, out) {
    const a = raw.split("\n");
    const b = out.split("\n");
    if (a.length !== b.length) return "line count changed";
    for (let i = 0; i < a.length; i++) {
        const pipes = (s) => (s.match(/(?<!\\)\|/g) || []).length;
        if (pipes(a[i]) !== pipes(b[i])) return `pipe count changed on line ${i}`;
        // The delimiter row must never be touched.
        if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(a[i]) && a[i] !== b[i]) {
            return `delimiter row modified on line ${i}`;
        }
    }
    return null;
}

/**
 * Cells whose source changed between raw and out, compared cell by cell.
 * Comparing whole lines is useless here: every cell in a row shares one line,
 * so highlighting one would look like highlighting all of them.
 */
function tableCellSources(text) {
    const out = [];
    for (const block of splitBlocks(text, bodyStartOf(text))) {
        if (block.tag !== "table") continue;
        let rowIdx = 0;
        for (const row of block.rows) {
            if (row.delimiter) continue;
            row.cells.forEach((cell, colIdx) => {
                out.push({ rowIdx, colIdx, source: text.substring(cell.start, cell.end), start: cell.start });
            });
            rowIdx++;
        }
    }
    return out;
}

function changedCells(note, out) {
    const before = tableCellSources(note.raw);
    const after = tableCellSources(out);
    const key = (c) => `${c.rowIdx}:${c.colIdx}`;
    const afterMap = new Map(after.map((c) => [key(c), c.source]));
    const changed = [];
    for (const c of before) {
        if (afterMap.get(key(c)) !== c.source) changed.push(c);
    }
    return changed;
}

async function selectAndHighlightRange(note, range) {
    const sel = note.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    note.plugin._failed = false;
    await note.plugin.highlightSelection(note.view, { text: range.toString(), range });
    return { output: note.getCurrent(), failed: note.plugin._failed };
}

function cellRange(note, entry) {
    return rangeForSlice(note.doc, entry.norm, 0, entry.norm.length);
}

function spanRange(note, first, last) {
    const a = cellRange(note, first);
    const b = cellRange(note, last);
    if (!a || !b) return null;
    const r = note.doc.createRange();
    r.setStart(a.startContainer, a.startOffset);
    r.setEnd(b.endContainer, b.endOffset);
    return r;
}

describe("tables", () => {
    it("highlights the cells the user selected and nothing else", async () => {
        const stats = { notes: 0, cases: 0, ok: 0, bad: 0, skipped: 0, byKind: {} };
        const failures = [];
        const record = (kind, good, detail) => {
            stats.cases++;
            stats.byKind[kind] = stats.byKind[kind] || { ok: 0, bad: 0 };
            if (good) {
                stats.ok++;
                stats.byKind[kind].ok++;
            } else {
                stats.bad++;
                stats.byKind[kind].bad++;
                if (failures.length < 300) failures.push({ kind, ...detail });
            }
            fs.writeFileSync(REPORT, JSON.stringify({ stats, failures }, null, 2));
        };

        for (const file of notes()) {
            const raw = fs.readFileSync(path.join(DIR, file), "utf8");
            stats.notes++;

            const probe = await buildNote(raw, file);
            const table = probe.tables[0];
            if (!table) continue;

            const cells = table.cells.filter((c) => c.text.trim() && !c.unsupported);
            const plan = [];
            for (const c of cells) plan.push({ kind: "single-cell", cells: [c] });
            for (const row of table.rows) {
                const rc = row.cells.filter((c) => c.text.trim() && !c.unsupported);
                if (rc.length >= 2) {
                    plan.push({ kind: "two-cells", cells: [rc[0], rc[1]] });
                    plan.push({ kind: row.isHeader ? "header-row" : "whole-row", cells: rc });
                }
            }
            if (cells.length >= 4) plan.push({ kind: "whole-table", cells });

            for (const step of plan) {
                if (ONLY && step.kind !== ONLY) continue;
                const note = await buildNote(raw, file);
                const t = note.tables[0];
                const pick = (c) => t.cells.find((x) => x.cell.start === c.cell.start);
                const first = pick(step.cells[0]);
                const last = pick(step.cells[step.cells.length - 1]);
                if (!first || !last) {
                    stats.skipped++;
                    continue;
                }
                const range = step.cells.length === 1 ? cellRange(note, first) : spanRange(note, first, last);
                if (!range || range.collapsed) {
                    stats.skipped++;
                    continue;
                }

                let res;
                try {
                    res = await selectAndHighlightRange(note, range);
                } catch (e) {
                    record(step.kind, false, { file, reason: "threw", error: String(e && e.message) });
                    continue;
                }

                const detail = {
                    file,
                    cells: step.cells.map((c) => c.source),
                    selection: range.toString().slice(0, 80),
                };

                if (res.output === raw) {
                    // Every selected cell already highlighted: nothing to do.
                    const allMarked = step.cells.every((c) => /==|<mark\b/i.test(c.source));
                    record(step.kind, allMarked && !res.failed, {
                        ...detail,
                        reason: res.failed ? "not-located" : "no-change",
                    });
                    continue;
                }
                const broke = structureIntact(raw, res.output);
                if (broke) {
                    record(step.kind, false, { ...detail, reason: broke, out: diffLines(raw, res.output) });
                    continue;
                }
                // Every selected cell must now be highlighted, and no other cell.
                // A span selection covers every cell between its ends, in
                // document order — including cells the renderer skips. Those are
                // legitimately highlighted, so treat the whole covered run as
                // wanted rather than only the cells the plan listed.
                const rowOf = (c) => c.table.rows.findIndex((r) => r.cells.includes(c));
                const order = t.cells;
                const firstIdx = order.indexOf(first);
                const lastIdx = order.indexOf(last);
                const covered = order.slice(Math.min(firstIdx, lastIdx), Math.max(firstIdx, lastIdx) + 1);
                const wanted = new Set(covered.map((c) => `${rowOf(c)}:${c.colIndex}`));
                const touched = changedCells(note, res.output);
                const touchedKeys = new Set(touched.map((c) => `${c.rowIdx}:${c.colIdx}`));
                const extra = touched.filter((c) => !wanted.has(`${c.rowIdx}:${c.colIdx}`));
                // A cell that was already highlighted needs no change, so its
                // absence from the diff is the right outcome, not a miss.
                const alreadyMarked = (c) => /==|<mark\b/i.test(c.source);
                const missing = step.cells.filter(
                    (c) => !alreadyMarked(c) && !touchedKeys.has(`${rowOf(c)}:${c.colIndex}`)
                );
                if (extra.length || missing.length) {
                    record(step.kind, false, {
                        ...detail,
                        reason: "wrong cells changed",
                        extra: extra.map((c) => c.source).slice(0, 6),
                        missing: missing.map((c) => c.source).slice(0, 6),
                        out: diffLines(raw, res.output),
                    });
                    continue;
                }
                record(step.kind, true);
            }
        }

        fs.writeFileSync(REPORT, JSON.stringify({ stats, failures }, null, 2));
        expect(stats.cases).toBeGreaterThan(100);
        expect(stats.bad).toBe(0);
    });
});

function diffLines(a, b) {
    const al = a.split("\n");
    const bl = b.split("\n");
    const out = [];
    for (let i = 0; i < Math.max(al.length, bl.length); i++) {
        if (al[i] !== bl[i])
            out.push({ line: i, before: (al[i] || "").slice(0, 90), after: (bl[i] || "").slice(0, 90) });
    }
    return out.slice(0, 4);
}
