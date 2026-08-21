import { describe, it, expect } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { FloatingManager } from "../src/ui/FloatingManager";
import { Platform } from "./obsidian-stub.js";
import { createObsidianWindow } from "./dom-helpers.js";
import { JSDOM } from "jsdom";

async function setup(opts = {}) {
    const window = createObsidianWindow();
    const doc = window.document;
    const content = doc.getElementById("content");
    content.innerHTML = "<p>Some text to select in reading view.</p>";
    let mode = opts.mode || "preview";
    const view = {
        file: { path: "n.md" },
        contentEl: content,
        containerEl: content,
        getMode: () => mode,
        getViewType: () => "markdown",
    };
    const app = {
        vault: { read: async () => "", modify: async () => {}, getAbstractFileByPath: () => null },
        metadataCache: { getFileCache: () => ({ embeds: [] }) },
        workspace: { getActiveViewOfType: () => (opts.noView ? null : view), on: () => {}, off: () => {} },
    };
    const plugin = new ReadingHighlighterPlugin(app, { id: "t", version: "0" });
    await plugin.loadSettings();
    plugin.floatingManager = new FloatingManager(plugin);
    plugin.registerDomEvent(doc, "selectionchange", () => plugin.floatingManager.handleSelection());
    plugin.floatingManager.load();
    return { window, doc, content, plugin, setMode: (m) => (mode = m) };
}
function select(ctx, fire = true) {
    const node = ctx.content.querySelector("p").firstChild;
    const range = ctx.doc.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 9);
    const sel = ctx.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (fire) ctx.doc.dispatchEvent(new ctx.window.Event("selectionchange"));
}
const visible = (ctx) => {
    const el = ctx.plugin.floatingManager.containerEl;
    return !!el && el.isConnected && el.style.display === "flex";
};

describe("scenarios", () => {
    it("A: refresh while toolbar is visible, then re-select", async () => {
        const ctx = await setup();
        select(ctx);
        expect(visible(ctx)).toBe(true);
        ctx.plugin.settings.enableColorPalette = true;
        await ctx.plugin.saveSettings();
        select(ctx);
        expect(visible(ctx)).toBe(true);
    });

    it("B: a rebuild leaves the toolbar hidden until the next selection", async () => {
        const ctx = await setup();
        select(ctx);
        expect(visible(ctx)).toBe(true);

        ctx.plugin.settings.enableColorPalette = true;
        await ctx.plugin.saveSettings();

        // Settings are changed from the settings window, so showing the toolbar
        // at this moment would put it on top of the settings rather than in a
        // note. It stays hidden, in the right document, ready for the next
        // selection.
        expect(visible(ctx)).toBe(false);
        expect(ctx.plugin.floatingManager.containerEl.isConnected).toBe(true);
        select(ctx);
        expect(visible(ctx)).toBe(true);
    });

    it("C: settings toggled while no reading view is active, then back to note", async () => {
        const ctx = await setup({ mode: "source" });
        ctx.plugin.settings.enableColorPalette = true;
        await ctx.plugin.saveSettings();
        ctx.setMode("preview");
        select(ctx);
        expect(visible(ctx)).toBe(true);
    });

    it("D: mobile platform behaves the same", async () => {
        Platform.isMobile = true;
        try {
            const ctx = await setup();
            select(ctx);
            expect(visible(ctx)).toBe(true);
            ctx.plugin.settings.enableColorPalette = true;
            await ctx.plugin.saveSettings();
            select(ctx);
            expect(visible(ctx)).toBe(true);
        } finally {
            Platform.isMobile = false;
        }
    });

    it("F: a settings change from the settings dialog does not float the toolbar over it", async () => {
        const ctx = await setup();
        select(ctx);
        expect(visible(ctx)).toBe(true);

        // Opening the settings dialog leaves the note's selection live behind it.
        const modal = ctx.doc.createElement("div");
        modal.className = "modal-container";
        ctx.doc.body.appendChild(modal);
        ctx.plugin.floatingManager.hide();

        ctx.plugin.settings.enableColorPalette = true;
        await ctx.plugin.saveSettings();
        expect(visible(ctx)).toBe(false);

        // Closing it and re-selecting brings the toolbar back.
        modal.remove();
        select(ctx);
        expect(visible(ctx)).toBe(true);
    });

    it("G: never shows while a dialog is open, even on a fresh selection", async () => {
        const ctx = await setup();
        const modal = ctx.doc.createElement("div");
        modal.className = "modal-container";
        ctx.doc.body.appendChild(modal);
        select(ctx);
        expect(visible(ctx)).toBe(false);
        modal.remove();
    });

    it("H: a settings change made from a separate window leaves the toolbar in the note's window", async () => {
        const ctx = await setup();
        select(ctx);
        expect(visible(ctx)).toBe(true);
        const noteDoc = ctx.doc;

        // Obsidian 1.13 opens preferences as its own OS window, and
        // `activeDocument` follows focus.
        const settingsWindow = new JSDOM("<!doctype html><html><body></body></html>").window;
        const previous = globalThis.activeDocument;
        globalThis.activeDocument = settingsWindow.document;
        try {
            ctx.plugin.settings.enableColorPalette = true;
            await ctx.plugin.saveSettings();
        } finally {
            globalThis.activeDocument = previous;
        }

        // Nothing may be built into the settings window...
        expect(settingsWindow.document.querySelectorAll(".reading-highlighter-float-container")).toHaveLength(0);
        // ...and the note's window keeps exactly one, hidden until reselection.
        expect(noteDoc.querySelectorAll(".reading-highlighter-float-container")).toHaveLength(1);
        expect(ctx.plugin.floatingManager.containerEl.ownerDocument).toBe(noteDoc);
        expect(visible(ctx)).toBe(false);

        // Back in the note, selecting brings it up again.
        select(ctx);
        expect(visible(ctx)).toBe(true);
    });

    it("E: many rapid refreshes (typing a meaning) leave a working toolbar", async () => {
        const ctx = await setup();
        ctx.plugin.settings.enableColorPalette = true;
        for (let i = 0; i < 10; i++) await ctx.plugin.saveSettings();
        select(ctx);
        expect(ctx.doc.querySelectorAll(".reading-highlighter-float-container")).toHaveLength(1);
        expect(visible(ctx)).toBe(true);
    });
});
