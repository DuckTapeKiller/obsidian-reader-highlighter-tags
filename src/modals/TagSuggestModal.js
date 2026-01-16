import { Modal } from "obsidian";

export class TagSuggestModal extends Modal {
    constructor(plugin, onChoose) {
        super(plugin.app);
        this.plugin = plugin;
        this.onChoose = onChoose;
        this.selectedTags = new Set();
        this.suggestions = [];
        this.query = "";
        this.suggestionEl = null;
        this.selectedContainer = null;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass("reading-highlighter-tag-modal");

        contentEl.createEl("h2", { text: "Add Tags" });

        // Container for selected chips
        this.selectedContainer = contentEl.createDiv({ cls: "selected-tags-container" });
        this.updateSelectedView();

        // Search Input
        const inputContainer = contentEl.createDiv({ cls: "tag-search-input-container" });
        const input = inputContainer.createEl("input", {
            type: "text",
            cls: "tag-search-input",
            attr: { placeholder: "Search or create tag..." }
        });

        // Focus input
        setTimeout(() => input.focus(), 50);

        // Results List
        this.suggestionEl = contentEl.createDiv({ cls: "tag-suggestions-list" });

        // Footer / Done Button
        const footer = contentEl.createDiv({ cls: "modal-footer" });
        const doneBtn = footer.createEl("button", { text: "Done", cls: "mod-cta" });

        doneBtn.onclick = () => this.submit();

        // Load correct tags
        const tagCounts = this.app.metadataCache.getTags();
        this.allTags = Object.keys(tagCounts).map(t => t.substring(1)); // strip #

        // Handlers
        input.addEventListener("input", (e) => {
            this.query = e.target.value;
            this.renderSuggestions(this.query);
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                // If text exists and no suggestion selected (implied)
                // Just add the current query as a tag
                if (this.query.trim()) {
                    this.toggleTag(this.query.trim());
                    this.query = "";
                    input.value = "";
                    this.renderSuggestions("");
                }
            } else if (e.key === "Backspace" && !this.query) {
                // Optional: remove last tag on backspace empty?
                // Skipping for simplicity/safety
            }
        });

        this.renderSuggestions("");
    }

    renderSuggestions(query) {
        this.suggestionEl.empty();
        const cleanQuery = query.toLowerCase().replace(/\s+/g, "_");

        // Filter tags
        let matches = this.allTags.filter(t => t.toLowerCase().includes(cleanQuery));

        // Exact Match / Create Logic
        // If cleanQuery is effectively new
        const isExact = matches.some(t => t.toLowerCase() === cleanQuery);

        if (cleanQuery && !isExact) {
            // Add creation option at top
            this.renderItem(cleanQuery, true);
        }

        // Limit to 50 for performance
        matches.slice(0, 50).forEach(tag => {
            if (!this.selectedTags.has(tag)) {
                this.renderItem(tag, false);
            }
        });
    }

    renderItem(tag, isNew) {
        const el = this.suggestionEl.createDiv({ cls: "suggestion-item" });
        el.createSpan({ text: isNew ? `#${tag}` : tag });
        if (isNew) {
            el.createSpan({ text: " (Create new)", cls: "suggestion-note" });
        }

        el.addEventListener("click", () => {
            this.toggleTag(tag);
            // Reset search slightly or keep it? 
            // Better to clear input? Yes, standard multi-select behavior.
            this.query = "";
            this.contentEl.querySelector(".tag-search-input").value = "";
            this.contentEl.querySelector(".tag-search-input").focus();
            this.renderSuggestions("");
        });
    }

    toggleTag(tag) {
        // Tag format logic: replace spaces with _, remove #
        const cleanTag = tag.replace(/^#/, "").replace(/\s+/g, "_");

        if (this.selectedTags.has(cleanTag)) {
            this.selectedTags.delete(cleanTag);
        } else {
            this.selectedTags.add(cleanTag);
        }
        this.updateSelectedView();
    }

    updateSelectedView() {
        this.selectedContainer.empty();
        this.selectedTags.forEach(tag => {
            const chip = this.selectedContainer.createDiv({ cls: "tag-chip" });
            chip.createSpan({ text: `#${tag}` });
            const close = chip.createSpan({ cls: "tag-chip-close", text: "×" });
            close.onclick = (e) => {
                e.stopPropagation();
                this.toggleTag(tag);
            };
        });
    }

    submit() {
        // Join tags with spaces and #
        const result = Array.from(this.selectedTags).map(t => `#${t}`).join(" ");
        this.onChoose(result);
        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
