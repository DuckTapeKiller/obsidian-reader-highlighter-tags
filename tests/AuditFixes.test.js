// Three ways a note could be damaged: a highlight written into a link's
// target, `==` that is not a highlight treated as one, and "remove all
// annotations" deleting every footnote in the note.
import { describe, it, expect } from "vitest";
import { highlightMarkerPairs } from "../src/utils/colors";
import { parseHighlights, removeAllHighlightsFromRaw } from "../src/utils/highlights";
import { setup, textNodes, highlightRange } from "./WritePath.test.js";

const marks = (line) => highlightMarkerPairs(line).map((p) => line.slice(p.openEnd, p.close));

describe("which `==` is a highlight", () => {
    it("follows Obsidian: markers touch the text they enclose", () => {
        expect(marks("x ==a== y")).toEqual(["a"]);
        expect(marks("a==b==c")).toEqual(["b"]);
        expect(marks("a ==b c ==d== e")).toEqual(["b c ==d"]);
        expect(marks("==🔴 x==")).toEqual([" x"]);
    });
    it("is never a comparison, code, an escape or the inside of a wikilink", () => {
        for (const line of [
            "if x == 1 or y == 2 then stop",
            "Use `a == b` and `c == d` in code.",
            "a ==b == c",
            "a == b== c",
            "a ==== b",
            "\\==not== this",
            "[[Note|a ==b== c]]",
        ]) {
            expect(marks(line)).toEqual([]);
        }
    });
    it("can enclose code that holds `==`", () => {
        expect(marks("==a `b == c` d==")).toEqual(["a `b == c` d"]);
    });
});

describe("removing every highlight", () => {
    it("leaves comparisons and code alone", () => {
        const raw = "if x == 1 or y == 2\n\nUse `a == b` and ==this==.\n";
        expect(removeAllHighlightsFromRaw(raw).raw).toBe("if x == 1 or y == 2\n\nUse `a == b` and this.\n");
        expect(removeAllHighlightsFromRaw(raw).removedCount).toBe(1);
    });
    it("lists only real highlights", () => {
        expect(parseHighlights("if x == 1 or y == 2 and ==z==").highlights.map((h) => h.text)).toEqual(["z"]);
    });
});

async function pick(raw, html, needle, nth = 0) {
    const ctx = await setup(raw, html);
    let seen = 0;
    for (const n of textNodes(ctx.content)) {
        let from = 0;
        let i;
        while ((i = n.nodeValue.indexOf(needle, from)) !== -1) {
            if (seen++ === nth) {
                await highlightRange(ctx, n, i, n, i + needle.length);
                return ctx.out();
            }
            from = i + 1;
        }
    }
    throw new Error("needle not found: " + needle);
}

describe("highlighting next to `==` that is text", () => {
    it("does not take in a comparison", async () => {
        const raw = "if x == 1 or y == 2 then stop\n";
        expect(await pick(raw, "<p>if x == 1 or y == 2 then stop</p>", "or")).toBe(
            "if x == 1 ==or== y == 2 then stop\n"
        );
    });
    it("does not touch code between two code spans", async () => {
        const raw = "Use `a == b` and `c == d` in code.\n";
        const html = "<p>Use <code>a == b</code> and <code>c == d</code> in code.</p>";
        expect(await pick(raw, html, "and")).toBe("Use `a == b` ==and== `c == d` in code.\n");
    });
    it("keeps the `==` of code inside a highlight", async () => {
        const raw = "Use `a == b` here and more\n";
        const html = "<p>Use <code>a == b</code> here and more</p>";
        const ctx = await setup(raw, html);
        const [use, , here] = textNodes(ctx.content);
        await highlightRange(ctx, use, 0, here, " here".length);
        expect(ctx.out()).toBe("==Use `a == b` here== and more\n");
    });
});

describe("highlighting inside a link", () => {
    const raw = [
        "- [[Tiempos#1. Presente de indicativo (CANTO)|1. Presente de indicativo (CANTO)]]",
        "",
        "#### 1. Presente de indicativo (CANTO)",
        "",
    ].join("\n");
    const html =
        '<ul><li><a class="internal-link" data-href="Tiempos#1. Presente de indicativo (CANTO)">1. Presente de indicativo (CANTO)</a></li></ul>' +
        "<h4>1. Presente de indicativo (CANTO)</h4>";

    it("never writes into the link's target", async () => {
        const out = await pick(raw, html, "indicativo", 0);
        expect(out.split("\n")[0]).toBe(
            "- ==[[Tiempos#1. Presente de indicativo (CANTO)|1. Presente de indicativo (CANTO)]]=="
        );
        expect(out.split("\n")[2]).toBe("#### 1. Presente de indicativo (CANTO)");
    });
    it("still highlights the heading when the heading is selected", async () => {
        const out = await pick(raw, html, "indicativo", 1);
        expect(out.split("\n")[0]).toBe(raw.split("\n")[0]);
        expect(out.split("\n")[2]).toBe("#### 1. Presente de ==indicativo== (CANTO)");
    });
    it("takes the whole link for a link without an alias", async () => {
        const out = await pick(
            "see [[Some note]] here\n",
            '<p>see <a class="internal-link">Some note</a> here</p>',
            "note"
        );
        expect(out).toBe("see ==[[Some note]]== here\n");
    });
});

