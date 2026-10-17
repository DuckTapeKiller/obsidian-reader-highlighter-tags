// Parsing and bulk rewriting of native-colour highlights, the conversion of
// HTML highlights left by older versions, and the migration of old settings.
import { describe, it, expect } from "vitest";
import {
    parseHighlights,
    removeHighlightFromRaw,
    removeAllHighlightsFromRaw,
    convertHtmlHighlightsInRaw,
    recolorHighlightsInRaw,
    mergeAdjacentHighlightsInRaw,
    updateHighlightColorInRaw,
} from "../src/utils/highlights";
import { exportHighlightsToMD, exportHighlightsToJSON } from "../src/utils/export";
import ReadingHighlighterPlugin from "../src/main";
import { TFile } from "./obsidian-stub.js";

describe("parsing", () => {
    it("reads the colour and keeps the emoji out of the text", () => {
        const raw = "Uno ==🟡dos tres== y ==cuatro==.";
        const [a, b] = parseHighlights(raw).highlights;
        expect(a).toMatchObject({ color: "yellow", text: "dos tres", type: "markdown" });
        expect(raw.slice(a.innerStart, a.innerEnd)).toBe("dos tres");
        expect(raw.slice(a.openTagStart, a.openTagEnd)).toBe("==🟡");
        expect(b).toMatchObject({ color: null, text: "cuatro" });
    });

    it("gives an HTML highlight the nearest native colour", () => {
        const [h] = parseHighlights('<mark style="background: #BBDEFB; color: black;">uno</mark>').highlights;
        expect(h).toMatchObject({ type: "html", color: "blue", text: "uno" });
    });

    it("ignores == inside fenced code", () => {
        const raw = "```js\nif (a == b && c == d) {}\n```\n==real==";
        const { highlights } = parseHighlights(raw);
        expect(highlights.map((h) => h.text)).toEqual(["real"]);
    });

    it("numbers ids by position within the line, whatever the syntax", () => {
        const raw = '<mark style="background: red">uno</mark> ==dos==';
        const before = parseHighlights(raw).highlights.map((h) => [h.id, h.text]);
        expect(before).toEqual([
            ["0:0", "uno"],
            ["0:1", "dos"],
        ]);
        const converted = convertHtmlHighlightsInRaw(raw).raw;
        expect(parseHighlights(converted).highlights.map((h) => [h.id, h.text])).toEqual(before);
    });

    it("finds a footnote after a coloured highlight", () => {
        const [h] = parseHighlights("==🔴uno==[^1]\n\n[^1]: nota").highlights;
        expect(h).toMatchObject({ footnoteId: "1", annotation: "nota" });
    });
});

describe("removing", () => {
    it("takes the emoji away with the markers", () => {
        const raw = "a ==🟢uno dos== b";
        const [h] = parseHighlights(raw).highlights;
        expect(removeHighlightFromRaw(raw, h)).toBe("a uno dos b");
    });

    it("removes every highlight but leaves code and lone markers", () => {
        const raw = "==🟡uno== x == y\n```\nif (a == b) {}\n```\n<mark>dos</mark> ==tres==";
        const result = removeAllHighlightsFromRaw(raw);
        expect(result.raw).toBe("uno x == y\n```\nif (a == b) {}\n```\ndos tres");
        expect(result.removedCount).toBe(3);
    });

    it("copes with a highlight nested in another", () => {
        expect(removeAllHighlightsFromRaw("<mark>a ==b== c</mark>").raw).toBe("a b c");
    });
});

describe("converting HTML highlights", () => {
    it("turns <mark> and background <span> into native highlights", () => {
        const raw = [
            'Uno <mark style="background: #FFCDD2; color: black;">dos</mark> tres.',
            '<span style="background-color: #C8E6C9">cuatro</span> <span class="x">cinco</span>',
            "<mark>seis</mark>",
        ].join("\n");
        const result = convertHtmlHighlightsInRaw(raw);
        expect(result.raw).toBe(
            ["Uno ==🔴dos== tres.", '==🟢cuatro== <span class="x">cinco</span>', "==seis=="].join("\n")
        );
        expect(result.changedCount).toBe(3);
    });

    it("keeps whitespace outside the markers so Obsidian renders them", () => {
        expect(convertHtmlHighlightsInRaw("<mark> uno </mark>").raw).toBe(" ==uno== ");
    });

    it("leaves code blocks and CRLF line endings alone", () => {
        const raw = "```\n<mark>code</mark>\n```\n<mark>texto</mark>";
        const out = convertHtmlHighlightsInRaw(raw.replace(/\n/g, "\r\n")).raw;
        expect(out).toBe("```\r\n<mark>code</mark>\r\n```\r\n==texto==");
    });
});

describe("recolouring", () => {
    const raw = '==🟡uno== ==dos== ==🔴tres== <mark style="background: #FFF9C4">cuatro</mark>';

    it("recolours one colour, counting HTML highlights by their nearest colour", () => {
        const result = recolorHighlightsInRaw(raw, { from: "yellow", to: "blue" });
        expect(result.raw).toBe("==🔵uno== ==dos== ==🔴tres== ==🔵cuatro==");
        expect(result.changedCount).toBe(2);
    });

    it("recolours default highlights only", () => {
        expect(recolorHighlightsInRaw(raw, { from: "default", to: "green" }).raw).toContain("==🟢dos==");
    });

    it("can take colour away", () => {
        expect(recolorHighlightsInRaw("==🟡uno==", { from: "any", to: null }).raw).toBe("==uno==");
    });

    it("rewrites a single highlight", () => {
        const [h] = parseHighlights("a ==🟡uno== b").highlights;
        expect(updateHighlightColorInRaw("a ==🟡uno== b", h, "purple")).toBe("a ==🟣uno== b");
    });
});

