// Where a highlight's markers go, so that bold, italic, strikethrough, code,
// links and tags around the selection render as they did. Most cases below are
// lines from real notes that earlier versions broke.
import { describe, it, expect } from "vitest";
import { emphasisPairs, hasUnpairedDelimiter, highlightInLine } from "../src/utils/inlineMarkdown";
import { setup, textNodes, highlightRange } from "./WritePath.test.js";

/** Highlight the `nth` occurrence of `needle` in `line` directly. */
function hl(line, needle, nth = 0, { open = "==", tag = "", whole = false } = {}) {
    let at = -1;
    for (let k = 0; k <= nth; k++) at = line.indexOf(needle, at + 1);
    if (at < 0) throw new Error("needle not found: " + needle);
    return highlightInLine(line, at, at + needle.length, open, tag, whole);
}

const pairs = (text) => emphasisPairs(text).map((p) => text.slice(p.open[0], p.close[1]));

describe("emphasisPairs", () => {
    it("pairs bold, italic, strikethrough and highlight", () => {
        expect(pairs("**a** *b* _c_ ~~d~~ ==e==")).toEqual(["**a**", "*b*", "_c_", "~~d~~", "==e=="]);
    });
    it("nests bold and italic in a triple run", () => {
        expect(pairs("***x***")).toEqual(["**x**", "***x***"]);
    });
    it("leaves plain-text stars and underscores alone", () => {
        expect(pairs("snake_case_name and 2 * 3 = 6")).toEqual([]);
    });
    it("does not pair across a code span, a URL or an escape", () => {
        expect(pairs("`a*b` c* \\*d* https://x.org/a_b_c")).toEqual([]);
    });
    it("keeps a link's text a scope of its own", () => {
        expect(pairs("*a [b* c](u) d")).toEqual([]);
        expect(pairs("[*b*](u)")).toEqual(["*b*"]);
    });
});

describe("hasUnpairedDelimiter", () => {
    it("is false for well-formed lines", () => {
        expect(hasUnpairedDelimiter("The *Times*, the **Guardian** and ~~x~~.")).toBe(false);
        expect(hasUnpairedDelimiter("snake_case and 2 * 3")).toBe(false);
    });
    it("is true when a delimiter that could open or close has no partner", () => {
        expect(hasUnpairedDelimiter("**Newspapers. The *Times*, the *Guardian*")).toBe(true);
        expect(hasUnpairedDelimiter("*p, *b, *m")).toBe(true);
    });
});

describe("highlightInLine", () => {
    it("keeps bold and italic delimiters with their partners", () => {
        expect(hl("**one two three**", "one")).toBe("**==one== two three**");
        expect(hl("**one two three**", "three")).toBe("**one two ==three==**");
        expect(hl("*alpha beta*", "beta")).toBe("*alpha ==beta==*");
        expect(hl("~~one two~~", "one")).toBe("~~==one== two~~");
    });
    it("wraps a whole span, delimiters and all", () => {
        expect(hl("Before **one** after.", "**one**")).toBe("Before ==**one**== after.");
    });
    it("splits a selection that runs into a span", () => {
        expect(hl("la célebre novela *Pablo y Virginia*, 1788", "novela *Pablo")).toBe(
            "la célebre ==novela== *==Pablo== y Virginia*, 1788"
        );
        expect(hl("created **Paris 1871 Bonjour** here", "created **Paris")).toBe(
            "==created== **==Paris== 1871 Bonjour** here"
        );
    });
    it("splits a selection that runs out of a span", () => {
        expect(hl("the *New Statesman*, the end", "Statesman*, the")).toBe("the *New ==Statesman==*==, the== end");
    });
    it("leaves punctuation taken in after a closing delimiter outside", () => {
        expect(hl("(*Historia de la nación griega*), vol", "nación griega*),")).toBe(
            "(*Historia de la ==nación griega==*), vol"
        );
    });
    it("writes a malformed line the way earlier versions did", () => {
        const line = "**Newspapers. The *Times*, the *New Statesman*, the *Spectator*.";
        expect(hl(line, "Statesman*, the *Spectator")).toBe(
            "**Newspapers. The *Times*, the *New ==Statesman*, the *Spectator==*."
        );
    });
    it("leaves plain-text underscores and stars where they are", () => {
        expect(hl("snake_case_name here", "case")).toBe("snake_==case==_name here");
        expect(hl("2 * 3 = 6", "* 3")).toBe("2 ==* 3== = 6");
    });
    it("does not start a highlight inside a code span", () => {
        expect(hl("Pass `--temp 0.7` here", "Pass `--temp")).toBe("==Pass== `--temp 0.7` here");
        expect(hl("on 19 July 2020.`{{cite journal}}`: CS1", "July 2020.`{{cite")).toBe(
            "on 19 ==July 2020.==`{{cite journal}}`: CS1"
        );
    });
    it("takes a code span whole when the selection covers it", () => {
        expect(hl("run `npm ci` now", "run `npm ci` now")).toBe("==run `npm ci` now==");
    });
    it("does not split an escape", () => {
        // The selection starts between the backslash and the bracket it escapes.
        const line = "aspiración: \\[h\\]amaqueó todo";
        const at = line.indexOf("[h");
        expect(highlightInLine(line, at, line.indexOf(" todo"), "==", "")).toBe("aspiración: \\[==h\\]amaqueó== todo");
    });
    it("does not pair a highlight across square brackets", () => {
        expect(hl("(Marsé _Rabos_ [Esp. 2000]).", "2000]).")).toBe("(Marsé _Rabos_ [Esp. ==2000==]).");
    });
    it("writes a removed marker back at its edge", () => {
        // An existing highlight right after a tag, merged into the new one:
        // without its marker the tag would run into the highlighted text.
        const line = "#escritores/leopoldo_marechalLeopoldo Marechal: «De todo».";
        const start = line.indexOf("Leopoldo M");
        expect(highlightInLine(line, start, line.length, "==", "", true)).toBe(
            "#escritores/leopoldo_marechal==Leopoldo Marechal: «De todo».=="
        );
    });
    it("writes a colour", () => {
        expect(hl("**one two three**", "one", 0, { open: "==🔴" })).toBe("**==🔴one== two three**");
    });
    it("writes a tag before the highlight, outside the bold", () => {
        expect(hl("**one two three**", "*one", 0, { tag: "#t " })).toBe("*#t *==one== two three**");
        expect(hl("x **one two three**", "**one", 0, { tag: "#t " })).toBe("x #t **==one== two three**");
    });
    it("never writes a tag inside an escape", () => {
        // The selection starts between a backslash and the star it escapes.
        const line = "*\\*Este artículo fue actualizado.*";
        const start = line.indexOf("*Este");
        expect(highlightInLine(line, start, line.indexOf(" fue"), "==", "#t ")).toBe(
            "*\\*#t ==Este artículo== fue actualizado.*"
        );
    });
});

