import { describe, it, expect } from "vitest";

// ====================================================================
// We test `autoExpandSelection` in isolation. It lives in its own
// module (src/utils/autoExpand.ts) so it has no `obsidian` runtime
// dependencies — we can import and exercise it directly from Node.
// ====================================================================

import { autoExpandSelection } from "../src/utils/autoExpand";
import { extractInlineBoundaries } from "../src/utils/highlightWrap";

const NO_BODY = 0; // no frontmatter, body starts at offset 0

// End-to-end pipeline: autoExpandSelection → split into lines →
// extractInlineBoundaries → compose the wrap-site template the same way
// `applyMarkdownModification` does. Used by the single-pair regression
// test below to assert the final wrapped line.
function pipelineWrap(raw, start, end, bodyStart = NO_BODY) {
    const { start: s, end: e } = autoExpandSelection(raw, start, end, bodyStart);
    const selected = raw.substring(s, e);
    return selected
        .split(/\r?\n/)
        .map((line) => {
            const { leading, core, trailing } = extractInlineBoundaries(line);
            return `${leading}==${core}==${trailing}`;
        })
        .join("\n");
}

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

    it("absorbs the leading `**` of a bold lead-in even when the NEXT line also starts with `**` (same-line scope fix)", () => {
        // Regression for the canonical bug: triple-tap on
        // `- **India's projected SAF demand**: 62,000 t (2027) → ...`
        // when the next bullet also starts with `- **CORSIA baseline**:`.
        // The previous implementation checked `raw.substring(expandedEnd)`
        // for `**` (the whole rest of the document), so the next line's
        // `**` falsely satisfied the "selection is in the middle of a
        // formatted span" guard and blocked the leading `**` absorption.
        // The fix scopes the guard to the CURRENT LINE.
        const raw = "- **India's projected SAF demand**: 62,000 t (2027) → 130,000 t (2028) → 380,000 t (2030).[^12]\n- **CORSIA baseline**: offsetting required for emissions above 85% of 2019 levels from 2024 onwards.";
        // Selection starts at "India's" (position 4, just after the leading `**`).
        // The end is the end of the first line (95) — simulates triple-tap
        // which selects the whole line, not the whole file.
        const indiasOffset = raw.indexOf("India's");
        const lineEnd = raw.indexOf("\n");
        const { start, end } = autoExpandSelection(raw, indiasOffset, lineEnd, 0);
        // The leading `**` MUST be absorbed (it was the bug that it wasn't).
        expect(start).toBe(indiasOffset - 2);
        expect(raw.substring(start, end)).toBe("**India's projected SAF demand**: 62,000 t (2027) → 130,000 t (2028) → 380,000 t (2030).[^12]");
    });
});

// ====================================================================
// End-to-end regression for the canonical bug case: user triple-taps a
// line whose lead-in is a bold span and applies a highlight. The full
// pipeline (autoExpand + extractInlineBoundaries + wrap composition)
// must produce `==text==` with the bold pair on the inside.
// ====================================================================
describe("end-to-end pipeline — single bold pair with substantial trailing content", () => {
    it("triple-tap of bold lead-in bullet point produces `==**...==` with `**` inside", () => {
        // Source line as the user would see it in the editor
        const raw = "- **Indias projected SAF demand**: 62,000 t (2027) → 130,000 t (2028) → 380,000 t (2030).[^12]";
        // Triple-tap selects from after `- ` (position 2) to end of line
        const start = 2;
        const end = raw.length;
        const wrapped = pipelineWrap(raw, start, end);
        const expected =
            "==**Indias projected SAF demand**: 62,000 t (2027) → 130,000 t (2028) → 380,000 t (2030).[^12]==";
        expect(wrapped).toBe(expected);
        // And explicitly NOT the old broken shape
        expect(wrapped).not.toBe(
            "**==Indias projected SAF demand==**: 62,000 t (2027) → 130,000 t (2028) → 380,000 t (2030).[^12]"
        );
    });

    it("full-span `**17 Nov 2025**,` still produces `==**17 Nov 2025**,==` after the fix", () => {
        // Regression: the previously-peeled case now also wraps the whole
        // selection (the `,` is now inside the highlight, not outside).
        const raw = "On **17 Nov 2025**,";
        const inner = "17 Nov 2025";
        const innerOffset = raw.indexOf(inner);
        const wrapped = pipelineWrap(raw, innerOffset, innerOffset + inner.length);
        expect(wrapped).toBe("==**17 Nov 2025**,==");
    });
});
