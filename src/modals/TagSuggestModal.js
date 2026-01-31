import { Modal } from "obsidian";

/**
 * Multi-select tag modal with fuzzy search and smart suggestions.
 */
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
        this.smartSuggestionEl = null;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass("reading-highlighter-tag-modal");

        contentEl.createEl("h2", { text: "Add Tags" });

        // Smart suggestions section (if enabled)
        if (this.plugin.settings.enableSmartTagSuggestions) {
            const smartTags = this.getSuggestedTags();
            if (smartTags.length > 0) {
                this.smartSuggestionEl = contentEl.createDiv({ cls: "smart-suggestions-container" });
                this.smartSuggestionEl.createEl("span", { text: "Suggestions: ", cls: "smart-suggestions-label" });

                const chipsContainer = this.smartSuggestionEl.createDiv({ cls: "smart-suggestions-chips" });
                smartTags.forEach(tag => {
                    const chip = chipsContainer.createEl("button", {
                        text: `#${tag}`,
                        cls: "smart-suggestion-chip"
                    });
                    chip.onclick = () => {
                        this.toggleTag(tag);
                        chip.addClass("selected");
                    };
                });
            }
        }

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
                if (this.query.trim()) {
                    this.toggleTag(this.query.trim());
                    this.query = "";
                    input.value = "";
                    this.renderSuggestions("");
                }
            } else if (e.key === "Escape") {
                this.close();
            }
        });

        this.renderSuggestions("");
    }

    /**
     * Get smart tag suggestions based on:
     * 1. Recent tags (MRU)
     * 2. Current folder name
     * 3. Frontmatter tags
     */
    getSuggestedTags() {
        const suggestions = [];

        // 1. Recent tags (MRU)
        if (this.plugin.settings.recentTags?.length > 0) {
            suggestions.push(...this.plugin.settings.recentTags.slice(0, 5));
        }

        // 2. Folder-based suggestion
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile?.parent?.name && activeFile.parent.name !== "/") {
            const folderTag = activeFile.parent.name
                .toLowerCase()
                .replace(/\s+/g, "-")
                .replace(/[^a-z0-9-_]/g, "");
            if (folderTag && !suggestions.includes(folderTag)) {
                suggestions.push(folderTag);
            }
        }

        // 3. Frontmatter tags
        if (activeFile) {
            const cache = this.app.metadataCache.getFileCache(activeFile);
            if (cache?.frontmatter?.tags) {
                const fmTags = Array.isArray(cache.frontmatter.tags)
                    ? cache.frontmatter.tags
                    : [cache.frontmatter.tags];
                fmTags.forEach(tag => {
                    const cleanTag = String(tag).replace(/^#/, "");
                    if (cleanTag && !suggestions.includes(cleanTag)) {
                        suggestions.push(cleanTag);
                    }
                });
            }
        }

        // Dedupe and limit
        return [...new Set(suggestions)].slice(0, 8);
    }

    renderSuggestions(query) {
        this.suggestionEl.empty();
        const cleanQuery = query.toLowerCase().replace(/\s+/g, "_");

        // Filter tags
        let matches = this.allTags.filter(t => t.toLowerCase().includes(cleanQuery));

        // Exact Match / Create Logic
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
        el.createSpan({ text: isNew ? `#${tag}` : `#${tag}` });
        if (isNew) {
            el.createSpan({ text: " (Create new)", cls: "suggestion-note" });
        }

        el.addEventListener("click", () => {
            this.toggleTag(tag);
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

        if (this.selectedTags.size === 0) {
            this.selectedContainer.createSpan({
                text: "No tags selected",
                cls: "no-tags-hint"
            });
            return;
        }

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
