// Issue 2: toggling a setting rebuilds the floating toolbar. It must still
// appear on the next selection, without restarting Obsidian.
import { describe, it, expect } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { FloatingManager } from "../src/ui/FloatingManager";
import { createObsidianWindow, renderHtml } from "./dom-helpers.js";

async function setup() {
    const window = createObsidianWindow();
    const doc = window.document;
    const content = doc.getElementById("content");
    renderHtml(content, "<p>Some text to select in reading view.</p>");

    const view = {
        file: { path: "n.md" },
        contentEl: content,
        containerEl: content,
        getMode: () => "preview",
        getViewType: () => "markdown",
    };
    const app = {
        vault: { read: async () => "", modify: async () => {}, getAbstractFileByPath: () => null },
        metadataCache: { getFileCache: () => ({ embeds: [] }) },
        workspace: { getActiveViewOfType: () => view, on: () => {}, off: () => {} },
    };
    const plugin = new ReadingHighlighterPlugin(app, { id: "t", version: "0" });
    await plugin.loadSettings();
    plugin.floatingManager = new FloatingManager(plugin);
    // Mirrors onload(): the selectionchange listener is registered once, on the
    // plugin, and must keep working across toolbar rebuilds.
    plugin.registerDomEvent(doc, "selectionchange", () => plugin.floatingManager.handleSelection());
    plugin.floatingManager.load();
    return { window, doc, content, plugin };
}

function selectText(ctx) {
    const node = ctx.content.querySelector("p").firstChild;
    const range = ctx.doc.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 9);
    const sel = ctx.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ctx.doc.dispatchEvent(new ctx.window.Event("selectionchange"));
}

const visible = (ctx) => {
    const el = ctx.plugin.floatingManager.containerEl;
    return !!el && el.isConnected && el.style.display !== "none";
};

describe("floating toolbar survives a settings change", () => {
    it("shows on selection before any settings change", async () => {
        const ctx = await setup();
        selectText(ctx);
        expect(visible(ctx)).toBe(true);
    });

    it("still shows after enabling the colour palette", async () => {
        const ctx = await setup();
        selectText(ctx);
        expect(visible(ctx)).toBe(true);

        ctx.plugin.settings.enableColorPalette = true;
        await ctx.plugin.saveSettings();

        selectText(ctx);
        expect(visible(ctx)).toBe(true);
    });

    it("leaves exactly one toolbar in the document after several changes", async () => {
        const ctx = await setup();
        for (const value of [true, false, true]) {
            ctx.plugin.settings.enableColorPalette = value;
            await ctx.plugin.saveSettings();
        }
        selectText(ctx);
        const all = ctx.doc.querySelectorAll(".reading-highlighter-float-container");
        expect(all).toHaveLength(1);
        expect(visible(ctx)).toBe(true);
    });
});

// The fixed places of "Toolbar position" are classes in styles.css; only
// "Next to text" writes top and left on the toolbar itself.
describe("toolbar position", () => {
    const positionClasses = (el) => [...el.classList].filter((cls) => cls.startsWith("reading-highlighter-pos-"));

    for (const position of ["top", "bottom", "left", "right"]) {
        it(`puts the toolbar in its fixed place: ${position}`, async () => {
            const ctx = await setup();
            ctx.plugin.settings.toolbarPosition = position;
            selectText(ctx);
            const el = ctx.plugin.floatingManager.containerEl;
            expect(visible(ctx)).toBe(true);
            expect(positionClasses(el)).toEqual([`reading-highlighter-pos-${position}`]);
            expect(el.hasClass("reading-highlighter-vertical")).toBe(position === "left" || position === "right");
            for (const side of ["top", "bottom", "left", "right", "transform"]) expect(el.style[side]).toBe("");
        });
    }

    it("next to text: no fixed place, top and left from the selection", async () => {
        const ctx = await setup();
        ctx.plugin.settings.toolbarPosition = "top";
        selectText(ctx);
        ctx.plugin.settings.toolbarPosition = "text";
        selectText(ctx);
        const el = ctx.plugin.floatingManager.containerEl;
        expect(visible(ctx)).toBe(true);
        expect(positionClasses(el)).toEqual([]);
        expect(el.style.top).toMatch(/px$/);
        expect(el.style.left).toMatch(/px$/);
    });

    it("hides with display none and shows again", async () => {
        const ctx = await setup();
        selectText(ctx);
        ctx.plugin.floatingManager.hide();
        expect(ctx.plugin.floatingManager.containerEl.style.display).toBe("none");
        selectText(ctx);
        expect(ctx.plugin.floatingManager.containerEl.style.display).toBe("");
    });
});
