import { Modal } from "obsidian";
import type ReadingHighlighterPlugin from "../main";

interface MetadataCacheWithTags {
    getTags(): Record<string, number>;
}

/**
 * Multi-select tag modal with fuzzy search and smart suggestions.
 */
export class TagSuggestModal extends Modal {
    plugin: ReadingHighlighterPlugin;
    onChoose: (result: string) => void | Promise<void>;
    selectedTags: Set<string>;
    suggestions: string[];
    query: string;
    suggestionEl: HTMLElement | null;
    selectedContainer: HTMLElement | null;
    smartSuggestionEl: HTMLElement | null;
    allTags: string[] = [];

    constructor(plugin: ReadingHighlighterPlugin, onChoose: (result: string) => void | Promise<void>) {
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
        const { contentEl, modalEl } = this;
        contentEl.addClass("reading-highlighter-tag-modal");
        modalEl.addClass("reading-highlighter-tag-modal");

        contentEl.createEl("h2", { text: "Add Tags" });

        // Smart suggestions section (if enabled)
        if (this.plugin.settings.enableSmartTagSuggestions) {
            const smartTags = this.getSuggestedTags();
            if (smartTags.length > 0) {
                this.smartSuggestionEl = contentEl.createDiv({ cls: "smart-suggestions-container" });
                this.smartSuggestionEl.createEl("span", { text: "Suggestions: ", cls: "smart-suggestions-label" });

                const chipsContainer = this.smartSuggestionEl.createDiv({ cls: "smart-suggestions-chips" });
                smartTags.forEach((tag) => {
                    const chip = chipsContainer.createEl("button", {
                        text: `#${tag}`,
                        cls: "smart-suggestion-chip",
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

        // Search Input with Done button inline
        const inputContainer = contentEl.createDiv({ cls: "tag-search-input-container" });
        const input = inputContainer.createEl("input", {
            type: "text",
            cls: "tag-search-input",
            attr: { placeholder: "Search or create tag..." },
        });
        const doneBtn = inputContainer.createEl("button", { text: "Done", cls: "mod-cta tag-done-btn" });

        // Focus input
        window.setTimeout(() => input.focus(), 50);

        // Results List
        this.suggestionEl = contentEl.createDiv({ cls: "tag-suggestions-list" });

        doneBtn.onclick = () => this.submit();

        // Load correct tags (getTags is not in the public typings)
        const tagCounts = (this.app.metadataCache as unknown as MetadataCacheWithTags).getTags();
        this.allTags = Object.keys(tagCounts).map((t) => t.substring(1)); // strip #

        // Handlers
        input.addEventListener("input", (e) => {
            this.query = (e.target as HTMLInputElement).value;
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
    getSuggestedTags(): string[] {
        const suggestions: string[] = [];

        // 1. Folder-based suggestion
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

        // 2. Frontmatter tags
        if (activeFile) {
            const cache = this.app.metadataCache.getFileCache(activeFile);
            const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
            const tagsValue = frontmatter?.tags;
            if (tagsValue) {
                const fmTags: unknown[] = Array.isArray(tagsValue) ? tagsValue : [tagsValue];
                fmTags.forEach((tag) => {
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

    renderSuggestions(query: string) {
        this.suggestionEl!.empty();
        const cleanQuery = query.toLowerCase().replace(/\s+/g, "_");

        // Filter tags
        const matches = this.allTags.filter((t) => t.toLowerCase().includes(cleanQuery));

        // Exact Match / Create Logic
        const isExact = matches.some((t) => t.toLowerCase() === cleanQuery);

        if (cleanQuery && !isExact) {
            // Add creation option at top
            this.renderItem(cleanQuery, true);
        }

        // Limit to 50 for performance
        matches.slice(0, 50).forEach((tag) => {
            if (!this.selectedTags.has(tag)) {
                this.renderItem(tag, false);
            }
        });
    }

    renderItem(tag: string, isNew: boolean) {
        const el = this.suggestionEl!.createDiv({ cls: "suggestion-item" });
        el.createSpan({ text: isNew ? `#${tag}` : `#${tag}` });
        if (isNew) {
            el.createSpan({ text: " (Create new)", cls: "suggestion-note" });
        }

        el.addEventListener("click", () => {
            this.toggleTag(tag);
            this.query = "";
            const searchInput = this.contentEl.querySelector<HTMLInputElement>(".tag-search-input");
            if (searchInput) {
                searchInput.value = "";
                searchInput.focus();
            }
            this.renderSuggestions("");
        });
    }

    toggleTag(tag: string) {
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
        this.selectedContainer!.empty();

        if (this.selectedTags.size === 0) {
            this.selectedContainer!.createSpan({
                text: "No tags selected",
                cls: "no-tags-hint",
            });
            return;
        }

        this.selectedTags.forEach((tag) => {
            const chip = this.selectedContainer!.createDiv({ cls: "tag-chip" });
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
        const result = Array.from(this.selectedTags)
            .map((t) => `#${t}`)
            .join(" ");
        void this.onChoose(result);
        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
