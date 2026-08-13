import { describe, expect, it } from "vitest";
import { SelectionLogic } from "../src/core/SelectionLogic";

function createPipeline(source) {
    const file = { path: "selection-regression.md" };
    const app = {
        vault: {
            read: async () => source,
        },
        metadataCache: {
            getFileCache: () => ({ embeds: [] }),
        },
    };

    return {
        logic: new SelectionLogic(app),
        file,
        view: { file },
    };
}

describe("Selection resolution regressions", () => {
    it("distinguishes ASCII and CJK trailing punctuation before loose matching", async () => {
        const source = `这是一个中文句子.\n这是一个中文句子。\nThis is an English sentence.\nThis is an English sentence。`;
        const { logic, file, view } = createPipeline(source);

        const result = await logic.locateSelection(file, view, "这是一个中文句子。", null, 0);
        const expectedStart = source.indexOf("这是一个中文句子。");

        expect(result).not.toBeNull();
        expect(result.start).toBe(expectedStart);
        expect(result.end).toBe(expectedStart + "这是一个中文句子。".length);
    });

    it("uses the selected source block context instead of a global candidate index", async () => {
        const source = `这是一个中文句子.  1\n这是一个中文句子。  2\nThis is an English sentence.  3\nThis is an English sentence。4\n\n这是一个中文句子.5\n这是一个中文句子。6\nThis is an English sentence.7\nThis is an English sentence。8`;
        const { logic, file, view } = createPipeline(source);
        const secondBlock = source.split("\n\n")[1].replace(/\s+/g, " ").trim();
        const expectedStart = source.lastIndexOf("这是一个中文句子。");

        const result = await logic.locateSelection(file, view, "这是一个中文句子。", secondBlock, 0);

        expect(result).not.toBeNull();
        expect(result.start).toBe(expectedStart);
        expect(result.end).toBe(expectedStart + "这是一个中文句子。".length);
    });

    it("applies block occurrence indexes to matching blocks, not candidates inside a block", () => {
        const source = `Alpha target.\nBeta target.\n\nAlpha target.\nBeta target.`;
        const logic = new SelectionLogic({});
        const candidates = logic.findAllCandidates(source, "target.", 0);
        const secondBlockStart = source.indexOf("Alpha target.", source.indexOf("\n\n"));
        const expectedStart = source.indexOf("target.", secondBlockStart);

        const result = logic.resolveCandidates(candidates, source, "Alpha target. Beta target.", 1);

        expect(result).not.toBeNull();
        expect(result.start).toBeLessThanOrEqual(expectedStart);
        expect(result.end).toBeGreaterThan(expectedStart);
        expect(source.substring(result.start, result.end)).toContain("target.");
    });
});
