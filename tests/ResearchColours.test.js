// The research view's colour filter: one chip per colour the scan found,
// whatever the settings, and one for highlights in the theme's default colour.
import { describe, it, expect } from "vitest";
import { ResearchView } from "../src/views/ResearchView";
import { createObsidianWindow } from "./dom-helpers.js";
import { TFile } from "./obsidian-stub.js";

const COLOURS = ["red", "orange", "yellow", "green", "blue", "purple"];

function makeView(colours, { meanings = {}, palette = false } = {}) {
    const doc = createObsidianWindow().document;
    const plugin = {
        settings: {
            enableColorPalette: palette,
            semanticColors: COLOURS.map((color) => ({ color, meaning: meanings[color] ?? "" })),
        },
        notify() {},
    };
    const view = new ResearchView({}, plugin);
    view.colorFilterEl = doc.createElement("div");
    view.contentEl = doc.createElement("div");
    view.scanResults = [
        {
            file: new TFile("Nota.md"),
            frontmatter: {},
            highlights: colours.map((color, i) => ({ text: `uno ${i}`, line: i, color })),
        },
    ];
    view.renderColorFilters();
    view.renderContent();
    const chips = () => [...view.colorFilterEl.querySelectorAll(".research-color-chip")];
    const labels = () => chips().map((c) => c.textContent);
    const shown = () => [...view.contentEl.querySelectorAll(".research-item-text")].map((e) => e.textContent);
    const click = (label) =>
        chips()
            .find((c) => c.textContent === label)
            .click();
    return { view, labels, shown, click };
}

describe("the research view's colour filter", () => {
    it("offers every colour found, with no meanings and the palette off", () => {
        const { labels } = makeView(["red", "blue", null, "red"]);
        expect(labels()).toEqual(["Red", "Blue", "Theme default"]);
    });

    it("labels a colour with its meaning when it has one", () => {
        const { labels } = makeView(["red", "green"], { meanings: { green: "Idea" } });
        expect(labels()).toEqual(["Red", "Idea"]);
    });

    it("offers no chip for a colour the scan did not find", () => {
        const { labels } = makeView(["yellow"]);
        expect(labels()).toEqual(["Yellow"]);
    });

    it("filters by colour, by several, and by the theme default", () => {
        const { shown, click } = makeView(["red", "blue", null]);
        expect(shown()).toEqual(["uno 0", "uno 1", "uno 2"]);
        click("Blue");
        expect(shown()).toEqual(["uno 1"]);
        click("Theme default");
        expect(shown()).toEqual(["uno 1", "uno 2"]);
        click("Blue");
        click("Theme default");
        expect(shown()).toEqual(["uno 0", "uno 1", "uno 2"]);
    });

    it("drops a filter for a colour a new scan no longer finds", () => {
        const { view, click, shown } = makeView(["red", "blue"]);
        click("Red");
        view.scanResults[0].highlights = [{ text: "solo azul", line: 0, color: "blue" }];
        view.renderColorFilters();
        view.renderContent();
        expect(shown()).toEqual(["solo azul"]);
    });
});
