// Issues 3 and 4: where the `==` markers actually land.
import { describe, it, expect } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { SelectionLogic } from "../src/core/SelectionLogic";
import { TFile } from "./obsidian-stub.js";
import { createObsidianWindow } from "./dom-helpers.js";

export async function setup(raw, html) {
    const window = createObsidianWindow();
    const doc = window.document;
    const content = doc.getElementById("content");
    content.innerHTML = html;

    const file = new TFile("note.md");
    let current = raw;
    const view = {
        file,
        contentEl: content,
        containerEl: content,
        getMode: () => "preview",
        getViewType: () => "markdown",
    };
    const app = {
        vault: {
            read: async () => current,
            modify: async (_f, c) => {
                current = c;
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
    return { window, doc, content, plugin, view, out: () => current };
}

/** Text nodes of the rendered container, in document order. */
export function textNodes(root) {
    const out = [];
    const walk = (n) => {
        if (n.nodeType === 3) out.push(n);
        else for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return out;
}

export async function highlightRange(ctx, startNode, startOff, endNode, endOff) {
    const range = ctx.doc.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const sel = ctx.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    await ctx.plugin.highlightSelection(ctx.view, { text: range.toString(), range });
}

describe("issue 3: list marker must stay outside the highlight", () => {
    const raw = [
        "# Título",
        "",
        "Párrafo introductorio del artículo.",
        "",
        "- La novela *Primera* (2023), del autor regional.",
        "- Segundo elemento de la lista.",
        "",
        "Párrafo final.",
    ].join("\n");
    const html = [
        "<h1>Título</h1>",
        "<p>Párrafo introductorio del artículo.</p>",
        "<ul><li>La novela <em>Primera</em> (2023), del autor regional.</li>",
        "<li>Segundo elemento de la lista.</li></ul>",
        "<p>Párrafo final.</p>",
    ].join("");

    it("selecting one bullet keeps the marker outside", async () => {
        const ctx = await setup(raw, html);
        const li = ctx.content.querySelectorAll("li")[0];
        const nodes = textNodes(li);
        await highlightRange(ctx, nodes[0], 0, nodes[nodes.length - 1], nodes[nodes.length - 1].nodeValue.length);
        expect(ctx.out()).toContain("- ==La novela *Primera* (2023), del autor regional.==");
        expect(ctx.out()).not.toContain("==- ");
    });

    it("selecting the whole article keeps every marker outside", async () => {
        const ctx = await setup(raw, html);
        const nodes = textNodes(ctx.content);
        const last = nodes[nodes.length - 1];
        await highlightRange(ctx, nodes[0], 0, last, last.nodeValue.length);
        expect(ctx.out()).not.toContain("==- ");
        expect(ctx.out()).not.toContain("==# ");
    });
});

describe("issue 4: extending an existing highlight", () => {
    const raw =
        "==Nació en el norte, en el occidente del país.[^4] Era un miembro del primer grupo, como su esposa.== Su segundo nombre procedió de un comerciante lejano.";
    const html =
        "<p><mark>Nació en el norte, en el occidente del país.<sup>1</sup> Era un miembro del primer grupo, como su esposa.</mark> Su segundo nombre procedió de un comerciante lejano.</p>";

    it("merges into one highlight ending after the final period", async () => {
        const ctx = await setup(raw, html);
        const nodes = textNodes(ctx.content);
        // Start inside the existing highlight, at "Era un miembro…"
        const inner = nodes.find((n) => n.nodeValue.includes("Era un miembro"));
        const startOff = inner.nodeValue.indexOf("Era un miembro");
        const last = nodes[nodes.length - 1];
        await highlightRange(ctx, inner, startOff, last, last.nodeValue.length);

        const out = ctx.out();
        // Exactly one highlight, spanning the whole paragraph, period included.
        expect((out.match(/==/g) || []).length).toBe(2);
        expect(out.startsWith("==Nació")).toBe(true);
        expect(out.trimEnd().endsWith("lejano.==")).toBe(true);
    });
});
