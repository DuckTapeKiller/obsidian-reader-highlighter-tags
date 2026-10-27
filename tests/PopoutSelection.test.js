// A note in a popout window has a selection of its own. The toolbar must read
// that one, not the main window's.
import { describe, it, expect, vi } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { FloatingManager } from "../src/ui/FloatingManager";
import { createObsidianWindow, renderHtml } from "./dom-helpers.js";

async function setup({ inPopout }) {
    const mainWindow = createObsidianWindow();
    const popoutWindow = inPopout ? createObsidianWindow() : mainWindow;
    // The plugin's own `window` is always the main window.
    vi.stubGlobal("window", mainWindow);
    vi.stubGlobal("activeWindow", popoutWindow);
    vi.stubGlobal("activeDocument", popoutWindow.document);

    const doc = popoutWindow.document;
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
    plugin.registerDomEvent(doc, "selectionchange", () => plugin.floatingManager.handleSelection());
    plugin.floatingManager.load();
    return { mainWindow, popoutWindow, doc, content, plugin, view };
}

function selectText(ctx) {
    const node = ctx.content.querySelector("p").firstChild;
    const range = ctx.doc.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 9);
    const sel = ctx.popoutWindow.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ctx.doc.dispatchEvent(new ctx.popoutWindow.Event("selectionchange"));
}

const visible = (ctx) => {
    const el = ctx.plugin.floatingManager.containerEl;
    return !!el && el.isConnected && el.style.display === "flex";
};

describe("toolbar in a popout window", () => {
    it("shows for a selection made in the popout", async () => {
        const ctx = await setup({ inPopout: true });
        expect(ctx.mainWindow.getSelection().toString()).toBe("");
        selectText(ctx);
        expect(ctx.popoutWindow.getSelection().toString()).toBe("Some text");
        expect(visible(ctx)).toBe(true);
        expect(ctx.plugin.floatingManager.containerEl.ownerDocument).toBe(ctx.doc);
    });

    it("hides again when the popout selection is cleared", async () => {
        const ctx = await setup({ inPopout: true });
        selectText(ctx);
        expect(visible(ctx)).toBe(true);
        ctx.popoutWindow.getSelection().removeAllRanges();
        ctx.doc.dispatchEvent(new ctx.popoutWindow.Event("selectionchange"));
        expect(visible(ctx)).toBe(false);
    });

    it("is not shown by a selection in the main window while the note is in a popout", async () => {
        const ctx = await setup({ inPopout: true });
        const mainDoc = ctx.mainWindow.document;
        const p = mainDoc.createElement("p");
        p.textContent = "Main window text";
        mainDoc.body.appendChild(p);
        const range = mainDoc.createRange();
        range.setStart(p.firstChild, 0);
        range.setEnd(p.firstChild, 4);
        ctx.mainWindow.getSelection().addRange(range);
        ctx.plugin.floatingManager.handleSelection();
        expect(visible(ctx)).toBe(false);
    });

    it("still shows in the main window as before", async () => {
        const ctx = await setup({ inPopout: false });
        selectText(ctx);
        expect(visible(ctx)).toBe(true);
    });

    it("reads the selection from the window holding the view", async () => {
        const ctx = await setup({ inPopout: true });
        selectText(ctx);
        expect(ctx.plugin.selectionFor(ctx.view)).toBe(ctx.popoutWindow.getSelection());
        expect(ctx.plugin.selectionFor(null)).toBe(ctx.mainWindow.getSelection());
    });
});
