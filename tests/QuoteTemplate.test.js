// Copy as quote: the template's own `>` must carry down every line of the
// selection, never nest the first one.
import { describe, it, expect } from "vitest";
import ReadingHighlighterPlugin from "../src/main";
import { TFile } from "./obsidian-stub.js";

async function plugin(template) {
    const p = new ReadingHighlighterPlugin({}, { id: "t", version: "0" });
    p.loadData = async () => ({ quoteTemplate: template });
    await p.loadSettings();
    return p;
}

const file = new TFile("Meditations.md");

describe("quote template", () => {
    it("quotes one line once with the default template", async () => {
        const p = await plugin("> {{text}}\n>\n> — [[{{file}}]]");
        expect(p.expandQuoteTemplate(file, "Life is opinion.")).toBe("> Life is opinion.\n>\n> — [[Meditations]]");
    });

    it("keeps every line of a longer selection in the same blockquote", async () => {
        const p = await plugin("> {{text}}\n>\n> — {{author}}");
        expect(p.expandQuoteTemplate(file, "First line.\nSecond line.", { author: "Marcus Aurelius" })).toBe(
            "> First line.\n> Second line.\n>\n> — Marcus Aurelius"
        );
    });

    it("still quotes each line when the template has no > of its own", async () => {
        const p = await plugin("{{text}}\n— {{file}}");
        expect(p.expandQuoteTemplate(file, "One.\nTwo.")).toBe("> One.\n> Two.\n— Meditations");
    });

    it("puts the text in as it is when the template quotes it inline", async () => {
        const p = await plugin("«{{text}}» ({{file}})");
        expect(p.expandQuoteTemplate(file, "Life is opinion.")).toBe("«Life is opinion.» (Meditations)");
    });

    it("leaves variables inside the selected text alone", async () => {
        const p = await plugin("> {{text}}");
        expect(p.expandQuoteTemplate(file, "Write {{file}} here.")).toBe("> Write {{file}} here.");
    });
});
