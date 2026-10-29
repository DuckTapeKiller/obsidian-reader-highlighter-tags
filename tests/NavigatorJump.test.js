// Jumping to a highlight from the navigator in Reading view outlines that
// highlight alone, instead of Obsidian's flash of the whole block it sits in.
import { describe, it, expect } from "vitest";
import { HighlightNavigatorView } from "../src/views/HighlightNavigator";
import { MarkdownView } from "./obsidian-stub.js";
import { createObsidianWindow, renderHtml } from "./dom-helpers.js";

const window = createObsidianWindow();
// jsdom lays nothing out, so it has no scrolling to do.
window.HTMLElement.prototype.scrollIntoView ??= function () {};

function harness(html, mode = "preview") {
    const container = window.document.createElement("div");
    renderHtml(container, html);
    const view = Object.assign(new MarkdownView(), {
        getMode: () => mode,
        previewMode: {
            containerEl: container,
            scrolledTo: null,
            applyScroll(line) {
                this.scrolledTo = line;
            },
        },
    });
    const leaf = {
        view,
        ephemeral: null,
        setEphemeralState(state) {
            this.ephemeral = state;
        },
    };
    const nav = Object.create(HighlightNavigatorView.prototype);
    nav.app = { workspace: { getMostRecentLeaf: () => leaf, setActiveLeaf() {} } };
    nav.collapseSidebarOnMobile = () => {};
    return { nav, view, leaf, container };
}

const flashed = (container) =>
    [...container.querySelectorAll("mark.reading-highlighter-flash")].map((m) => m.textContent);

describe("jumping to a highlight in Reading view", () => {
    it("scrolls to it and outlines it alone, without Obsidian's line jump", async () => {
        const { nav, view, leaf, container } = harness(
            "<p>Un párrafo largo con <mark>uno</mark> y <mark>dos</mark> dentro.</p>"
        );
        await nav.jumpToHighlight({ text: "dos", line: 4 });
        expect(view.previewMode.scrolledTo).toBe(4);
        expect(leaf.ephemeral).toBeNull();
        expect(flashed(container)).toEqual(["dos"]);
        expect(container.querySelector("p").classList.contains("is-flashing")).toBe(false);
    });

    it("finds a highlight whose source has formatting and links", async () => {
        const { nav, container } = harness("<p><mark><strong>negrita</strong> y alias</mark></p>");
        await nav.jumpToHighlight({ text: "**negrita** y [[destino|alias]]", line: 0 });
        expect(flashed(container)).toEqual(["negrita y alias"]);
    });

    it("leaves the editor to Obsidian's own jump to the line", async () => {
        const { nav, leaf, container } = harness("<p><mark>uno</mark></p>", "source");
        await nav.jumpToHighlight({ text: "uno", line: 7 });
        expect(leaf.ephemeral).toEqual({ line: 7, focus: true });
        expect(flashed(container)).toEqual([]);
    });
});
