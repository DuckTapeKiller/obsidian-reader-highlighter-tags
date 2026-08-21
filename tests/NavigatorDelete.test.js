// Issue 1: the navigator's per-highlight menu must be able to delete just that
// highlight, leaving its text and every other highlight untouched.
import { describe, it, expect } from "vitest";
import { HighlightNavigatorView } from "../src/views/HighlightNavigator";
import { parseHighlights } from "../src/utils/highlights";
import { createObsidianWindow } from "./dom-helpers.js";

createObsidianWindow();

function harness(raw) {
    let current = raw;
    const refreshed = [];
    const ctx = {
        currentFile: { path: "n.md" },
        plugin: { saveUndoState: async () => {} },
        app: {
            vault: {
                process: async (_f, fn) => {
                    current = fn(current);
                    return current;
                },
            },
        },
        refresh: async () => refreshed.push(true),
    };
    return { ctx, out: () => current, refreshed };
}

const removeSingle = HighlightNavigatorView.prototype.removeSingleHighlight;

describe("remove a single highlight from the navigator", () => {
    it("removes only the chosen highlight, keeping its text", async () => {
        const raw = "Alpha ==one== beta ==two== gamma.";
        const { ctx, out } = harness(raw);
        const target = parseHighlights(raw).highlights[1];
        await removeSingle.call(ctx, target);
        expect(out()).toBe("Alpha ==one== beta two gamma.");
    });

    it("removes the first when the first is chosen", async () => {
        const raw = "Alpha ==one== beta ==two== gamma.";
        const { ctx, out } = harness(raw);
        await removeSingle.call(ctx, parseHighlights(raw).highlights[0]);
        expect(out()).toBe("Alpha one beta ==two== gamma.");
    });

    it("handles an <mark> highlight too", async () => {
        const raw = 'Start <mark style="background: #ff0; color: black;">inner</mark> end.';
        const { ctx, out } = harness(raw);
        await removeSingle.call(ctx, parseHighlights(raw).highlights[0]);
        expect(out()).toBe("Start inner end.");
    });

    it("leaves the note alone when the highlight has since moved", async () => {
        const raw = "Alpha ==one== beta.";
        const target = parseHighlights(raw).highlights[0];
        const { ctx, out } = harness("Completely different text.");
        await removeSingle.call(ctx, target);
        expect(out()).toBe("Completely different text.");
    });

    it("refreshes the panel afterwards", async () => {
        const raw = "Alpha ==one== beta.";
        const { ctx, refreshed } = harness(raw);
        await removeSingle.call(ctx, parseHighlights(raw).highlights[0]);
        expect(refreshed).toHaveLength(1);
    });
});