describe("a paragraph straight under a heading", () => {
    it("is its own block, so the word is highlighted where it was selected", async () => {
        const raw =
            "#### 5. La mayúscula y los nombres propios\n   En general, se escriben con mayúscula los nombres propios.\n";
        const html =
            "<h4>5. La mayúscula y los nombres propios</h4><p>En general, se escriben con mayúscula los nombres propios.</p>";
        const ctx = await setup(raw, html);
        const node = textNodes(ctx.content.querySelector("p"))[0];
        const i = node.nodeValue.indexOf("nombres");
        await highlightRange(ctx, node, i, node, i + "nombres".length);
        expect(ctx.out()).toBe(
            "#### 5. La mayúscula y los nombres propios\n   En general, se escriben con mayúscula los ==nombres== propios.\n"
        );
    });
});

describe("the same word in several nested list items", () => {
    const raw = [
        "* Irreales:",
        "\t+ *Si me hubiera/hubiese tocado la lotería, me hubiera/hubiese/habría comprado un coche.*",
        "\t+ *Si fuera rico, le habría ayudado.*",
        "\t+ Además, en la lengua coloquial se aceptan casos como *Si lo sé, no vengo* (‘Si lo hubiera sabido, no hubiera venido’).",
        "",
    ].join("\n");
    const html =
        "<ul><li>Irreales:<ul>" +
        "<li><em>Si me hubiera/hubiese tocado la lotería, me hubiera/hubiese/habría comprado un coche.</em></li>" +
        "<li><em>Si fuera rico, le habría ayudado.</em></li>" +
        "<li>Además, en la lengua coloquial se aceptan casos como <em>Si lo sé, no vengo</em> (‘Si lo hubiera sabido, no hubiera venido’).</li>" +
        "</ul></li></ul>";
    const positions = [...raw.matchAll(/hubiera/g)].map((m) => m.index);

    for (let k = 0; k < 4; k++) {
        it(`highlights occurrence ${k + 1} of 4 where it was selected`, async () => {
            const ctx = await setup(raw, html);
            const hits = [];
            for (const n of textNodes(ctx.content)) {
                for (const m of n.nodeValue.matchAll(/hubiera/g)) hits.push([n, m.index]);
            }
            const [node, i] = hits[k];
            await highlightRange(ctx, node, i, node, i + "hubiera".length);
            const expected = raw.slice(0, positions[k]) + "==hubiera==" + raw.slice(positions[k] + "hubiera".length);
            expect(ctx.out()).toBe(expected);
        });
    }
});

describe("italics running across the lines of a poem", () => {
    const raw = [
        "> *Ojos claros, serenos,  ",
        "> si de un dulce mirar sois alabados,  ",
        "> ya que así me miráis, miradme al menos.*",
        "",
    ].join("\n");
    const html =
        "<blockquote><p><em>Ojos claros, serenos,<br>si de un dulce mirar sois alabados,<br>ya que así me miráis, miradme al menos.</em></p></blockquote>";

    it("keep their asterisks outside a highlight of the whole poem", async () => {
        const ctx = await setup(raw, html);
        const nodes = textNodes(ctx.content).filter((n) => n.nodeValue.trim());
        const last = nodes[nodes.length - 1];
        await highlightRange(ctx, nodes[0], 0, last, last.nodeValue.length);
        expect(ctx.out()).toBe(
            [
                "> *==Ojos claros, serenos,==  ",
                "> ==si de un dulce mirar sois alabados,==  ",
                "> ==ya que así me miráis, miradme al menos.==*",
                "",
            ].join("\n")
        );
    });

    it("keep their asterisk outside a highlight of the first word", async () => {
        const ctx = await setup(raw, html);
        const node = textNodes(ctx.content)[0];
        await highlightRange(ctx, node, 0, node, "Ojos".length);
        expect(ctx.out().split("\n")[0]).toBe("> *==Ojos== claros, serenos,  ");
    });
});

