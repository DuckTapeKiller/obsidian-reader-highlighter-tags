// Lowercasing can lengthen a character — `İ` (U+0130) becomes `i` plus a
// combining dot, `ẞ` becomes `ss`. The hybrid matcher's index map must stay the
// same length as the text it maps, or every match after such a character
// resolves a little further off and markers land inside words.
import { describe, it, expect } from "vitest";
import { SelectionLogic } from "../src/core/SelectionLogic";
import { TFile } from "./obsidian-stub.js";

const logic = () => new SelectionLogic({});

async function locate(raw, snippet) {
    const file = new TFile("note.md");
    const app = {
        vault: { read: async () => raw },
        metadataCache: { getFileCache: () => ({ embeds: [] }) },
    };
    const l = new SelectionLogic(app);
    return l.locateSelection(file, { file, contentEl: null }, snippet, null, 0, null, null);
}

describe("hybrid index map", () => {
    it("stays in step with the text it maps", () => {
        for (const text of ["İnebahtı deniz", "Straße ẞ end", "plain ascii only", "ǅungla İ ẞ mixed"]) {
            const { normalized, map } = logic().buildHybridMap(text);
            expect(map.length).toBe(normalized.length);
        }
    });

    it("locates a word after a character whose lowercase is longer", async () => {
        const raw = "en turco: İnebahtı deniz muharebesi, 'batalla naval de İnebahtı' fue un combate.";
        const r = await locate(raw, "naval");
        expect(r).not.toBeNull();
        expect(raw.slice(r.start, r.end)).toBe("naval");
    });

    it("stays correct after several such characters", async () => {
        const raw = "İ bir İki İnebahtı üç Imperio otomano dört İstanbul beş.";
        const r = await locate(raw, "Imperio");
        expect(r).not.toBeNull();
        expect(raw.slice(r.start, r.end)).toBe("Imperio");
    });

    it("handles a sharp S the same way", async () => {
        const raw = "Die Straße ẞ und das Wort Beispiel steht hier.";
        const r = await locate(raw, "Beispiel");
        expect(r).not.toBeNull();
        expect(raw.slice(r.start, r.end)).toBe("Beispiel");
    });

    it("is unaffected for plain ASCII", async () => {
        const raw = "one two three four five six seven";
        const r = await locate(raw, "five");
        expect(raw.slice(r.start, r.end)).toBe("five");
    });
});