describe("merging adjacent highlights", () => {
    it("joins highlights of one colour", () => {
        expect(mergeAdjacentHighlightsInRaw("==🟡uno== ==🟡dos==").raw).toBe("==🟡uno dos==");
    });

    it("never joins different colours", () => {
        const raw = "==🟡uno== ==🔴dos== ==tres==";
        expect(mergeAdjacentHighlightsInRaw(raw)).toEqual({ raw, mergedCount: 0 });
    });
});

describe("settings from versions that coloured with HTML", () => {
    async function load(saved) {
        const plugin = new ReadingHighlighterPlugin({}, { id: "t", version: "0" });
        plugin.loadData = async () => saved;
        await plugin.loadSettings();
        return plugin.settings;
    }

    it("moves each meaning to the nearest native colour", async () => {
        const settings = await load({
            semanticColors: [
                { color: "#FFCDD2", meaning: "Important" },
                { color: "#F8BBD0", meaning: "" },
                { color: "#BBDEFB", meaning: "Vocabulary" },
                { color: "#C8E6C9", meaning: "Key Concept" },
                { color: "#FFF9C4", meaning: "General" },
                { color: "#F0F4C0", meaning: "Aside" },
            ],
        });
        expect(settings.semanticColors).toEqual([
            { color: "red", meaning: "Important" },
            { color: "orange", meaning: "" },
            { color: "yellow", meaning: "General / Aside" },
            { color: "green", meaning: "Key Concept" },
            { color: "blue", meaning: "Vocabulary" },
            { color: "purple", meaning: "" },
        ]);
    });

    it("turns the old default colour into a native one, and drops the old keys", async () => {
        const settings = await load({ enableColorHighlighting: true, highlightColor: "#FFEE58" });
        expect(settings.defaultHighlightColor).toBe("yellow");
        expect(settings).not.toHaveProperty("enableColorHighlighting");
        expect(settings).not.toHaveProperty("highlightColor");
    });

    it("ignores an old default colour that was switched off", async () => {
        const settings = await load({ enableColorHighlighting: false, highlightColor: "#FFEE58" });
        expect(settings.defaultHighlightColor).toBe("");
    });

    it("keeps settings already in the new form", async () => {
        const palette = ["red", "orange", "yellow", "green", "blue", "purple"].map((color, i) => ({
            color,
            meaning: i === 3 ? "Idea" : "",
        }));
        const settings = await load({ semanticColors: palette, defaultHighlightColor: "blue" });
        expect(settings.semanticColors).toEqual(palette);
        expect(settings.defaultHighlightColor).toBe("blue");
    });

    it("starts new installs with the six colours and no default", async () => {
        const settings = await load(null);
        expect(settings.semanticColors.map((c) => c.color)).toEqual([
            "red",
            "orange",
            "yellow",
            "green",
            "blue",
            "purple",
        ]);
        expect(settings.defaultHighlightColor).toBe("");
    });
});

describe("exports", () => {
    function fakeApp(raw, path = "note.md") {
        let current = raw;
        const created = {};
        return {
            app: {
                vault: {
                    read: async () => current,
                    modify: async (_f, c) => {
                        current = c;
                    },
                    create: async (p, c) => {
                        created[p] = c;
                    },
                    getAbstractFileByPath: () => null,
                },
            },
            file: Object.assign(new TFile(path), {
                parent: { path: path.includes("/") ? path.replace(/\/[^/]*$/, "") : "/" },
            }),
            current: () => current,
            created,
        };
    }

    it("writes beside a note at the vault root without a leading //", async () => {
        const t = fakeApp("==uno==");
        const path = await exportHighlightsToMD(t.app, t.file);
        expect(path).toBe("note - Highlights.md");
    });

    it("gives a table one block id on the line after it, not a stray cell", async () => {
        const raw = "| a | b |\n| --- | --- |\n| ==uno== | ==dos== |\n| tres | ==cuatro== |\n\nFin.";
        const t = fakeApp(raw);
        await exportHighlightsToMD(t.app, t.file);
        const lines = t.current().split("\n");
        expect(lines.slice(0, 4)).toEqual(raw.split("\n").slice(0, 4));
        expect(lines[4]).toMatch(/^\^[a-z0-9]+$/);
        const embeds = Object.values(t.created)[0].match(/!\[\[[^\]]+\]\]/g);
        expect(embeds).toEqual([`![[note#${lines[4]}]]`]);
    });

    it("keeps CRLF line endings", async () => {
        const t = fakeApp("==uno==\r\nlinea\r\n==dos==");
        await exportHighlightsToMD(t.app, t.file);
        expect(t.current()).toMatch(/^==uno== \^[a-z0-9]+\r\nlinea\r\n==dos== \^[a-z0-9]+$/);
    });

    it("exports the native colour", async () => {
        const t = fakeApp("==🟡uno== ==dos==");
        await exportHighlightsToJSON(t.app, t.file);
        const data = JSON.parse(Object.values(t.created)[0]);
        expect(data.highlights.map((h) => [h.text, h.color])).toEqual([
            ["uno", "yellow"],
            ["dos", null],
        ]);
    });
});
