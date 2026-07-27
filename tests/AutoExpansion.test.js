import { describe, it, expect } from "vitest";

// ====================================================================
// We test `autoExpandSelection` in isolation. It lives in its own
// module (src/utils/autoExpand.ts) so it has no `obsidian` runtime
// dependencies — we can import and exercise it directly from Node.
// ====================================================================

import { autoExpandSelection } from "../src/utils/autoExpand";

const NO_BODY = 0; // no frontmatter, body starts at offset 0

describe("autoExpandSelection — substring inside a formatted span (no expansion)", () => {
    it("does not absorb the trailing `**` or `:` when selection is a word inside `**bold**:`", () => {
        const raw = "**National footprint**:";
        // "footprint" is at offset 11..20
        const { start, end } = autoExpandSelection(raw, 11, 20, NO_BODY);
        expect(start).toBe(11);
        expect(end).toBe(20);
        expect(raw.substring(start, end)).toBe("footprint");
    });

    it("does not absorb the trailing `==` when selection is a word inside `==hl==:`", () => {
        const raw = "==National footprint==:";
        // "footprint" is at offset 11..20
        const { start, end } = autoExpandSelection(raw, 11, 20, NO_BODY);
        expect(start).toBe(11);
        expect(end).toBe(20);
        expect(raw.substring(start, end)).toBe("footprint");
    });

    it("does not absorb the trailing `~~` for a strikethrough span with trailing comma", () => {
        const raw = "~~old text~~,";
        // "text" is at offset 6..10
        const { start, end } = autoExpandSelection(raw, 6, 10, NO_BODY);
        expect(start).toBe(6);
        expect(end).toBe(10);
        expect(raw.substring(start, end)).toBe("text");
    });

    it("does not absorb the trailing `*` for an italic span with trailing period", () => {
        const raw = "*italic word*.";
        // "word" is at offset 8..12
        const { start, end } = autoExpandSelection(raw, 8, 12, NO_BODY);
        expect(start).toBe(8);
        expect(end).toBe(12);
        expect(raw.substring(start, end)).toBe("word");
    });

    it("does not absorb the trailing `` ` `` for an inline-code span with trailing semicolon", () => {
        const raw = "`var x`;";
        // "var x" is at offset 1..6
        const { start, end } = autoExpandSelection(raw, 1, 6, NO_BODY);
        expect(start).toBe(1);
        expect(end).toBe(6);
        expect(raw.substring(start, end)).toBe("var x");
    });
});

describe("autoExpandSelection — selection at the edge of a formatted span (symmetric check fires on both sides)", () => {
    it("does not absorb the leading `**` when selection is the first word of `**one two three**`", () => {
        const raw = "**one two three**";
        // "one" is at offset 2..5
        const { start, end } = autoExpandSelection(raw, 2, 5, NO_BODY);
        expect(start).toBe(2);
        expect(end).toBe(5);
        expect(raw.substring(start, end)).toBe("one");
    });

    it("does not absorb the trailing `**` when selection is the last word of `**one two three**`", () => {
        const raw = "**one two three**";
        // "three" is at offset 10..15
        const { start, end } = autoExpandSelection(raw, 10, 15, NO_BODY);
        expect(start).toBe(10);
        expect(end).toBe(15);
        expect(raw.substring(start, end)).toBe("three");
    });
});

describe("autoExpandSelection — regression: existing working cases still expand", () => {
    it("absorbs the leading `**` of `**17 Nov 2025**,` when the inner text is selected (full-span with trailing punct)", () => {
        const raw = "**17 Nov 2025**,";
        // "17 Nov 2025" is at offset 2..13
        const { start, end } = autoExpandSelection(raw, 2, 13, NO_BODY);
        // After the leading `**` is absorbed, the symmetric check no longer
        // fires on the next iteration (the leading `**` is now inside the
        // selection, so the substring scan before expandedStart is empty of
        // `**`). The trailing `**` and `,` are then absorbed.
        expect(start).toBe(0);
        expect(end).toBe(16);
        expect(raw.substring(start, end)).toBe("**17 Nov 2025**,");
    });

    it("absorbs leading delimiter only when there's no matching closing in the source (asymmetric `**one two three**`, select `one`)", () => {
        // This is the canonical "fix-bold-edge-highlight-wrapping" case. The
        // new symmetric check fires on BOTH sides (there's a `**` after the
        // selection), so neither is absorbed. The end-to-end wrap step then
        // emits `==one==` and the source line provides the surrounding `**`,
        // producing the same final line as today's working behavior.
        const raw = "**one two three**";
        const { start, end } = autoExpandSelection(raw, 2, 5, NO_BODY);
        expect(start).toBe(2);
        expect(end).toBe(5);
        expect(raw.substring(start, end)).toBe("one");
    });
});

describe("autoExpandSelection — regression: plain text with trailing punct still expands", () => {
    it("absorbs trailing `:` when there's no formatted span around the selection", () => {
        const raw = "National footprint:";
        // "footprint" is at offset 9..18
        const { start, end } = autoExpandSelection(raw, 9, 18, NO_BODY);
        // The `:` is a punctuation alternative, not a paired delimiter, so
        // the symmetric check does not apply. Existing behavior preserved.
        expect(end).toBe(19);
        expect(raw.substring(start, end)).toBe("footprint:");
    });
});

