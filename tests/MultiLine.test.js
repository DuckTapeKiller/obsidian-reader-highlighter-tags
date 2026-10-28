// A selection across lines highlights only what is selected on each line:
// from the middle of one paragraph to the middle of the next, the start of the
// first and the end of the last stay as they are.
import { describe, it, expect } from "vitest";
import { setup, textNodes } from "./WritePath.test.js";

/** Select from `startText` to `endText` (inclusive) in the rendered note. */
function rangeBetween(ctx, startText, endText) {
    const nodes = textNodes(ctx.content);
    const s = nodes.find((n) => n.nodeValue.includes(startText));
    const e = [...nodes].reverse().find((n) => n.nodeValue.includes(endText));
    const range = ctx.doc.createRange();
    range.setStart(s, s.nodeValue.indexOf(startText));
    range.setEnd(e, e.nodeValue.indexOf(endText) + endText.length);
    const sel = ctx.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return { text: range.toString(), range };
}

async function highlight(raw, html, from, to) {
    const ctx = await setup(raw, html);
    await ctx.plugin.highlightSelection(ctx.view, rangeBetween(ctx, from, to));
    return ctx.out();
}

describe("a selection across paragraphs", () => {
    it("highlights the end of the first and the start of the second", async () => {
        const out = await highlight(
            "Uno dos tres cuatro.\n\nCinco seis siete ocho.",
            "<p>Uno dos tres cuatro.</p><p>Cinco seis siete ocho.</p>",
            "tres",
            "seis"
        );
        expect(out).toBe("Uno dos ==tres cuatro.==\n\n==Cinco seis== siete ocho.");
    });

    it("highlights a paragraph in between whole", async () => {
        const out = await highlight(
            "Uno dos.\n\nTres cuatro.\n\nCinco seis.",
            "<p>Uno dos.</p><p>Tres cuatro.</p><p>Cinco seis.</p>",
            "dos",
            "Cinco"
        );
        expect(out).toBe("Uno ==dos.==\n\n==Tres cuatro.==\n\n==Cinco== seis.");
    });

    it("keeps the first paragraph whole when the selection starts at its first word", async () => {
        const out = await highlight(
            "Uno dos tres.\n\nCuatro cinco seis.",
            "<p>Uno dos tres.</p><p>Cuatro cinco seis.</p>",
            "Uno",
            "cinco"
        );
        expect(out).toBe("==Uno dos tres.==\n\n==Cuatro cinco== seis.");
    });

    it("leaves the formatting outside the selection intact", async () => {
        const out = await highlight(
            "Uno **dos tres** cuatro.\n\nCinco *seis siete* ocho.",
            "<p>Uno <strong>dos tres</strong> cuatro.</p><p>Cinco <em>seis siete</em> ocho.</p>",
            "tres",
            "seis"
        );
        expect(out).toBe("Uno **dos ==tres==** ==cuatro.==\n\n==Cinco== *==seis== siete* ocho.");
    });
});

describe("a note holding the same passage twice", () => {
    const raw = "Uno dos tres.\n\nCuatro cinco.\n\nUno dos tres.";
    const html = "<p>Uno dos tres.</p><p>Cuatro cinco.</p><p>Uno dos tres.</p>";

    it("finds the copy after a given point when asked to", async () => {
        const ctx = await setup(raw, html);
        const logic = ctx.plugin.logic;
        const first = await logic.locateSelection(
            ctx.view.file,
            ctx.view,
            "dos tres",
            "Uno dos tres.",
            0,
            null,
            "paragraph"
        );
        const later = await logic.locateSelection(
            ctx.view.file,
            ctx.view,
            "dos tres",
            "Uno dos tres.",
            0,
            null,
            "paragraph",
            {
                file: ctx.view.file,
                offset: raw.indexOf("Cuatro"),
            }
        );
        expect(first.start).toBe(raw.indexOf("dos tres"));
        expect(later.start).toBe(raw.lastIndexOf("dos tres"));
    });

    it("highlights nothing when the end is found before the start", async () => {
        const ctx = await setup(raw, html);
        // The end placed in the first copy, the start in the second: taking
        // the span between them would highlight what was never selected.
        const located = [
            { file: ctx.view.file, start: raw.lastIndexOf("Uno"), end: raw.length },
            { file: ctx.view.file, start: 0, end: 7 },
        ];
        ctx.plugin.locateBlockPortion = async () => located.shift() ?? null;
        // From the first paragraph into the second: the path across blocks.
        await ctx.plugin.highlightSelection(ctx.view, rangeBetween(ctx, "tres.", "Cuatro"));
        expect(ctx.out()).toBe(raw);
    });
});