describe("an empty list item", () => {
    it("is left as it is when the lines around it are highlighted", async () => {
        const raw = "> Primera estrofa\n> \n> -\n> \n> Así el ingrato pueblo castellano\n";
        const html =
            "<blockquote><p>Primera estrofa</p><ul><li></li></ul><p>Así el ingrato pueblo castellano</p></blockquote>";
        const ctx = await setup(raw, html);
        const nodes = textNodes(ctx.content).filter((n) => n.nodeValue.trim());
        const last = nodes[nodes.length - 1];
        await highlightRange(ctx, nodes[0], 0, last, last.nodeValue.length);
        expect(ctx.out()).toBe("> ==Primera estrofa==\n> \n> -\n> \n> ==Así el ingrato pueblo castellano==\n");
    });
});

describe("a number at the start of a line that is not a list", () => {
    it("is highlighted when selected", async () => {
        const raw = "3.12. Sustantivos epicenos: la concordancia.\n";
        const ctx = await setup(raw, "<p>3.12. Sustantivos epicenos: la concordancia.</p>");
        const node = textNodes(ctx.content)[0];
        await highlightRange(ctx, node, 0, node, 1);
        expect(ctx.out()).toBe("==3.==12. Sustantivos epicenos: la concordancia.\n");
    });
    it("is still left out when it is a list marker", async () => {
        const raw = "1. Primer punto de la lista\n";
        const ctx = await setup(raw, "<ol><li>Primer punto de la lista</li></ol>");
        const node = textNodes(ctx.content)[0];
        await highlightRange(ctx, node, 0, node, node.nodeValue.length);
        expect(ctx.out()).toBe("1. ==Primer punto de la lista==\n");
    });
});

describe("a number followed by a no-break space", () => {
    it("is text, not a list marker, so it is highlighted", async () => {
        const raw = "1.\u00a0**Definición**\n";
        const ctx = await setup(raw, "<p>1.\u00a0<strong>Definición</strong></p>");
        const node = textNodes(ctx.content)[0];
        await highlightRange(ctx, node, 0, node, 1);
        expect(ctx.out()).toBe("==1.==\u00a0**Definición**\n");
    });
});

describe("a footnote that reads like a bibliography entry", () => {
    const entry = "Fleeman, M. (2003). Laci: Inside the Laci Peterson Murder. New York: St. Martin's Press.";
    const raw = `## Referencias\n\n- ${entry}\n\nTexto con nota.[^30]\n\n[^30]: ${entry}\n`;
    const html =
        `<h2>Referencias</h2><ul><li>${entry}</li></ul><p>Texto con nota.<sup><a>1</a></sup></p>` +
        `<section class="footnotes"><ol><li>${entry}<a class="footnote-backref">↩︎</a></li></ol></section>`;

    it("is highlighted in the footnote, where it was selected", async () => {
        const ctx = await setup(raw, html);
        const li = ctx.content.querySelector("section.footnotes li");
        const node = textNodes(li)[0];
        const i = node.nodeValue.indexOf("Laci");
        await highlightRange(ctx, node, i, node, i + 4);
        const lines = ctx.out().split("\n");
        expect(lines[2]).toBe(`- ${entry}`);
        expect(lines[6]).toBe(
            `[^30]: Fleeman, M. (2003). ==Laci:== Inside the Laci Peterson Murder. New York: St. Martin's Press.`
        );
    });
});

describe("two paragraphs of one quote", () => {
    it("are separate blocks, so a repeated word is highlighted in the paragraph it was selected in", async () => {
        const raw = "> a. Tras dos puntos se escribe minúscula.\n> \n> b. Un punto cierra la frase.\n";
        const html =
            "<blockquote><p>a. Tras dos puntos se escribe minúscula.</p><p>b. Un punto cierra la frase.</p></blockquote>";
        const ctx = await setup(raw, html);
        const p = ctx.content.querySelectorAll("p")[1];
        const node = textNodes(p)[0];
        const i = node.nodeValue.indexOf("punto");
        await highlightRange(ctx, node, i, node, i + "punto".length);
        expect(ctx.out()).toBe("> a. Tras dos puntos se escribe minúscula.\n> \n> b. Un ==punto== cierra la frase.\n");
    });
});

describe("a list inside a quote", () => {
    it("starts its own blocks, so a repeated word is highlighted in the item it was selected in", async () => {
        const raw = "> d. Después de dos puntos en los siguientes casos:\n>   - Tras un punto y aparte\n";
        const html =
            "<blockquote><p>d. Después de dos puntos en los siguientes casos:</p><ul><li>Tras un punto y aparte</li></ul></blockquote>";
        const ctx = await setup(raw, html);
        const node = textNodes(ctx.content.querySelector("li"))[0];
        const i = node.nodeValue.indexOf("punto");
        await highlightRange(ctx, node, i, node, i + "punto".length);
        expect(ctx.out()).toBe(
            "> d. Después de dos puntos en los siguientes casos:\n>   - Tras un ==punto== y aparte\n"
        );
    });
});
