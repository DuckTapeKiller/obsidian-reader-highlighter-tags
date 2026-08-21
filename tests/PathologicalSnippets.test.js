// Snippets that made the matcher exhaust memory rather than fail. Both were
// found by sweeping the vault: an Obsidian comment block, and a stray pair of
// backticks rendered as their own block.
import { describe, it, expect } from "vitest";
import { SelectionLogic } from "../src/core/SelectionLogic";
import { TFile } from "./obsidian-stub.js";

const BODY = [
    "# Ten questions",
    "",
    "Intelligence is bounded by physics, and by the cost of computation in a brain.",
    "",
    "It also seems likely that these cognitively superior children would be rare.",
    "",
    "%%b3c8ca70-9f68-11ee-8263-33fa8d95cff2_end%%",
].join("\n");

function makeLogic(raw) {
    const file = new TFile("note.md");
    const app = {
        vault: { read: async () => raw },
        metadataCache: { getFileCache: () => ({ embeds: [] }) },
    };
    return { logic: new SelectionLogic(app), file, view: { file, contentEl: null } };
}

async function locate(raw, snippet) {
    const { logic, file, view } = makeLogic(raw);
    return logic.locateSelection(file, view, snippet, snippet, 0, null, null);
}

describe("snippets with no locatable content", () => {
    it("returns null for an Obsidian comment rather than searching for it", async () => {
        const r = await locate(BODY, "%%b3c8ca70-9f68-11ee-8263-33fa8d95cff2_end%%");
        expect(r).toBeNull();
    });

    it("returns null for a bare pair of backticks", async () => {
        const r = await locate(BODY, "``");
        expect(r).toBeNull();
    });

    it("returns null for lone highlight markers", async () => {
        expect(await locate(BODY, "==")).toBeNull();
        expect(await locate(BODY, "****")).toBeNull();
    });

    it("still locates ordinary text in the same note", async () => {
        const r = await locate(BODY, "cognitively superior");
        expect(r).not.toBeNull();
        expect(BODY.slice(r.start, r.end)).toContain("cognitively superior");
    });

    it("finishes quickly on a long unbroken token", async () => {
        const t0 = Date.now();
        await locate(BODY, "b3c8ca70-9f68-11ee-8263-33fa8d95cff2-and-more-hex-0123456789abcdef");
        expect(Date.now() - t0).toBeLessThan(3000);
    });

    it("still matches a long token that is genuinely present", async () => {
        const raw = BODY + "\n\nSee 9f68-11ee-8263 for details.";
        const r = await locate(raw, "9f68-11ee-8263");
        expect(r).not.toBeNull();
    });
});
