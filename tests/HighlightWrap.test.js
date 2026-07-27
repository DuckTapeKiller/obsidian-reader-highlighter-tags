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
});
