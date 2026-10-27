// Selecting part of a bold, italic, struck-through or code span must not split
// the delimiter pair across the `==` highlight.
import { describe, it, expect } from "vitest";
import { extractInlineBoundaries } from "../src/utils/inlineBoundaries";
import { setup, textNodes, highlightRange } from "./WritePath.test.js";

const split = (s) => {
    const { leading, core, trailing } = extractInlineBoundaries(s);
    return [leading, core, trailing];
};

describe("extractInlineBoundaries", () => {
    it("peels a lone leading delimiter", () => {
        expect(split("**one")).toEqual(["**", "one", ""]);
        expect(split("*one")).toEqual(["*", "one", ""]);
        expect(split("_one")).toEqual(["_", "one", ""]);
        expect(split("~~one")).toEqual(["~~", "one", ""]);
        expect(split("`one")).toEqual(["`", "one", ""]);
    });

    it("peels a lone trailing delimiter", () => {
        expect(split("three**")).toEqual(["", "three", "**"]);
        expect(split("three*")).toEqual(["", "three", "*"]);
        expect(split("three_")).toEqual(["", "three", "_"]);
        expect(split("three~~")).toEqual(["", "three", "~~"]);
        expect(split("three`")).toEqual(["", "three", "`"]);
    });

    it("leaves a whole pair alone", () => {
        for (const s of ["**one**", "*one*", "_one_", "~~one~~", "`one`", "**one two** three", "a **b** c"]) {
            expect(split(s)).toEqual(["", s, ""]);
        }
    });

    it("leaves plain text and delimiters in the middle alone", () => {
        for (const s of ["plain words", "snake_case_name", "foo_bar", "2 * 3 = 6", "a ** b"]) {
            expect(split(s)).toEqual(["", s, ""]);
        }
    });

    it("does not read one half of ** as an italic star", () => {
        expect(split("**a** b *c")).toEqual(["", "**a** b *c", ""]);
        expect(split("*a **b** c")).toEqual(["*", "a **b** c", ""]);
    });

    it("peels nested unpaired delimiters from both sides", () => {
        expect(split("**_one")).toEqual(["**_", "one", ""]);
        expect(split("one_**")).toEqual(["", "one", "_**"]);
    });

    it("keeps the content when peeling would leave nothing", () => {
        expect(split("**")).toEqual(["", "**", ""]);
        expect(split("*")).toEqual(["", "*", ""]);
        expect(split("** **")).toEqual(["", "** **", ""]);
        expect(split("")).toEqual(["", "", ""]);
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

describe("highlighting part of an inline span", () => {
    it("bold: first word", async () => {
        expect(await pick("**one two three**\n", "<p><strong>one two three</strong></p>", "one")).toBe(
            "**==one== two three**\n"
        );
    });
    it("bold: last word", async () => {
        expect(await pick("**one two three**\n", "<p><strong>one two three</strong></p>", "three")).toBe(
            "**one two ==three==**\n"
        );
    });
    it("bold: middle word is untouched by the fix", async () => {
        expect(await pick("**one two three**\n", "<p><strong>one two three</strong></p>", "two")).toBe(
            "**one ==two== three**\n"
        );
    });
    it("bold: the whole span keeps the delimiters inside the highlight", async () => {
        expect(await pick("**one two three**\n", "<p><strong>one two three</strong></p>", "one two three")).toBe(
            "==**one two three**==\n"
        );
    });
    it("italic: first and last word", async () => {
        const html = "<p><em>alpha beta gamma</em></p>";
        expect(await pick("*alpha beta gamma*\n", html, "alpha")).toBe("*==alpha== beta gamma*\n");
        expect(await pick("*alpha beta gamma*\n", html, "gamma")).toBe("*alpha beta ==gamma==*\n");
    });
    it("underscore italic: first word", async () => {
        expect(await pick("_alpha beta_\n", "<p><em>alpha beta</em></p>", "alpha")).toBe("_==alpha== beta_\n");
    });
    it("strikethrough: first and last word", async () => {
        const html = "<p><del>one two three</del></p>";
        expect(await pick("~~one two three~~\n", html, "one")).toBe("~~==one== two three~~\n");
        expect(await pick("~~one two three~~\n", html, "three")).toBe("~~one two ==three==~~\n");
    });
    it("inline code: first word", async () => {
        expect(await pick("`one two three`\n", "<p><code>one two three</code></p>", "one")).toBe(
            "`==one== two three`\n"
        );
    });
    it("bold in the middle of a sentence", async () => {
        const html = "<p>Before <strong>one two</strong> after.</p>";
        expect(await pick("Before **one two** after.\n", html, "one")).toBe("Before **==one== two** after.\n");
        expect(await pick("Before **one two** after.\n", html, "two")).toBe("Before **one ==two==** after.\n");
    });
    it("a fully selected bold word is unchanged", async () => {
        expect(await pick("Before **one** after.\n", "<p>Before <strong>one</strong> after.</p>", "one")).toBe(
            "Before ==**one**== after.\n"
        );
    });
    it("plain text is unchanged", async () => {
        expect(await pick("one two three\n", "<p>one two three</p>", "two")).toBe("one ==two== three\n");
    });
    it("a bullet's prefix stays outside, and so does the bold", async () => {
        expect(await pick("- **one two**\n", "<ul><li><strong>one two</strong></li></ul>", "one")).toBe(
            "- **==one== two**\n"
        );
    });
});
