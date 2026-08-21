// The reported bug, end to end through the real plugin: a paragraph split by
// soft line breaks renders as one <p>, so both `apple`s share a block element
// and a context string. Selecting the second must highlight the second.
import { describe, it, expect } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { SelectionLogic } from "../src/core/SelectionLogic";
import { TFile } from "./obsidian-stub.js";
import { createObsidianWindow } from "./dom-helpers.js";

async function setup(raw, html) {
    const window = createObsidianWindow();
    const doc = window.document;
    const container = doc.getElementById("content");
    container.innerHTML = html;

    const file = new TFile("note.md");
    let current = raw;
    const view = { file, contentEl: container, containerEl: container, getMode: () => "preview" };
    const app = {
        vault: {
            read: async () => current,
            modify: async (_f, content) => {
                current = content;
            },
            getAbstractFileByPath: () => null,
        },
        metadataCache: { getFileCache: () => ({ embeds: [] }) },
        fileManager: { processFrontMatter: async () => {} },
        workspace: { getActiveViewOfType: () => view, on: () => {}, off: () => {} },
    };

    const plugin = new ReadingHighlighterPlugin(app, { id: "t", version: "0" });
    await plugin.loadSettings();
    plugin.settings.enableSmartParagraphSelection = false;
    plugin.settings.enableColorHighlighting = false;
    plugin.settings.enableFrontmatterTag = false;
    plugin.settings.enableHaptics = false;
    plugin.settings.defaultTagPrefix = "";
    plugin.settings.learnedNormRules = [];
    plugin.logic = new SelectionLogic(app, () => []);
    return { window, doc, container, plugin, view, output: () => current };
}

/** Select `term` inside `node`, starting at `from`, as a real DOM Range. */
async function highlight(ctx, node, from, term) {
    const range = ctx.doc.createRange();
    range.setStart(node, from);
    range.setEnd(node, from + term.length);
    const selection = ctx.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await ctx.plugin.highlightSelection(ctx.view, { text: range.toString(), range });
}

describe("selecting a repeated word in one block", () => {
    const raw = "The apple is red.\nI ate an apple today.";
    const html = "<p>The apple is red.<br>I ate an apple today.</p>";

    it("highlights the first occurrence when the first is selected", async () => {
        const ctx = await setup(raw, html);
        const first = ctx.container.querySelector("p").firstChild;
        await highlight(ctx, first, 4, "apple");
        expect(ctx.output()).toBe("The ==apple== is red.\nI ate an apple today.");
    });

    it("highlights the second occurrence when the second is selected", async () => {
        const ctx = await setup(raw, html);
        const second = ctx.container.querySelector("p").lastChild;
        await highlight(ctx, second, 9, "apple");
        expect(ctx.output()).toBe("The apple is red.\nI ate an ==apple== today.");
    });
});

describe("selecting a word repeated across separate paragraphs", () => {
    const raw = "Alpha apple beta.\n\nGamma apple delta.";
    const html = "<p>Alpha apple beta.</p><p>Gamma apple delta.</p>";

    it("highlights the one in the paragraph that was clicked", async () => {
        const ctx = await setup(raw, html);
        const second = ctx.container.querySelectorAll("p")[1].firstChild;
        await highlight(ctx, second, 6, "apple");
        expect(ctx.output()).toBe("Alpha apple beta.\n\nGamma ==apple== delta.");
    });
});

describe("selecting inside identical duplicated paragraphs", () => {
    const raw = "Repeated apple line.\n\nFiller between.\n\nRepeated apple line.";
    const html = "<p>Repeated apple line.</p><p>Filler between.</p><p>Repeated apple line.</p>";

    it("highlights the second copy when the second is clicked", async () => {
        const ctx = await setup(raw, html);
        const third = ctx.container.querySelectorAll("p")[2].firstChild;
        await highlight(ctx, third, 9, "apple");
        expect(ctx.output()).toBe("Repeated apple line.\n\nFiller between.\n\nRepeated ==apple== line.");
    });
});
