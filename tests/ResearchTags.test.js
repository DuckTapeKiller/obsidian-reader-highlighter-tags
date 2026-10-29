// The research view's tag filter: the tags written in front of highlights,
// offered as you type, nested tags included, any chosen tag matching.
import { describe, it, expect } from "vitest";
import { ResearchView, TagFilterSuggest, highlightTags, tagMatches } from "../src/views/ResearchView";
import { createObsidianWindow } from "./dom-helpers.js";
import { TFile } from "./obsidian-stub.js";

const COLOURS = ["red", "orange", "yellow", "green", "blue", "purple"];

function makeView(highlights) {
    const doc = createObsidianWindow().document;
    const plugin = {
        settings: { semanticColors: COLOURS.map((color) => ({ color, meaning: "" })) },
        notify() {},
    };
    const view = new ResearchView({}, plugin);
    view.colorFilterEl = doc.createElement("div");
    view.tagChipsEl = doc.createElement("div");
    view.contentEl = doc.createElement("div");
    view.scanResults = [{ file: new TFile("Nota.md"), frontmatter: {}, highlights }];
    view.renderColorFilters();
    view.renderTagFilter();
    view.renderContent();
    const shown = () => [...view.contentEl.querySelectorAll(".research-item-text")].map((e) => e.textContent);
    const chips = () => [...view.tagChipsEl.querySelectorAll(".research-tag-chip")].map((c) => c.textContent);
    return { view, doc, shown, chips };
}

const h = (text, tagsText = "", color = null) => ({ text, line: 0, color, tagsText });
const sample = () => [
    h("poema", "#frases/poesía"),
    h("cita", "#Frases"),
    h("faraón", "#país/egipto", "red"),
    h("suelto"),
    h("otro suelto", "", "red"),
];

describe("a highlight's tags", () => {
    it("are the #tags in front of it, in lower case", () => {
        expect(highlightTags(h("x", "#Frases #poesía"))).toEqual(["#frases", "#poesía"]);
        expect(highlightTags(h("x", ""))).toEqual([]);
    });

    it("match a filter for themselves or for a tag they nest under", () => {
        expect(tagMatches("#frases/poesía", "#frases")).toBe(true);
        expect(tagMatches("#frases", "#frases")).toBe(true);
        expect(tagMatches("#frasesx", "#frases")).toBe(false);
        expect(tagMatches("#frases", "#frases/poesía")).toBe(false);
    });
});

describe("the tag filter", () => {
    it("offers every tag found with its parents, most used first, and Untagged", () => {
        const { view } = makeView(sample());
        expect(view.tagOptions().map((o) => `${o.label} ${o.count}`)).toEqual([
            "#frases 2",
            "#frases/poesía 1",
            "#país 1",
            "#país/egipto 1",
            "Untagged 2",
        ]);
    });

    it("suggests what matches the typed text, leaving out tags already chosen", () => {
        const { view, doc } = makeView(sample());
        const suggest = new TagFilterSuggest({}, doc.createElement("input"), view);
        expect(suggest.getSuggestions("poe").map((o) => o.label)).toEqual(["#frases/poesía"]);
        expect(suggest.getSuggestions("#FRA").map((o) => o.label)).toEqual(["#frases", "#frases/poesía"]);
        view.addTagFilter("#frases");
        expect(suggest.getSuggestions("fra").map((o) => o.label)).toEqual(["#frases/poesía"]);
    });

    it("filters by a tag, nested tags included, ignoring case", () => {
        const { view, shown, chips } = makeView(sample());
        view.addTagFilter("#frases");
        expect(shown()).toEqual(["poema", "cita"]);
        expect(chips()).toEqual(["#frases×"]);
    });

    it("lets through any of several tags, or the untagged", () => {
        const { view, shown } = makeView(sample());
        view.addTagFilter("#frases/poesía");
        view.addTagFilter("#país");
        expect(shown()).toEqual(["poema", "faraón"]);
        view.addTagFilter("untagged");
        expect(shown()).toEqual(["poema", "faraón", "suelto", "otro suelto"]);
    });

    it("combines with the colour filter: both must match", () => {
        const { view, shown } = makeView(sample());
        view.addTagFilter("untagged");
        [...view.colorFilterEl.querySelectorAll(".research-color-chip")].find((c) => c.textContent === "Red").click();
        expect(shown()).toEqual(["otro suelto"]);
    });

    it("drops a tag when its chip is clicked", () => {
        const { view, shown, chips } = makeView(sample());
        view.addTagFilter("#país");
        view.tagChipsEl.querySelector(".research-tag-chip").click();
        expect(chips()).toEqual([]);
        expect(shown()).toHaveLength(5);
    });

    it("drops a tag a new scan no longer finds", () => {
        const { view, shown } = makeView(sample());
        view.addTagFilter("#país");
        view.scanResults[0].highlights = [h("nuevo", "#frases")];
        view.renderTagFilter();
        view.renderContent();
        expect(shown()).toEqual(["nuevo"]);
    });
});

describe("search", () => {
    it("matches a highlight's tags as well as its text", () => {
        const { view, shown } = makeView(sample());
        view.searchQuery = "#frases";
        view.renderContent();
        expect(shown()).toEqual(["poema", "cita"]);
        view.searchQuery = "faraón";
        view.renderContent();
        expect(shown()).toEqual(["faraón"]);
    });
});
