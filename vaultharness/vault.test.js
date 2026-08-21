// Sweeps the vault: for every repeated term inside a rendered block, selects
// each occurrence in turn and checks the plugin highlights *that* occurrence.
//
// Read-only with respect to the vault — notes are read, never written; the
// plugin's writes go to an in-memory mock.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildNote, selectAndHighlight, analyzeHighlight, occurrencePositions, alreadyHighlighted } from "./driver.js";

const VAULT = process.env.VAULT_PATH || "./test-vault";
const NOTE_LIMIT = Number(process.env.NOTE_LIMIT || 0);
const CASES_PER_NOTE = Number(process.env.CASES_PER_NOTE || 30);
const REPORT = process.env.REPORT_PATH || "/tmp/vault-report.json";

function listNotes(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listNotes(full));
        else if (entry.name.endsWith(".md")) out.push(full);
    }
    return out;
}

function repeatedTerms(text) {
    const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]{3,}/gu) || [];
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    return [...counts.entries()].filter(([w, n]) => n >= 2 && occurrencePositions(text, w).length >= 2).map(([w]) => w);
}

function singleTerms(text) {
    const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]{4,}/gu) || [];
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    return [...counts.entries()].filter(([, n]) => n === 1).map(([w]) => w);
}

describe("vault sweep", () => {
    it("highlights the occurrence the user selected", async () => {
        const notes = listNotes(VAULT);
        const files = NOTE_LIMIT ? notes.slice(0, NOTE_LIMIT) : notes;

        const stats = {
            notes: 0,
            cases: 0,
            correct: 0,
            wrongOccurrence: 0,
            noWrite: 0,
            alreadyHighlighted: 0,
            skipped: 0,
            repeatedCases: 0,
            repeatedCorrect: 0,
            singleCases: 0,
            singleCorrect: 0,
            reasons: {},
        };
        const failures = [];

        for (const file of files) {
            const raw = fs.readFileSync(file, "utf8");
            if (!raw.trim()) continue;
            stats.notes++;

            let note;
            try {
                note = await buildNote(raw, path.relative(VAULT, file));
            } catch (e) {
                failures.push({ file: path.relative(VAULT, file), phase: "build", error: String(e && e.message) });
                continue;
            }
            if (note.rendered.length === 0) continue;

            let budget = CASES_PER_NOTE;
            for (let bi = 0; bi < note.rendered.length && budget > 0; bi++) {
                const entry = note.rendered[bi];
                if (entry.unsupported) continue;

                const plan = [];
                for (const term of repeatedTerms(entry.text).slice(0, 3)) {
                    const positions = occurrencePositions(entry.text, term);
                    for (let o = 0; o < positions.length && o < 4; o++) plan.push({ term, ordinal: o, repeated: true });
                }
                for (const term of singleTerms(entry.text).slice(0, 1)) {
                    plan.push({ term, ordinal: 0, repeated: false });
                }

                for (const step of plan) {
                    if (budget-- <= 0) break;
                    note.reset();

                    let r;
                    try {
                        r = await selectAndHighlight(note, bi, step.term, step.ordinal);
                    } catch (e) {
                        failures.push({
                            file: path.relative(VAULT, file),
                            block: bi,
                            term: step.term,
                            ordinal: step.ordinal,
                            phase: "select",
                            error: String(e && e.message),
                        });
                        continue;
                    }
                    if (r.skipped) {
                        stats.skipped++;
                        continue;
                    }
                    stats.cases++;
                    if (step.repeated) stats.repeatedCases++;
                    else stats.singleCases++;

                    if (!r.changed) {
                        // Already highlighted: there is nothing for the plugin
                        // to do, so writing nothing is the right answer.
                        if (alreadyHighlighted(note.raw, r.expectedStart, r.expectedEnd)) {
                            stats.correct++;
                            stats.alreadyHighlighted++;
                            if (step.repeated) stats.repeatedCorrect++;
                            else stats.singleCorrect++;
                            continue;
                        }
                        stats.noWrite++;
                        failures.push({
                            file: path.relative(VAULT, file),
                            block: bi,
                            term: step.term,
                            ordinal: step.ordinal,
                            kind: "no-write",
                            context: entry.text.slice(0, 120),
                        });
                        continue;
                    }

                    const verdict = analyzeHighlight(note.raw, r.output, r.expectedStart, r.expectedEnd, step.term);
                    if (verdict.ok) {
                        stats.correct++;
                        if (step.repeated) stats.repeatedCorrect++;
                        else stats.singleCorrect++;
                    } else {
                        stats.wrongOccurrence++;
                        stats.reasons[verdict.reason] = (stats.reasons[verdict.reason] || 0) + 1;
                        failures.push({
                            file: path.relative(VAULT, file),
                            block: bi,
                            term: step.term,
                            ordinal: step.ordinal,
                            kind: "wrong-occurrence",
                            reason: verdict.reason,
                            expected: [r.expectedStart, r.expectedEnd],
                            occurrences: r.occurrences,
                            context: entry.text.slice(0, 160),
                        });
                    }
                }
            }
        }

        fs.writeFileSync(REPORT, JSON.stringify({ stats, failures: failures.slice(0, 5000) }, null, 2));
        expect(stats.cases).toBeGreaterThan(500);
        expect(stats.wrongOccurrence).toBe(0);
    });
});
