// The notice offering to undo a change: it closes when its Undo is pressed,
// and only the latest change has one, so no Undo is left on screen that can
// no longer undo anything.
import { describe, it, expect, beforeEach } from "vitest";
import { setup, textNodes } from "./WritePath.test.js";
import { Notice } from "./obsidian-stub.js";

const raw = "Uno dos tres. Cuatro cinco seis.";
const html = "<p>Uno dos tres. Cuatro cinco seis.</p>";

function rangeOf(ctx, text) {
    const node = textNodes(ctx.content).find((n) => n.nodeValue.includes(text));
    const range = ctx.doc.createRange();
    range.setStart(node, node.nodeValue.indexOf(text));
    range.setEnd(node, node.nodeValue.indexOf(text) + text.length);
    return { text, range };
}

const undoButton = (notice) => notice.message.querySelector(".reading-highlighter-undo-btn");
const undoNotices = () => Notice.instances.filter((n) => undoButton(n));
const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

beforeEach(() => {
    Notice.instances.length = 0;
    Notice.messages.length = 0;
});

describe("the undo notice", () => {
    it("closes when its Undo is pressed, and the change is undone", async () => {
        const ctx = await setup(raw, html);
        await ctx.plugin.highlightSelection(ctx.view, rangeOf(ctx, "dos"));
        const [notice] = undoNotices();
        undoButton(notice).click();
        await flush();
        expect(notice.hidden).toBe(true);
        expect(ctx.out()).toBe(raw);
    });

    it("is replaced by the next change's, so an older Undo is never left on screen", async () => {
        const ctx = await setup(raw, html);
        await ctx.plugin.highlightSelection(ctx.view, rangeOf(ctx, "dos"));
        await ctx.plugin.highlightSelection(ctx.view, rangeOf(ctx, "cinco"));
        const [first, second] = undoNotices();
        expect(first.hidden).toBe(true);
        expect(second.hidden).toBe(false);
    });

    it("closes when the change is undone with the command instead", async () => {
        const ctx = await setup(raw, html);
        await ctx.plugin.highlightSelection(ctx.view, rangeOf(ctx, "dos"));
        const [notice] = undoNotices();
        await ctx.plugin.undoChange(ctx.plugin.undoHistory[ctx.plugin.undoHistory.length - 1]);
        expect(notice.hidden).toBe(true);
        expect(Notice.messages).not.toContain("Already undone.");
    });

    it("undoes the latest change, then the one before it, from successive notices", async () => {
        const ctx = await setup(raw, html);
        await ctx.plugin.highlightSelection(ctx.view, rangeOf(ctx, "dos"));
        await ctx.plugin.highlightSelection(ctx.view, rangeOf(ctx, "cinco"));
        undoButton(undoNotices()[1]).click();
        await flush();
        expect(ctx.out()).toBe("Uno ==dos== tres. Cuatro cinco seis.");
    });
});

describe("the plugin's notices", () => {
    it("are shown one at a time: each replaces the one before", async () => {
        const ctx = await setup(raw, html);
        await ctx.plugin.highlightSelection(ctx.view, rangeOf(ctx, "dos"));
        undoButton(undoNotices()[0]).click();
        await flush();
        const visible = Notice.instances.filter((n) => !n.hidden);
        expect(visible.map((n) => n.message.textContent)).toEqual(["Undone."]);
    });

    it("offer Undo for three seconds", async () => {
        const ctx = await setup(raw, html);
        await ctx.plugin.highlightSelection(ctx.view, rangeOf(ctx, "dos"));
        expect(undoNotices()[0].duration).toBe(3000);
    });
});