async function pick(raw, html, needle, nth = 0) {
    const ctx = await setup(raw, html);
    let seen = 0;
    for (const n of textNodes(ctx.content)) {
        let from = 0;
        let i;
        while ((i = n.nodeValue.indexOf(needle, from)) !== -1) {
            if (seen++ === nth) {
                await highlightRange(ctx, n, i, n, i + needle.length);
                return ctx.out();
            }
            from = i + 1;
        }
    }
    throw new Error("needle not found: " + needle);
}

describe("highlighting from reading view", () => {
    it("bold: first, middle and last word", async () => {
        const html = "<p><strong>one two three</strong></p>";
        expect(await pick("**one two three**\n", html, "one")).toBe("**==one== two three**\n");
        expect(await pick("**one two three**\n", html, "two")).toBe("**one ==two== three**\n");
        expect(await pick("**one two three**\n", html, "three")).toBe("**one two ==three==**\n");
    });
    it("bold: the whole span keeps its delimiters inside the highlight", async () => {
        const html = "<p><strong>one two three</strong></p>";
        expect(await pick("**one two three**\n", html, "one two three")).toBe("==**one two three**==\n");
    });
    it("italic, underscore italic and strikethrough", async () => {
        expect(await pick("*alpha beta gamma*\n", "<p><em>alpha beta gamma</em></p>", "alpha")).toBe(
            "*==alpha== beta gamma*\n"
        );
        expect(await pick("_alpha beta_\n", "<p><em>alpha beta</em></p>", "alpha")).toBe("_==alpha== beta_\n");
        expect(await pick("~~one two three~~\n", "<p><del>one two three</del></p>", "three")).toBe(
            "~~one two ==three==~~\n"
        );
    });
    it("a selection running from plain text into bold", async () => {
        const html = "<p>plain then <strong>bold two</strong> end</p>";
        // The selection crosses the <strong> boundary, so it spans two text nodes.
        const ctx = await setup("plain then **bold two** end\n", html);
        const [plain, bold] = textNodes(ctx.content);
        await highlightRange(ctx, plain, plain.nodeValue.indexOf("then"), bold, "bold".length);
        expect(ctx.out()).toBe("plain ==then== **==bold== two** end\n");
    });
    it("a selection running out of italic into plain text", async () => {
        const html = "<p>la <em>nación griega</em>), vol</p>";
        const ctx = await setup("la *nación griega*), vol\n", html);
        const [, em, rest] = textNodes(ctx.content);
        await highlightRange(ctx, em, em.nodeValue.indexOf("griega"), rest, rest.nodeValue.indexOf(" vol"));
        expect(ctx.out()).toBe("la *nación ==griega==*), vol\n");
    });
    it("bold in a bullet keeps the bullet outside", async () => {
        expect(await pick("- **one two**\n", "<ul><li><strong>one two</strong></li></ul>", "one")).toBe(
            "- **==one== two**\n"
        );
    });
    it("a heading's number is highlighted with its text", async () => {
        const html = "<h4>1. Complemento directo</h4>";
        expect(await pick("#### 1. Complemento directo\n", html, "1. Complemento directo")).toBe(
            "#### ==1. Complemento directo==\n"
        );
    });
    it("a number at the start of a selection mid-sentence stays in it", async () => {
        const html = "<p>She was 17. The abortion made her sterile.</p>";
        expect(await pick("She was 17. The abortion made her sterile.\n", html, "17. The abortion")).toBe(
            "She was ==17. The abortion== made her sterile.\n"
        );
    });
    it("plain text is unchanged", async () => {
        expect(await pick("one two three\n", "<p>one two three</p>", "two")).toBe("one ==two== three\n");
    });
});

describe("dollar amounts", () => {
    it("are not math, so a highlight can take them in", () => {
        const line = "for 1,650,000 guldens about US$624,000 or US$6.75 million today";
        const start = line.indexOf("US$624");
        expect(highlightInLine(line, start, start + "US$624,000".length, "==", "")).toBe(
            "for 1,650,000 guldens about ==US$624,000== or US$6.75 million today"
        );
    });
    it("leave real inline math whole", () => {
        expect(hl("math $x^2$ here and more", "here")).toBe("math $x^2$ ==here== and more");
    });
});
