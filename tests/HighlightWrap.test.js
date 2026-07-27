import { describe, it, expect } from "vitest";

// ====================================================================
// We test `extractInlineBoundaries` in isolation. It lives in its own
// module (src/utils/highlightWrap.ts) so it has no `obsidian` runtime
// dependencies — we can import and exercise it directly from Node.
// ====================================================================

import { extractInlineBoundaries } from "../src/utils/highlightWrap";

describe("extractInlineBoundaries — symmetric (no change)", () => {
    it("leaves `**...**` untouched (full bold span)", () => {
        expect(extractInlineBoundaries("**one two three**")).toEqual({
            leading: "",
            core: "**one two three**",
            trailing: "",
        });
    });

    it("leaves `*...*` untouched (full italic span)", () => {
        expect(extractInlineBoundaries("*italic word*")).toEqual({
            leading: "",
            core: "*italic word*",
            trailing: "",
        });
    });

    it("leaves `~~...~~` untouched (full strikethrough span)", () => {
        expect(extractInlineBoundaries("~~struck~~")).toEqual({
            leading: "",
            core: "~~struck~~",
            trailing: "",
        });
    });

    it("leaves `\\`...\\`` untouched (full inline-code span)", () => {
        expect(extractInlineBoundaries("`code`")).toEqual({
            leading: "",
            core: "`code`",
            trailing: "",
        });
    });
});

describe("extractInlineBoundaries — asymmetric (peel the lone delimiter)", () => {
    it("peels leading `**` only", () => {
        // Canonical failing case from the spec
        expect(extractInlineBoundaries("**one")).toEqual({
            leading: "**",
            core: "one",
            trailing: "",
        });
    });

    it("peels trailing `**` only", () => {
        expect(extractInlineBoundaries("three**")).toEqual({
            leading: "",
            core: "three",
            trailing: "**",
        });
    });

    it("peels leading `*` (italic)", () => {
        expect(extractInlineBoundaries("*italic")).toEqual({
            leading: "*",
            core: "italic",
            trailing: "",
        });
    });

    it("peels trailing `_` (underscore italic)", () => {
        expect(extractInlineBoundaries("word_")).toEqual({
            leading: "",
            core: "word",
            trailing: "_",
        });
    });

    it("peels leading `~~` (strikethrough)", () => {
        expect(extractInlineBoundaries("~~struck")).toEqual({
            leading: "~~",
            core: "struck",
            trailing: "",
        });
    });

    it("peels leading backtick (inline code)", () => {
        expect(extractInlineBoundaries("`snippet")).toEqual({
            leading: "`",
            core: "snippet",
            trailing: "",
        });
    });
});

describe("extractInlineBoundaries — single pair with trailing content (unchanged)", () => {
    it("returns unchanged for `**...** + trailing comma` (whole line is the user's selection)", () => {
        expect(extractInlineBoundaries("**17 Nov 2025**,")).toEqual({
            leading: "",
            core: "**17 Nov 2025**,",
            trailing: "",
        });
    });

    it("returns unchanged for `**...** + trailing period`", () => {
        expect(extractInlineBoundaries("**Done**.")).toEqual({
            leading: "",
            core: "**Done**.",
            trailing: "",
        });
    });

    it("returns unchanged for `*...* + trailing period` (italic)", () => {
        expect(extractInlineBoundaries("*café*.")).toEqual({
            leading: "",
            core: "*café*.",
            trailing: "",
        });
    });

    it("returns unchanged for `~~...~~ + trailing comma` (strikethrough)", () => {
        expect(extractInlineBoundaries("~~old~~,")).toEqual({
            leading: "",
            core: "~~old~~,",
            trailing: "",
        });
    });

    it("returns unchanged for `` `...` + trailing semicolon `` (inline code)", () => {
        expect(extractInlineBoundaries("`var`;")).toEqual({
            leading: "",
            core: "`var`;",
            trailing: "",
        });
    });

    it("returns unchanged for `**...** + trailing closing paren`", () => {
        expect(extractInlineBoundaries("**foo**)")).toEqual({
            leading: "",
            core: "**foo**)",
            trailing: "",
        });
    });
});

