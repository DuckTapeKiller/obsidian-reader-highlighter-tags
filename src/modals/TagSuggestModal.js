import { FuzzySuggestModal } from "obsidian";

export class TagSuggestModal extends FuzzySuggestModal {
    constructor(plugin, onChoose) {
        super(plugin.app);
        this.plugin = plugin;
        this.onChoose = onChoose;
        this.setPlaceholder("Select or type to create a tag...");
    }

    getItems() {
        const tagCounts = this.app.metadataCache.getTags();
        // Return objects instead of strings
        return Object.keys(tagCounts).map(t => ({ tag: t.substring(1), isNew: false }));
    }

    getItemText(item) {
        return item.tag;
    }

    getSuggestions(query) {
        const searchResults = super.getSuggestions(query);
        const cleanQuery = query.trim().replace(/\s+/g, "_");

        // If query is empty, return defaults
        if (!cleanQuery) return searchResults;

        // Check if exact match exists (case-insensitive)
        const exactMatch = searchResults.some(m => m.item.tag.toLowerCase() === cleanQuery.toLowerCase());

        if (!exactMatch) {
            // Add "Create new" option
            searchResults.unshift({
                item: { tag: cleanQuery, isNew: true },
                match: { score: 0, matches: [[0, cleanQuery.length]] }
            });
        }

        return searchResults;
    }

    renderSuggestion(match, el) {
        super.renderSuggestion(match, el);
        if (match.item.isNew) {
            el.createSpan({ text: " (Create new tag)", cls: "suggestion-aux" });
        }
    }

    onChooseItem(item, _evt) {
        this.onChoose(`#${item.tag}`);
    }
}
