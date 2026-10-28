// Highlights in Obsidian's native colours (`==🟡text==`) through the real
// write path: the plugin must never write HTML, and the colour emoji in the
// source must never stop a selection from being found.
import { describe, it, expect } from "vitest";
import { setup, textNodes } from "./WritePath.test.js";
import { SelectionLogic } from "../src/core/SelectionLogic";
import { TFile } from "./obsidian-stub.js";

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

async function colour(ctx, color, from, to = from) {
    await ctx.plugin.applyColorHighlight(ctx.view, color, "", rangeBetween(ctx, from, to));
}

async function plain(ctx, from, to = from) {
    await ctx.plugin.highlightSelection(ctx.view, rangeBetween(ctx, from, to));
}

async function erase(ctx, from, to = from) {
    await ctx.plugin.removeHighlightSelection(ctx.view, rangeBetween(ctx, from, to));
}

describe("writing a colour", () => {
    const raw = "Uno dos tres. Cuatro cinco seis.";
    const html = "<p>Uno dos tres. Cuatro cinco seis.</p>";

    it("writes the native colour, not HTML", async () => {
        const ctx = await setup(raw, html);
        await colour(ctx, "yellow", "Cuatro", "seis.");
        expect(ctx.out()).toBe("Uno dos tres. ==🟡Cuatro cinco seis.==");
        expect(ctx.out()).not.toContain("<mark");
    });

    it("writes the default colour from settings with the plain button", async () => {
        const ctx = await setup(raw, html);
        ctx.plugin.settings.defaultHighlightColor = "green";
        await plain(ctx, "Uno", "tres.");
        expect(ctx.out()).toBe("==🟢Uno dos tres.== Cuatro cinco seis.");
    });

    it("writes a plain highlight when no default colour is set", async () => {
        const ctx = await setup(raw, html);
        await plain(ctx, "Uno", "tres.");
        expect(ctx.out()).toBe("==Uno dos tres.== Cuatro cinco seis.");
    });
});

describe("an existing coloured highlight", () => {
    const raw = "Antes del texto. ==🟡Uno dos tres.== Cuatro cinco seis.";
    const html = '<p>Antes del texto. <mark data-highlight="yellow">Uno dos tres.</mark> Cuatro cinco seis.</p>';

    it("keeps its colour when extended with the plain button", async () => {
        const ctx = await setup(raw, html);
        await plain(ctx, "dos", "cinco seis.");
        expect(ctx.out()).toBe("Antes del texto. ==🟡Uno dos tres. Cuatro cinco seis.==");
    });

    it("is found by a selection that starts before it", async () => {
        const ctx = await setup(raw, html);
        await plain(ctx, "del texto.", "dos");
        expect(ctx.out()).toBe("Antes ==🟡del texto. Uno dos tres.== Cuatro cinco seis.");
    });

    it("takes the new colour from a colour button", async () => {
        const ctx = await setup(raw, html);
        await colour(ctx, "red", "dos");
        expect(ctx.out()).toBe("Antes del texto. ==🔴Uno dos tres.== Cuatro cinco seis.");
    });

    it("loses its emoji with its markers when erased", async () => {
        const ctx = await setup(raw, html);
        await erase(ctx, "dos");
        expect(ctx.out()).toBe("Antes del texto. Uno dos tres. Cuatro cinco seis.");
    });

    it("is left alone by a highlight elsewhere in the paragraph", async () => {
        const ctx = await setup(raw, html);
        await colour(ctx, "blue", "Cuatro", "seis.");
        expect(ctx.out()).toBe("Antes del texto. ==🟡Uno dos tres.== ==🔵Cuatro cinco seis.==");
    });
});

describe("tagging a coloured highlight", () => {
    it("keeps the colour", async () => {
        const raw = "==🟣Uno dos.== Tres.";
        const ctx = await setup(raw, '<p><mark data-highlight="purple">Uno dos.</mark> Tres.</p>');
        const parsed = await ctx.plugin.app.vault.read();
        const start = parsed.indexOf("Uno");
        await ctx.plugin.applyMarkdownModification(ctx.view.file, "", start, start + "Uno dos.".length, "tag", "idea");
        expect(ctx.out()).toBe("#idea ==🟣Uno dos.== Tres.");
    });
});

describe("colours across lines and cells", () => {
    it("colours each line of a multi-paragraph selection", async () => {
        const raw = "Primer párrafo.\n\nSegundo párrafo.";
        const ctx = await setup(raw, "<p>Primer párrafo.</p><p>Segundo párrafo.</p>");
        await colour(ctx, "orange", "Primer", "Segundo párrafo.");
        expect(ctx.out()).toBe("==🟠Primer párrafo.==\n\n==🟠Segundo párrafo.==");
    });

    it("colours each selected table cell", async () => {
        const raw = "| A | B |\n| --- | --- |\n| uno | dos |";
        const html =
            "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>uno</td><td>dos</td></tr></tbody></table>";
        const ctx = await setup(raw, html);
        await colour(ctx, "green", "uno", "dos");
        expect(ctx.out().split("\n")[2]).toBe("| ==🟢uno== | ==🟢dos== |");
    });
});

describe("an old HTML highlight under a new one", () => {
    it("becomes native", async () => {
        const raw = 'Uno <mark style="background: #FFCDD2; color: black;">dos tres</mark> cuatro.';
        const ctx = await setup(raw, "<p>Uno <mark>dos tres</mark> cuatro.</p>");
        await colour(ctx, "red", "dos", "cuatro.");
        expect(ctx.out()).toBe("Uno ==🔴dos tres cuatro.==");
    });
});

describe("the matcher's view of the source", () => {
    const filtered = (text) => {
        const logic = new SelectionLogic({}, () => []);
        const file = new TFile("note.md");
        return logic.applyStructuralFilter({ text, segments: [{ vStart: 0, vEnd: text.length, file, pOffset: 0 }] })
            .text;
    };

    it("never contains the colour emoji of an opening marker", () => {
        expect(filtered("Antes ==🟡Uno dos.== y ==🔵tres==.")).toBe("Antes Uno dos. y tres.");
    });

    it("keeps an emoji after a closing marker, which Reading view shows", () => {
        expect(filtered("==uno==🔴 dos")).toBe("uno🔴 dos");
    });

    it("pairs markers line by line", () => {
        // The unclosed `==a` is text. (Obsidian itself would pair the first
        // marker with the last across the soft line break; highlights are read
        // one line at a time here, as they always have been.)
        expect(filtered("==a\n==🟢b==")).toBe("==a\nb");
    });

    it("maps offsets back past the emoji", async () => {
        const logic = new SelectionLogic({}, () => []);
        const file = new TFile("note.md");
        const text = "Antes ==🟡Uno dos.==";
        const virtual = logic.applyStructuralFilter({
            text,
            segments: [{ vStart: 0, vEnd: text.length, file, pOffset: 0 }],
        });
        const v = virtual.text.indexOf("Uno");
        const physical = logic.mapVirtualToPhysical(v, v + 3, virtual.segments);
        expect(text.slice(physical.start, physical.end)).toBe("Uno");
    });
});