describe("autoExpandSelection — frontmatter-aware body start", () => {
    it("respects bodyStart and does not absorb into the YAML frontmatter", () => {
        const raw = "---\ntitle: foo\n---\n**National footprint**:";
        // The body starts at index 19 (right after the second "---" + "\n").
        // "footprint" is at offset 30..39.
        const bodyStart = 19;
        const { start, end } = autoExpandSelection(raw, 30, 39, bodyStart);
        expect(start).toBe(30);
        expect(end).toBe(39);
        expect(raw.substring(start, end)).toBe("footprint");
    });
});

describe("autoExpandSelection — unrelated paired delimiters earlier in the document do not block absorption", () => {
    // Regression: a document with many `==` highlights elsewhere (e.g. the
    // cervical-cancer note) used to make the matchForward symmetric guard
    // fire for the closing `==` of the highlight the user was removing,
    // because `before.includes("==")` was true due to an UNRELATED
    // `==...==` pair earlier in the document. The closing `==` was left
    // behind in the source after the remove.

    function applyRemove(raw, snippet) {
        const idx = raw.indexOf(snippet);
        const { start, end } = autoExpandSelection(raw, idx, idx + snippet.length, 0);
        const selected = raw.substring(start, end);
        const cleaned = selected.split("==").join("");
        return { out: raw.substring(0, start) + cleaned + raw.substring(end), selected };
    }

    it("absorbs the closing `==` of a highlight when another `==` pair exists earlier in the document", () => {
        // Simulate a document with an earlier `==other==` highlight and a
        // later one around "footprint". The user selects "footprint" to
        // remove the second highlight.
        const raw = "Some earlier paragraph with ==other highlight== in it.\n\n- **National ==footprint==**:";
        const footprintOffset = raw.indexOf("footprint");
        const { start, end } = autoExpandSelection(raw, footprintOffset, footprintOffset + 9, 0);
        // Both `==` of the current highlight should be absorbed.
        expect(start).toBe(footprintOffset - 2);
        expect(end).toBe(footprintOffset + 9 + 2);
        expect(raw.substring(start, end)).toBe("==footprint==");
    });

    it("end-to-end remove: a document with many earlier `==` highlights still strips the closing `==` of the target highlight", () => {
        // The exact bug from the live Reading-view smoke: the cervical-cancer
        // note has many `==` highlights, and removing one of them left the
        // closing `==` behind. The autoExpand now absorbs both `==` of the
        // target highlight and the wrap step strips them — no stray `==`
        // remains in the source.
        const raw = [
            "Some earlier highlight: ==first one==.",
            "Another: ==second one==.",
            "And a third: ==third one==.",
            "",
            "- **National ==footprint==**:",
        ].join("\n");
        const r = applyRemove(raw, "footprint");
        expect(r.selected).toBe("==footprint==");
        expect(r.out).toBe(
            [
                "Some earlier highlight: ==first one==.",
                "Another: ==second one==.",
                "And a third: ==third one==.",
                "",
                "- **National footprint**:",
            ].join("\n")
        );
        // The earlier `==...==` highlights must be untouched.
        expect(r.out).toContain("==first one==");
        expect(r.out).toContain("==second one==");
        expect(r.out).toContain("==third one==");
    });

    it("end-to-end remove: a heading line with `**bold**:` and an earlier `**bold**` pair still removes the `==footprint==` cleanly", () => {
        // The user's actual setup: cervical-cancer note with `# ...` heading
        // and a list item containing `**National ==footprint==**:`. Earlier
        // in the document there are other bold spans AND other highlights.
        const raw = [
            "## Earlier section with ==highlight== and **bold text**.",
            "More body text here.",
            "",
            "# Cervical Cancer Elimination: India, **National ==footprint==**:",
        ].join("\n");
        const r = applyRemove(raw, "footprint");
        expect(r.selected).toBe("==footprint==");
        expect(r.out).not.toContain("==footprint==");
        // Earlier highlights and bold spans must be untouched.
        expect(r.out).toContain("==highlight==");
        expect(r.out).toContain("**bold text**");
    });

    it("does not absorb the trailing `**` of a wrapping bold span when an earlier `**` pair exists in the document (substring case still works)", () => {
        // The original bug we fixed: selecting "footprint" inside
        // `**National footprint**:` should NOT absorb the closing `**` of
        // the bold span. The matchBack-absorbed-same-delim guard must not
        // fire here because the matchBack did NOT absorb `**` (the chars
        // at expandedStart are "f", not `**`).
        const raw = "Earlier **bold text** here.\n\n- **National footprint**:";
        const footprintOffset = raw.indexOf("footprint");
        const { start, end } = autoExpandSelection(raw, footprintOffset, footprintOffset + 9, 0);
        // No expansion: the closing `**` of the bold span must stay outside.
        expect(start).toBe(footprintOffset);
        expect(end).toBe(footprintOffset + 9);
        expect(raw.substring(start, end)).toBe("footprint");
    });

    it("absorbs both `**` of `**17 Nov 2025**` even when an earlier `**` pair exists in the document (full-span case still works)", () => {
        // Regression: the `**17 Nov 2025**,` full-span case must still
        // absorb both `**` (the wrap step peels them). The
        // matchBack-absorbed-same-delim guard should fire here because the
        // matchBack just absorbed the opening `**`.
        const raw = "Earlier **bold text** here.\n\nOn **17 Nov 2025**,";
        const inner = "17 Nov 2025";
        const innerOffset = raw.indexOf(inner);
        const { start, end } = autoExpandSelection(raw, innerOffset, innerOffset + inner.length, 0);
        // Both `**` and the trailing `,` should be absorbed.
        expect(raw.substring(start, end)).toBe("**17 Nov 2025**,");
    });
});
