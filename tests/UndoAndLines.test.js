// Undo over several steps, a stray `==` that would swallow a new highlight,
// and a selection before a closing bracket at the end of a line.
import { describe, it, expect } from "vitest";
import { highlightMarkerPairs } from "../src/utils/colors";
import { setup, textNodes, highlightRange } from "./WritePath.test.js";

async function highlightWord(ctx, word, nth = 0) {
    let seen = 0;
    for (const n of textNodes(ctx.content)) {
        let from = 0;
        let i;
        while ((i = n.nodeValue.indexOf(word, from)) !== -1) {
            if (seen++ === nth) {
                await highlightRange(ctx, n, i, n, i + word.length);
                return ctx.out();
            }
            from = i + 1;
        }
    }
    throw new Error("word not found: " + word);
}

describe("a stray `==` before the selection", () => {
    it("is escaped so it cannot pair with the new highlight", async () => {
        const ctx = await setup("a ==b == c and more\n", "<p>a ==b == c and more</p>");
        const out = await highlightWord(ctx, "more");
        expect(out).toBe("a \\==b == c and ==more==\n");
        // Read as Obsidian reads it: one highlight, and it is "more".
        const line = out.split("\n")[0];
        expect(highlightMarkerPairs(line).map((p) => line.slice(p.openEnd, p.close))).toEqual(["more"]);
    });
    it("leaves a line without strays exactly as before", async () => {
        const ctx = await setup("a ==b== c and more\n", "<p>a <mark>b</mark> c and more</p>");
        expect(await highlightWord(ctx, "more")).toBe("a ==b== c and ==more==\n");
    });
});

describe("a selection before a closing bracket at the end of a line", () => {
    for (const [raw, html, expected] of [
        [
            "a (see this)\nNext line here\n",
            "<p>a (see this)<br>Next line here</p>",
            "a (see ==this)==\nNext line here\n",
        ],
        [
            "he said «this»\nNext line here\n",
            "<p>he said «this»<br>Next line here</p>",
            "he said ==«this»==\nNext line here\n",
        ],
    ]) {
        it(`highlights only its own line: ${JSON.stringify(raw.split("\n")[0])}`, async () => {
            const ctx = await setup(raw, html);
            expect(await highlightWord(ctx, "this")).toBe(expected);
        });
    }
});

describe("undo", () => {
    async function twoHighlights() {
        const raw = "One two three\n";
        const ctx = await setup(raw, "<p>One two three</p>");
        ctx.plugin.app.workspace.getActiveFile = () => ctx.view.file;
        await highlightWord(ctx, "One");
        const first = ctx.out();
        // The note re-renders with the first highlight.
        ctx.content.replaceChildren();
        const p = ctx.doc.createElement("p");
        const mark = ctx.doc.createElement("mark");
        mark.textContent = "One";
        p.append(mark, ctx.doc.createTextNode(" two three"));
        ctx.content.append(p);
        await highlightWord(ctx, "three");
        return { ctx, raw, first };
    }

    it("goes back one change at a time", async () => {
        const { ctx, raw, first } = await twoHighlights();
        expect(ctx.out()).toBe("==One== two ==three==\n");
        await ctx.plugin.undoLastHighlight();
        expect(ctx.out()).toBe(first);
        await ctx.plugin.undoLastHighlight();
        expect(ctx.out()).toBe(raw);
    });

    it("refuses once the note has been edited since", async () => {
        const { ctx } = await twoHighlights();
        await ctx.plugin.app.vault.modify(ctx.view.file, "edited by hand\n");
        await ctx.plugin.undoLastHighlight();
        expect(ctx.out()).toBe("edited by hand\n");
    });

    it("undoes the change a notice belongs to", async () => {
        const { ctx, first } = await twoHighlights();
        const latest = ctx.plugin.undoHistory[ctx.plugin.undoHistory.length - 1];
        await ctx.plugin.undoChange(latest);
        expect(ctx.out()).toBe(first);
        // A second press finds it already undone and changes nothing.
        await ctx.plugin.undoChange(latest);
        expect(ctx.out()).toBe(first);
    });
});
