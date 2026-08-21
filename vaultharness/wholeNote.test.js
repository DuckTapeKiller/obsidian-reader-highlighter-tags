// Issue 3: selecting an entire article must never pull a structural marker
// (`- `, `# `, `> `, `1. `) inside the highlight.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildNote, selectWholeNote } from "./driver.js";

const VAULT = process.env.VAULT_PATH || "./test-vault";
const LIMIT = Number(process.env.NOTE_LIMIT || 0);
const OFFSET = Number(process.env.NOTE_OFFSET || 0);
const REPORT = process.env.REPORT_PATH || "/tmp/whole-note.json";

function listNotes(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listNotes(full));
        else if (e.name.endsWith(".md")) out.push(full);
    }
    return out;
}

// A marker swallowed by the highlight: an OPENING `==` at the start of a line,
// sitting before that line's own structural marker — `==- item`, `==# Title`.
// Anchored to the line so a closing `==` followed by the next list item (which
// is correct output) is not mistaken for it.
const SWALLOWED = /^[ \t]*==[ \t]*(?:[-*+][ \t]|#{1,6}[ \t]|>[ \t]?|\d{1,3}[.)][ \t])/;

function findSwallowed(output) {
    for (const line of output.split(/\r?\n/)) {
        const hit = line.match(SWALLOWED);
        if (hit) return { marker: hit[0], line };
    }
    return null;
}

describe("highlighting a whole article", () => {
    it("never swallows a list or heading marker", async () => {
        const notes = listNotes(VAULT);
        const files = LIMIT ? notes.slice(OFFSET, OFFSET + LIMIT) : notes.slice(OFFSET);
        const stats = { notes: 0, ran: 0, changed: 0, skipped: 0, swallowed: 0, unbalanced: 0 };
        const failures = [];
        // Written after every note: a whole-article selection is heavy enough
        // that a long sweep can exhaust the worker, and partial results are
        // still worth having.
        const writeReport = () =>
            fs.writeFileSync(REPORT, JSON.stringify({ stats, failures: failures.slice(0, 200) }, null, 2));

        for (const file of files) {
            const raw = fs.readFileSync(file, "utf8");
            if (!raw.trim()) continue;
            stats.notes++;
            stats.lastFile = path.relative(VAULT, file);
            writeReport();
            let note;
            try {
                note = await buildNote(raw, path.relative(VAULT, file));
            } catch (e) {
                failures.push({ file: path.relative(VAULT, file), phase: "build", error: String(e && e.message) });
                continue;
            }
            let res;
            try {
                res = await selectWholeNote(note);
            } catch (e) {
                failures.push({ file: path.relative(VAULT, file), phase: "select", error: String(e && e.message) });
                continue;
            }
            if (res.skipped) {
                stats.skipped++;
                continue;
            }
            stats.ran++;
            if (res.changed) stats.changed++;

            const hit = findSwallowed(res.output);
            if (hit) {
                stats.swallowed++;
                failures.push({
                    file: path.relative(VAULT, file),
                    kind: "swallowed-marker",
                    marker: hit.marker,
                    context: hit.line.slice(0, 120),
                });
            }
            if ((res.output.match(/==/g) || []).length % 2 !== 0) {
                stats.unbalanced++;
                failures.push({ file: path.relative(VAULT, file), kind: "unbalanced-markers" });
            }
            writeReport();
        }

        writeReport();
        expect(stats.ran).toBeGreaterThan(30);
        expect(stats.swallowed).toBe(0);
        expect(stats.unbalanced).toBe(0);
    });
});
