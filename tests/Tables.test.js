// Tables: a `==` pair must never span a `|`, escaped pipes are content rather
// than column boundaries, and only the cells the user selected get highlighted.
import { describe, it, expect } from "vitest";
import { setup, textNodes, highlightRange } from "./WritePath.test.js";

const raw = [
    "# Tabla",
    "",
    "| Ref | Fuente | Nota |",
    "| --- | --- | --- |",
    "| A1 | [[Nota\\|Alias]] | `a \\| b` |",
    "| A2 | Lorem ipsum | Dolor sit |",
].join("\n");

const html = [
    "<h1>Tabla</h1>",
    "<table><thead><tr><th>Ref</th><th>Fuente</th><th>Nota</th></tr></thead>",
    "<tbody>",
    "<tr><td>A1</td><td><a>Alias</a></td><td><code>a | b</code></td></tr>",
    "<tr><td>A2</td><td>Lorem ipsum</td><td>Dolor sit</td></tr>",
    "</tbody></table>",
].join("");

const cellOf = (ctx, row, col) => ctx.content.querySelectorAll("tr")[row].children[col];

async function highlightCells(ctx, from, to) {
    const a = textNodes(from);
    const b = textNodes(to);
    await highlightRange(ctx, a[0], 0, b[b.length - 1], b[b.length - 1].nodeValue.length);
}

const lineWith = (out, needle) => out.split("\n").find((l) => l.includes(needle));

describe("table cells", () => {
    it("highlights just the selected cell", async () => {
        const ctx = await setup(raw, html);
        const cell = cellOf(ctx, 2, 1);
        await highlightCells(ctx, cell, cell);
        expect(lineWith(ctx.out(), "A2")).toBe("| A2 | ==Lorem ipsum== | Dolor sit |");
    });

    it("never lets a highlight span a column boundary", async () => {
        const ctx = await setup(raw, html);
        await highlightCells(ctx, cellOf(ctx, 2, 0), cellOf(ctx, 2, 2));
        expect(lineWith(ctx.out(), "A2")).toBe("| ==A2== | ==Lorem ipsum== | ==Dolor sit== |");
    });

    it("highlights a header row cell by cell", async () => {
        const ctx = await setup(raw, html);
        await highlightCells(ctx, cellOf(ctx, 0, 0), cellOf(ctx, 0, 2));
        expect(lineWith(ctx.out(), "Ref")).toBe("| ==Ref== | ==Fuente== | ==Nota== |");
    });

    it("treats an escaped pipe as content, not a column boundary", async () => {
        const ctx = await setup(raw, html);
        await highlightCells(ctx, cellOf(ctx, 1, 0), cellOf(ctx, 1, 2));
        const line = lineWith(ctx.out(), "A1");
        expect(line).toBe("| ==A1== | ==[[Nota\\|Alias]]== | ==`a \\| b`== |");
        expect(line).not.toContain("\\==|");
    });

    it("leaves the delimiter row untouched", async () => {
        const ctx = await setup(raw, html);
        await highlightCells(ctx, cellOf(ctx, 0, 0), cellOf(ctx, 2, 2));
        expect(ctx.out().split("\n")[3]).toBe("| --- | --- | --- |");
    });

    it("keeps the pipe count of every line", async () => {
        const ctx = await setup(raw, html);
        await highlightCells(ctx, cellOf(ctx, 0, 0), cellOf(ctx, 2, 2));
        const pipes = (s) => (s.match(/(?<!\\)\|/g) || []).length;
        raw.split("\n").forEach((l, i) => expect(pipes(ctx.out().split("\n")[i])).toBe(pipes(l)));
    });

    it("does not drag in a neighbouring cell", async () => {
        const ctx = await setup(raw, html);
        const cell = cellOf(ctx, 2, 2);
        await highlightCells(ctx, cell, cell);
        expect(lineWith(ctx.out(), "A2")).toBe("| A2 | Lorem ipsum | ==Dolor sit== |");
    });
});