describe("extractInlineBoundaries — no delimiter / defensive", () => {
    it("returns empty boundaries for plain text", () => {
        expect(extractInlineBoundaries("plain text")).toEqual({
            leading: "",
            core: "plain text",
            trailing: "",
        });
    });

    it("returns empty boundaries for the empty string", () => {
        expect(extractInlineBoundaries("")).toEqual({
            leading: "",
            core: "",
            trailing: "",
        });
    });

    it("does not treat a lone `**` (empty core) as a match", () => {
        expect(extractInlineBoundaries("**")).toEqual({
            leading: "",
            core: "**",
            trailing: "",
        });
    });

    it("does not treat a lone `*` (empty core) as a match", () => {
        expect(extractInlineBoundaries("*")).toEqual({
            leading: "",
            core: "*",
            trailing: "",
        });
    });
});

// ====================================================================
// End-to-end: compose the wrap-site template the same way
// `applyMarkdownModification` does and assert the canonical failing case
// from the spec comes out correct.
// ====================================================================
describe("wrap-site composition — canonical spec case", () => {
    function composeMarkdownWrap(actualContent) {
        const { leading, core, trailing } = extractInlineBoundaries(actualContent);
        return `${leading}==${core}==${trailing}`;
    }
    function composeColorWrap(actualContent, color) {
        const { leading, core, trailing } = extractInlineBoundaries(actualContent);
        return `${leading}<mark style="background: ${color}; color: black;">${core}</mark>${trailing}`;
    }

    it("asymmetric leading `**` produces `**==one==` (NOT `==**one==`)", () => {
        // The failing case: source `**one two three**`, user selected `one`,
        // expansion pulled in the leading `**` so `actualContent = "**one"`.
        const wrapped = composeMarkdownWrap("**one");
        expect(wrapped).toBe("**==one==");
        expect(wrapped).not.toBe("==**one==");
        // And the full line becomes `**==one== two three**` — bold pair intact.
        const line = wrapped + " two three**";
        expect(line).toBe("**==one== two three**");
    });

    it("asymmetric trailing `**` produces `==three==**` (NOT `==three**==`)", () => {
        const wrapped = composeMarkdownWrap("three**");
        expect(wrapped).toBe("==three==**");
        expect(wrapped).not.toBe("==three**==");
        const line = "**one two " + wrapped;
        expect(line).toBe("**one two ==three==**");
    });

    it("symmetric `**x**` stays as `==**x**==` (no change to working case)", () => {
        const wrapped = composeMarkdownWrap("**one two three**");
        expect(wrapped).toBe("==**one two three**==");
    });

    it("no-delimiter `x` stays as `==x==` (no change to plain case)", () => {
        expect(composeMarkdownWrap("one")).toBe("==one==");
    });

    it("color mode also keeps the leading `**` outside the <mark>", () => {
        const wrapped = composeColorWrap("**one", "#FFEE58");
        expect(wrapped).toBe('**<mark style="background: #FFEE58; color: black;">one</mark>');
    });

    it("single pair with trailing comma produces `==**17 Nov 2025**,==` (whole line highlighted)", () => {
        // After the fix: a single bold pair with trailing content is the user's
        // whole selection. The wrap composes `==text==` — the pair sits inside
        // the highlight, not split around it.
        const wrapped = composeMarkdownWrap("**17 Nov 2025**,");
        expect(wrapped).toBe("==**17 Nov 2025**,==");
        expect(wrapped).not.toBe("**==17 Nov 2025==**,");
    });

    it("single pair with trailing period produces `==**Done**.==`", () => {
        expect(composeMarkdownWrap("**Done**.")).toBe("==**Done**.==");
    });

    it("single pair with trailing semicolon produces `` ==`var`;== ``", () => {
        expect(composeMarkdownWrap("`var`;")).toBe("==`var`;==");
    });

    it("color mode also wraps the whole single-pair selection in <mark>", () => {
        const wrapped = composeColorWrap("**Done**.", "#FFEE58");
        expect(wrapped).toBe(
            '<mark style="background: #FFEE58; color: black;">**Done**.</mark>'
        );
    });
});

