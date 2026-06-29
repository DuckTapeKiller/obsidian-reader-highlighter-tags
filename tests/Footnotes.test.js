import { describe, it, expect } from "vitest";
import { removeFootnoteFromRaw, removeAllFootnotesFromRaw } from "../src/utils/highlights";

describe("removeFootnoteFromRaw", () => {
    it("removes both the inline reference and the definition", () => {
        const raw = "Some text[^1] here.\n\n[^1]: A comment.\n";
        const { raw: out, changed } = removeFootnoteFromRaw(raw, "1");
        expect(changed).toBe(true);
        expect(out).not.toContain("[^1]");
        expect(out).toContain("Some text here.");
    });

    it("removes every reference to the same footnote", () => {
        const raw = "First[^1] and second[^1].\n\n[^1]: Shared note.\n";
        const { raw: out } = removeFootnoteFromRaw(raw, "1");
        expect(out).not.toContain("[^1]");
        expect(out).toContain("First and second.");
    });

    it("leaves other footnotes untouched", () => {
        const raw = "A[^1] B[^2].\n\n[^1]: one\n[^2]: two\n";
        const { raw: out } = removeFootnoteFromRaw(raw, "1");
        expect(out).not.toContain("[^1]");
        expect(out).toContain("[^2]");
        expect(out).toContain("[^2]: two");
    });

    it("does not touch the definition token when an id is a numeric prefix of another", () => {
        const raw = "A[^1] B[^12].\n\n[^1]: one\n[^12]: twelve\n";
        const { raw: out } = removeFootnoteFromRaw(raw, "1");
        expect(out).toContain("[^12]");
        expect(out).toContain("[^12]: twelve");
        expect(out).not.toMatch(/\[\^1\](?!\d)/);
    });

    it("reports no change for an unknown id", () => {
        const raw = "No footnotes here.\n";
        const { changed } = removeFootnoteFromRaw(raw, "99");
        expect(changed).toBe(false);
    });

    it("handles named (non-numeric) footnote ids", () => {
        const raw = "Idea[^note] continues.\n\n[^note]: explanation\n";
        const { raw: out, changed } = removeFootnoteFromRaw(raw, "note");
        expect(changed).toBe(true);
        expect(out).not.toContain("[^note]");
    });
});

describe("removeAllFootnotesFromRaw", () => {
    it("removes all annotations and counts them", () => {
        const raw = "A[^1] B[^2] C[^3].\n\n[^1]: one\n[^2]: two\n[^3]: three\n";
        const { raw: out, removedCount } = removeAllFootnotesFromRaw(raw);
        expect(removedCount).toBe(3);
        expect(out).not.toMatch(/\[\^/);
        expect(out).toContain("A B C.");
    });

    it("returns zero when there are no footnotes", () => {
        const { removedCount } = removeAllFootnotesFromRaw("Plain text.\n");
        expect(removedCount).toBe(0);
    });
});
