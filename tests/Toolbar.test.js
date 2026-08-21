// Issue 2: toggling a setting rebuilds the floating toolbar. It must still
// appear on the next selection, without restarting Obsidian.
import { describe, it, expect } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { FloatingManager } from "../src/ui/FloatingManager";
import { createObsidianWindow } from "./dom-helpers.js";

async function setup() {
    const window = createObsidianWindow();
    const doc = window.document;
    const content = doc.getElementById("content");
    content.innerHTML = "<p>Some text to select in reading view.</p>";

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
    return !!el && el.isConnected && el.style.display === "flex";
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