// ====================================================================
// Embedded inline markers — selection spans multiple bold runs separated
// by plain text. The first inner `**` after the leading one is the
// *opening* of a new span, not the *closing* of the first, so the
// function must NOT peel it. Return the text unchanged so the wrap
// composes `==text==` (full selection highlighted, inner formatting
// preserved). Regression test for the cervical-cancer case.
// ====================================================================
describe("extractInlineBoundaries — embedded inline markers (multiple spans)", () => {
    it("returns unchanged when text starts with ** and has ** in the middle (two bold spans)", () => {
        const text = "**foo** bar **baz** qux";
        expect(extractInlineBoundaries(text)).toEqual({
            leading: "",
            core: text,
            trailing: "",
        });
    });

    it("returns unchanged for the canonical cervical-cancer case", () => {
        const text =
            "**Avoidable loss of life**: Unlike most cancers, cervical cancer is **preventable (vaccine), detectable (HPV test/VIA), and curable (surgery, LEEP, cryotherapy)** if caught early[^15].";
        expect(extractInlineBoundaries(text)).toEqual({
            leading: "",
            core: text,
            trailing: "",
        });
    });

    it("returns unchanged for multiple bold spans with no spaces", () => {
        const text = "**foo**bar**baz**";
        expect(extractInlineBoundaries(text)).toEqual({
            leading: "",
            core: text,
            trailing: "",
        });
    });

    it("wrap-site composition produces a single highlight wrapping the full selection", () => {
        function composeMarkdownWrap(actualContent) {
            const { leading, core, trailing } = extractInlineBoundaries(actualContent);
            return `${leading}==${core}==${trailing}`;
        }
        expect(composeMarkdownWrap("**foo** bar **baz** qux")).toBe(
            "==**foo** bar **baz** qux=="
        );
    });

    it("regression: symmetric unchanged case is still preserved", () => {
        expect(extractInlineBoundaries("**Cervical Cancer**")).toEqual({
            leading: "",
            core: "**Cervical Cancer**",
            trailing: "",
        });
    });

    it("regression: single pair with trailing comma returns unchanged", () => {
        expect(extractInlineBoundaries("**17 Nov 2025**,")).toEqual({
            leading: "",
            core: "**17 Nov 2025**,",
            trailing: "",
        });
    });

    it("regression: lone leading delimiter is still preserved", () => {
        expect(extractInlineBoundaries("**one")).toEqual({
            leading: "**",
            core: "one",
            trailing: "",
        });
    });
});

// ====================================================================
// Single inline-formatting pair (one complete pair with substantial
// trailing content). The leading delimiter appears exactly twice in the
// text — opening at the start, closing in the middle. The whole text
// is the user's selection; the function must return it unchanged so the
// wrap composes `==text==` (whole selection highlighted, the formatting
// pair sits inside the highlight). Regression for the canonical
// triple-tap bug case.
// ====================================================================
describe("extractInlineBoundaries — single pair (unchanged)", () => {
    it("canonical bug case: bold lead-in with substantial trailing content", () => {
        const text = "**Indias projected SAF demand**: 62,000 t (2027) → 130,000 t (2028) → 380,000 t (2030).[^12]";
        expect(extractInlineBoundaries(text)).toEqual({
            leading: "",
            core: text,
            trailing: "",
        });
    });

    it("minimal trailing letter: `**bold**a` returns unchanged", () => {
        expect(extractInlineBoundaries("**bold**a")).toEqual({
            leading: "",
            core: "**bold**a",
            trailing: "",
        });
    });

    it("embedded multi-span (4+ occurrences) still returns unchanged", () => {
        expect(extractInlineBoundaries("**foo** bar **baz** qux")).toEqual({
            leading: "",
            core: "**foo** bar **baz** qux",
            trailing: "",
        });
    });

    it("lone leading `**` (1 occurrence) still peels", () => {
        expect(extractInlineBoundaries("**one")).toEqual({
            leading: "**",
            core: "one",
            trailing: "",
        });
    });

    it("lone trailing `**` (no leading) still peels", () => {
        expect(extractInlineBoundaries("one**")).toEqual({
            leading: "",
            core: "one",
            trailing: "**",
        });
    });

    it("symmetric `**x**` (closing at end) still returns unchanged via endsWith branch", () => {
        expect(extractInlineBoundaries("**one two three**")).toEqual({
            leading: "",
            core: "**one two three**",
            trailing: "",
        });
    });
});
