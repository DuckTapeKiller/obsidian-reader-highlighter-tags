// Issue 3: selecting a whole article. A note mixing headings, lists, footnotes
// and existing highlights cannot be matched as one giant snippet, so it is
// highlighted block by block.
import { describe, it, expect } from "vitest";
import { setup, textNodes, highlightRange } from "./WritePath.test.js";

const raw = [
    "---",
    "tags:",
    "  - x",
    "---",
    "",
    "## Biografía",
    "",
    "==Nació en la región del norte, en el occidente del país.[^4] Era del grupo.==",
    "",
    "El pueblo del norte no era favorecido por los comerciantes.[^1] Era común entre ellos.",
    "",
    "### En la cultura",
    "",
    "- La novela *Segunda parte* (1991), del autor del sur.",
    "- La novela *Primera*... *las alas del viento* (2023), del autor regional.",
    "",
    "Párrafo final del artículo.",
].join("\n");

const html = [
    "<h2>Biografía</h2>",
    "<p><mark>Nació en la región del norte, en el occidente del país.<sup>1</sup> Era del grupo.</mark></p>",
    "<p>El pueblo del norte no era favorecido por los comerciantes.<sup>2</sup> Era común entre ellos.</p>",
    "<h3>En la cultura</h3>",
    "<ul><li>La novela <em>Segunda parte</em> (1991), del autor del sur.</li>",
    "<li>La novela <em>Primera</em>... <em>las alas del viento</em> (2023), del autor regional.</li></ul>",
    "<p>Párrafo final del artículo.</p>",
].join("");

async function selectEverything(ctx) {
    const nodes = textNodes(ctx.content);
    const last = nodes[nodes.length - 1];
    await highlightRange(ctx, nodes[0], 0, last, last.nodeValue.length);
}

describe("highlighting an entire article", () => {
    it("writes something rather than failing to locate", async () => {
        const ctx = await setup(raw, html);
        await selectEverything(ctx);
        expect(ctx.out()).not.toBe(raw);
    });

    it("never puts the opening marker before a list bullet", async () => {
        const ctx = await setup(raw, html);
        await selectEverything(ctx);
        for (const line of ctx.out().split("\n")) {
            expect(line).not.toMatch(/^[ \t]*==[ \t]*[-*+][ \t]/);
        }
        expect(ctx.out()).toContain("- ==La novela *Primera*");
    });

    it("never puts the opening marker before a heading hash", async () => {
        const ctx = await setup(raw, html);
        await selectEverything(ctx);
        for (const line of ctx.out().split("\n")) {
            expect(line).not.toMatch(/^[ \t]*==[ \t]*#/);
        }
        expect(ctx.out()).toContain("## ==Biografía==");
    });

    it("leaves balanced markers", async () => {
        const ctx = await setup(raw, html);
        await selectEverything(ctx);
        expect((ctx.out().match(/==/g) || []).length % 2).toBe(0);
    });

    it("does not disturb the frontmatter", async () => {
        const ctx = await setup(raw, html);
        await selectEverything(ctx);
        expect(ctx.out().startsWith("---\ntags:\n  - x\n---\n")).toBe(true);
    });

    it("highlights the already-highlighted paragraph exactly once", async () => {
        const ctx = await setup(raw, html);
        await selectEverything(ctx);
        const line = ctx
            .out()
            .split("\n")
            .find((l) => l.includes("Nació en la región"));
        expect((line.match(/==/g) || []).length).toBe(2);
    });
});
