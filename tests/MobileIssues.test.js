// Issue 13: actions did nothing in notes with an embedded image, because the
// image was read as text, and a failure was silent. Issue 5: on Android the
// toolbar appeared while the selection was still being dragged.
import { describe, it, expect, vi, afterEach } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { SelectionLogic } from "../src/core/SelectionLogic";
import { FloatingManager } from "../src/ui/FloatingManager";
import { TFile, Notice, Platform } from "./obsidian-stub.js";
import { createObsidianWindow, renderHtml } from "./dom-helpers.js";

/**
 * A note embedding `target`, highlighted at `word` in the given paragraph.
 * `files` maps each embedded file to its text, or to a function that throws.
 */
async function highlightInNoteWithEmbed({ note, html, embed, files, paragraph, word }) {
    const window = createObsidianWindow();
    const doc = window.document;
    const content = doc.getElementById("content");
    renderHtml(content, html);
    const file = new TFile("note.md");
    const texts = new Map([[file.path, note]]);
    const read = [];
    const targets = new Map();
    for (const [path, text] of Object.entries(files)) {
        const target = new TFile(path);
        target.extension = path.split(".").pop();
        targets.set(path.replace(/\.md$/, ""), target);
        targets.set(path, target);
        texts.set(path, text);
    }
    const at = note.indexOf(embed);
    const view = {
        file,
        contentEl: content,
        containerEl: content,
        getMode: () => "preview",
        getViewType: () => "markdown",
    };
    const app = {
        vault: {
            read: async (f) => {
                read.push(f.path);
                const text = texts.get(f.path);
                return typeof text === "function" ? text() : text;
            },
            modify: async (f, c) => texts.set(f.path, c),
            getAbstractFileByPath: () => null,
        },
        metadataCache: {
            getFileCache: (f) =>
                f === file
                    ? {
                          embeds: [
                              {
                                  link: embed.slice(3, -2),
                                  position: { start: { offset: at }, end: { offset: at + embed.length } },
                              },
                          ],
                      }
                    : {},
            getFirstLinkpathDest: (link) => targets.get(link) ?? null,
        },
        fileManager: { processFrontMatter: async () => {} },
        workspace: { getActiveViewOfType: () => view, on: () => {}, off: () => {}, getActiveFile: () => file },
    };
    const plugin = new ReadingHighlighterPlugin(app, { id: "t", version: "0" });
    await plugin.loadSettings();
    Object.assign(plugin.settings, {
        enableFrontmatterTag: false,
        defaultTagPrefix: "",
        enableSmartParagraphSelection: false,
    });
    plugin.logic = new SelectionLogic(app, () => []);
    const node = [...content.querySelectorAll("p")][paragraph].firstChild;
    const range = doc.createRange();
    range.setStart(node, node.nodeValue.indexOf(word));
    range.setEnd(node, node.nodeValue.indexOf(word) + word.length);
    window.getSelection().addRange(range);
    await plugin.highlightSelection(view, { text: word, range });
    return { texts, read };
}

describe("a note with an embedded image (issue 13)", () => {
    const note = "Intro text here.\n\n![[photo.jpg]]\n\nSelect this word please.\n";
    const html =
        '<p>Intro text here.</p><div class="internal-embed image-embed"><img></div><p>Select this word please.</p>';

    it("highlights even when the image cannot be read as text", async () => {
        const { texts, read } = await highlightInNoteWithEmbed({
            note,
            html,
            embed: "![[photo.jpg]]",
            files: {
                "photo.jpg": () => {
                    throw new Error("cannot read binary file as text");
                },
            },
            paragraph: 1,
            word: "word",
        });
        expect(texts.get("note.md")).toBe("Intro text here.\n\n![[photo.jpg]]\n\nSelect this ==word== please.\n");
        expect(read).not.toContain("photo.jpg");
    });

    it("still highlights inside an embedded note", async () => {
        const { texts } = await highlightInNoteWithEmbed({
            note: "Intro text here.\n\n![[Other]]\n\nAfter it.\n",
            html: '<p>Intro text here.</p><div class="internal-embed markdown-embed"><p>Embedded sentence lives here.</p></div><p>After it.</p>',
            embed: "![[Other]]",
            files: { "Other.md": "Embedded sentence lives here.\n" },
            paragraph: 1,
            word: "sentence",
        });
        expect(texts.get("Other.md")).toBe("Embedded ==sentence== lives here.\n");
        expect(texts.get("note.md")).toBe("Intro text here.\n\n![[Other]]\n\nAfter it.\n");
    });
});

describe("an action that fails (issue 13)", () => {
    it("says so instead of doing nothing", async () => {
        createObsidianWindow();
        const plugin = new ReadingHighlighterPlugin({ workspace: { on: () => {} } }, { id: "t", version: "0" });
        Notice.messages.length = 0;
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        plugin.runAction(Promise.reject(new Error("could not read photo.jpg")));
        await new Promise((r) => window.setTimeout(r, 0));
        expect(Notice.messages).toContain("That did not work: could not read photo.jpg");
        errors.mockRestore();
    });
});

describe("the toolbar on Android (issue 5)", () => {
    afterEach(() => {
        Platform.isAndroidApp = false;
        vi.useRealTimers();
    });

    async function toolbar() {
        const window = createObsidianWindow();
        const doc = window.document;
        const content = doc.getElementById("content");
        renderHtml(content, "<p>Some text to select in reading view, and more after it.</p>");
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
        const node = content.querySelector("p").firstChild;
        const select = (end) => {
            const range = doc.createRange();
            range.setStart(node, 0);
            range.setEnd(node, end);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            doc.dispatchEvent(new window.Event("selectionchange"));
        };
        const visible = () => plugin.floatingManager.containerEl?.style.display === "flex";
        return { select, visible };
    }

    it("stays hidden while the selection is still moving, and shows once it settles", async () => {
        Platform.isAndroidApp = true;
        vi.useFakeTimers();
        const t = await toolbar();
        t.select(4);
        expect(t.visible()).toBe(false);
        vi.advanceTimersByTime(300);
        expect(t.visible()).toBe(true);
        // The finger moves on: the toolbar gets out of the way at once.
        t.select(9);
        expect(t.visible()).toBe(false);
        vi.advanceTimersByTime(150);
        t.select(14);
        expect(t.visible()).toBe(false);
        vi.advanceTimersByTime(300);
        expect(t.visible()).toBe(true);
    });

    it("is unchanged on desktop: shown as soon as text is selected", async () => {
        const t = await toolbar();
        t.select(4);
        expect(t.visible()).toBe(true);
    });
});
