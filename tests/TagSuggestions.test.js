// The tag dialog's suggestions: recent tags first, then the folder and the
// note's own tags, without repeats.
import { describe, it, expect } from "vitest";
import { TagSuggestModal } from "../src/modals/TagSuggestModal";

function modal(recentTags, frontmatterTags) {
    const plugin = { settings: { recentTags }, app: {} };
    const m = new TagSuggestModal(plugin, () => {});
    m.app = {
        workspace: { getActiveFile: () => ({ parent: { name: "Walden" } }) },
        metadataCache: { getFileCache: () => ({ frontmatter: { tags: frontmatterTags } }) },
    };
    return m;
}

describe("tag suggestions", () => {
    it("offers recently used tags first", () => {
        expect(modal(["simplicity", "time"], ["book"]).getSuggestedTags()).toEqual([
            "simplicity",
            "time",
            "walden",
            "book",
        ]);
    });

    it("never repeats a tag", () => {
        expect(modal(["book", "#walden"], ["book"]).getSuggestedTags()).toEqual(["book", "walden"]);
    });
});