describe("a colour across paragraphs", () => {
    it("colours only the selected part of each", async () => {
        const ctx = await setup(
            "Uno dos tres cuatro.\n\nCinco seis siete ocho.",
            "<p>Uno dos tres cuatro.</p><p>Cinco seis siete ocho.</p>"
        );
        await ctx.plugin.applyColorHighlight(ctx.view, "yellow", "", rangeBetween(ctx, "tres", "seis"));
        expect(ctx.out()).toBe("Uno dos ==🟡tres cuatro.==\n\n==🟡Cinco seis== siete ocho.");
    });
});

describe("a selection across lines of one block", () => {
    it("highlights only the selected part of each line of a paragraph", async () => {
        const out = await highlight(
            "Línea uno aquí\nlínea dos allá",
            "<p>Línea uno aquí<br>\nlínea dos allá</p>",
            "uno",
            "dos"
        );
        expect(out).toBe("Línea ==uno aquí==\n==línea dos== allá");
    });

    it("highlights only the selected part of each line of a list item", async () => {
        const out = await highlight(
            "- **Empresa | 2023**\n    *Traductor remoto*\n    Traduje un libro del inglés.\n- **Otra | 2022**\n    Escribí textos.",
            "<ul><li><strong>Empresa | 2023</strong><br>\n<em>Traductor remoto</em><br>\nTraduje un libro del inglés.</li>" +
                "<li><strong>Otra | 2022</strong><br>\nEscribí textos.</li></ul>",
            "un libro",
            "Escribí"
        );
        expect(out).toBe(
            "- **Empresa | 2023**\n    *Traductor remoto*\n    Traduje ==un libro del inglés.==\n- ==**Otra | 2022**==\n    ==Escribí== textos."
        );
    });

    it("starts inside the first line and ends inside the last, within one paragraph", async () => {
        const out = await highlight(
            "Uno dos tres\ncuatro cinco seis\nsiete ocho nueve",
            "<p>Uno dos tres<br>\ncuatro cinco seis<br>\nsiete ocho nueve</p>",
            "tres",
            "siete"
        );
        expect(out).toBe("Uno dos ==tres==\n==cuatro cinco seis==\n==siete== ocho nueve");
    });

    it("keeps list markers outside and leaves the rest of each item", async () => {
        const out = await highlight(
            "- alfa beta\n- gamma delta",
            "<ul><li>alfa beta</li><li>gamma delta</li></ul>",
            "beta",
            "gamma"
        );
        expect(out).toBe("- alfa ==beta==\n- ==gamma== delta");
    });

    it("keeps quote markers outside, across a quote's paragraphs", async () => {
        const out = await highlight(
            "> uno dos\n>\n> tres cuatro",
            "<blockquote><p>uno dos</p><p>tres cuatro</p></blockquote>",
            "dos",
            "tres"
        );
        expect(out).toBe("> uno ==dos==\n>\n> ==tres== cuatro");
    });

    it("runs from a heading into the paragraph under it", async () => {
        const out = await highlight(
            "## Título largo\n\nTexto aquí.",
            "<h2>Título largo</h2><p>Texto aquí.</p>",
            "largo",
            "Texto"
        );
        expect(out).toBe("## Título ==largo==\n\n==Texto== aquí.");
    });
});
