import { AbstractInputSuggest, App, ItemView, MarkdownView, WorkspaceLeaf, TFile } from "obsidian";
import type ReadingHighlighterPlugin from "../main";
import { VaultScanner, type ScanResult } from "../core/VaultScanner";
import { exportHighlightsToCanvas } from "../utils/canvas";
import type { Highlight } from "../utils/highlights";
import { COLOR_LABELS, HIGHLIGHT_COLORS, type HighlightColor } from "../utils/colors";

export const RESEARCH_VIEW = "reader-research-view";

type ResearchHighlight = Highlight & { file: TFile; frontmatter: Record<string, unknown> };

/** A colour filter: one of the native colours, or highlights with none. */
type ColorFilter = HighlightColor | "plain";

/** The filter for highlights without tags; a tag always starts with `#`. */
const UNTAGGED = "untagged";

/** A tag to filter by, as offered while typing. */
interface TagOption {
    /** Lower case with its `#`, or `UNTAGGED`. */
    key: string;
    label: string;
    count: number;
}

/**
 * The tags written in front of a highlight, which is where the Tag button and
 * the tag prefix put them: lower case, each with its `#`. Obsidian's tags
 * ignore case.
 */
export function highlightTags(h: Highlight): string[] {
    return String(h.tagsText || "")
        .split(/\s+/)
        .filter((token) => token.startsWith("#") && token.length > 1)
        .map((token) => token.toLowerCase());
}

/** Whether `tag` is `filter` or nested under it, as `#frases/poesía` under `#frases`. */
export function tagMatches(tag: string, filter: string): boolean {
    return tag === filter || tag.startsWith(`${filter}/`);
}

/** Suggests the tags found on highlights while typing in the tag filter. */
export class TagFilterSuggest extends AbstractInputSuggest<TagOption> {
    view: ResearchView;

    constructor(app: App, inputEl: HTMLInputElement, view: ResearchView) {
        super(app, inputEl);
        this.view = view;
    }

    protected getSuggestions(query: string): TagOption[] {
        const q = query.trim().toLowerCase().replace(/^#/, "");
        return this.view
            .tagOptions()
            .filter((option) => !this.view.activeTags.has(option.key))
            .filter((option) => !q || option.label.toLowerCase().replace(/^#/, "").includes(q));
    }

    renderSuggestion(option: TagOption, el: HTMLElement) {
        el.addClass("research-tag-suggestion");
        el.createSpan({ text: option.label });
        el.createSpan({ cls: "research-tag-count", text: String(option.count) });
    }

    selectSuggestion(option: TagOption) {
        this.setValue("");
        this.close();
        this.view.addTagFilter(option.key);
    }
}

/**
 * Stringify a value that may be anything. Objects have no useful string form —
 * `String({})` is `"[object Object]"` — so they become empty rather than noise.
 */
function asText(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    return "";
}

export class ResearchView extends ItemView {
    plugin: ReadingHighlighterPlugin;
    scanner: VaultScanner;
    scanResults: ScanResult[];
    searchQuery: string;
    filterKey: string;
    filterValue: string;
    allPropertyKeys: Set<string>;
    activeColors: Set<ColorFilter>;
    activeTags: Set<string> = new Set();
    tagChipsEl: HTMLElement | null = null;
    colorFilterEl: HTMLElement | null = null;
    isScanning: boolean;
    expandedFiles: Set<string>;
    progressEl: HTMLElement | null;
    progressTextEl: HTMLElement | null;
    progressContainer!: HTMLElement;
    propertySelect!: HTMLSelectElement;

    constructor(leaf: WorkspaceLeaf, plugin: ReadingHighlighterPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.scanner = new VaultScanner(plugin.app);

        this.scanResults = [];
        this.searchQuery = "";
        this.filterKey = "All Properties"; // default
        this.filterValue = "";
        this.allPropertyKeys = new Set();
        this.activeColors = new Set();
        this.isScanning = false;
        this.expandedFiles = new Set(); // store file.path of expanded files

        this.progressEl = null;
        this.progressTextEl = null;
    }

    getViewType() {
        return RESEARCH_VIEW;
    }

    getDisplayText() {
        return "Global research view";
    }

    getIcon() {
        return "search";
    }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass("research-view-container");

        // Header
        const header = container.createDiv({ cls: "research-view-header" });

        const titleRow = header.createDiv({ cls: "research-view-title-row" });
        titleRow.createEl("h3", { text: "Research view" });

        const scanBtn = titleRow.createEl("button", { text: "Scan vault", cls: "mod-cta" });
        scanBtn.onclick = () => void this.startScan();

        const canvasBtn = titleRow.createEl("button", { text: "Export canvas" });
        canvasBtn.onclick = () => void this.exportToCanvas();

        // Search Bar & Date Filter
        const searchContainer = header.createDiv({ cls: "research-view-search" });

        const searchInput = searchContainer.createEl("input", {
            type: "text",
            placeholder: "Search all highlights...",
            cls: "research-search-input",
        });

        searchInput.oninput = (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
            this.renderContent();
        };

        // Property Filtering Row
        const propertyFilterRow = header.createDiv({ cls: "research-view-property-filter" });

        this.propertySelect = propertyFilterRow.createEl("select", {
            cls: "research-property-select",
        });
        this.updatePropertySelector();

        this.propertySelect.onchange = (e) => {
            this.filterKey = (e.target as HTMLSelectElement).value;
            this.renderContent();
        };

        const propertyInput = propertyFilterRow.createEl("input", {
            type: "text",
            placeholder: "Filter by value...",
            cls: "research-property-input",
        });

        propertyInput.oninput = (e) => {
            this.filterValue = (e.target as HTMLInputElement).value.toLowerCase();
            this.renderContent();
        };

        // Colour filters: filled in from the highlights each scan finds.
        this.colorFilterEl = header.createDiv({ cls: "research-view-color-filters" });

        // Tag filter: the tags written in front of highlights, offered as you
        // type; each one chosen becomes a chip that removes it.
        const tagRow = header.createDiv({ cls: "research-view-tag-filter" });
        const tagInput = tagRow.createEl("input", {
            type: "text",
            placeholder: "Filter by tag...",
            cls: "research-tag-input",
        });
        new TagFilterSuggest(this.app, tagInput, this);
        this.tagChipsEl = tagRow.createDiv({ cls: "research-tag-chips" });

        // Progress bar container (hidden by default)
        this.progressContainer = header.createDiv({
            cls: "research-progress-container",
            attr: { style: "display: none;" },
        });
        this.progressTextEl = this.progressContainer.createDiv({ cls: "research-progress-text" });
        const progressTrack = this.progressContainer.createDiv({ cls: "research-progress-track" });
        this.progressEl = progressTrack.createDiv({ cls: "research-progress-bar" });

        // Content Area
        this.contentEl = container.createDiv({ cls: "research-view-content" });

        // Auto-scan on open so all highlights display by default
        void this.startScan();
    }

    async startScan() {
        if (this.isScanning) return;

        this.isScanning = true;
        this.progressContainer.setCssStyles({ display: "block" });
        this.contentEl.empty();

        try {
            this.scanResults = await this.scanner.scanVault((current, total, lastFile) => {
                const percent = Math.round((current / total) * 100);
                this.progressEl?.setCssStyles({ width: `${percent}%` });
                if (this.progressTextEl) {
                    this.progressTextEl.textContent = `Scanning: ${current}/${total} (${percent}%) - ${lastFile}...`;
                }
            });

            // Collect all property keys
            this.allPropertyKeys.clear();
            this.allPropertyKeys.add("All Properties");
            for (const res of this.scanResults) {
                if (res.frontmatter) {
                    Object.keys(res.frontmatter).forEach((key) => this.allPropertyKeys.add(key));
                }
            }
            this.updatePropertySelector();

            // Expand first file automatically if any
            if (this.scanResults.length > 0) {
                this.expandedFiles.add(this.scanResults[0].file.path);
            }
        } catch (err) {
            console.error(err);
            this.contentEl.createDiv({
                text: "Error during scan: " + (err instanceof Error ? err.message : String(err)),
                cls: "research-error",
            });
        } finally {
            this.isScanning = false;
            this.progressContainer.setCssStyles({ display: "none" });
            this.renderColorFilters();
            this.renderTagFilter();
            this.renderContent();
        }
    }

    /**
     * Every tag found on a highlight, with its parents, so that `#frases` can
     * be chosen when only `#frases/poesía` is written; and highlights without
     * tags. Most used first.
     */
    tagOptions(): TagOption[] {
        const highlights = this.collectHighlights();
        const counts = new Map<string, { label: string; count: number }>();
        let untagged = 0;
        for (const h of highlights) {
            const original = String(h.tagsText || "")
                .split(/\s+/)
                .filter((token) => token.startsWith("#") && token.length > 1);
            if (!original.length) untagged++;
            const keys = new Map<string, string>();
            for (const tag of original) {
                const parts = tag.split("/");
                for (let i = 1; i <= parts.length; i++) {
                    const label = parts.slice(0, i).join("/");
                    keys.set(label.toLowerCase(), label);
                }
            }
            // A highlight counts once per tag, however many of its tags nest under it.
            for (const [key, label] of keys) {
                const entry = counts.get(key) ?? { label, count: 0 };
                entry.count++;
                counts.set(key, entry);
            }
        }
        const options: TagOption[] = [...counts].map(([key, { label, count }]) => ({ key, label, count }));
        options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        if (untagged) options.push({ key: UNTAGGED, label: "Untagged", count: untagged });
        return options;
    }

    addTagFilter(key: string) {
        this.activeTags.add(key);
        this.renderTagFilter();
        this.renderContent();
    }

    /** The chips for the tags chosen; a chip removes its tag when clicked. */
    renderTagFilter() {
        const el = this.tagChipsEl;
        if (!el) return;
        el.empty();
        const options = new Map(this.tagOptions().map((option) => [option.key, option]));
        // A tag the scan no longer finds would hide everything.
        for (const key of [...this.activeTags]) if (!options.has(key)) this.activeTags.delete(key);
        for (const key of this.activeTags) {
            const chip = el.createEl("button", { cls: "research-tag-chip is-active" });
            chip.createSpan({ text: options.get(key)?.label ?? key });
            chip.createSpan({ cls: "research-tag-chip-remove", text: "×" });
            chip.setAttribute("aria-label", `Remove ${options.get(key)?.label ?? key}`);
            chip.onclick = () => {
                this.activeTags.delete(key);
                this.renderTagFilter();
                this.renderContent();
            };
        }
    }

    /**
     * Whether a highlight passes the tag filter: none chosen passes all;
     * otherwise any chosen tag, or one nested under it, or Untagged for a
     * highlight with none.
     */
    matchesTagFilter(h: Highlight): boolean {
        if (this.activeTags.size === 0) return true;
        const tags = highlightTags(h);
        if (!tags.length) return this.activeTags.has(UNTAGGED);
        return tags.some((tag) =>
            [...this.activeTags].some((filter) => filter !== UNTAGGED && tagMatches(tag, filter))
        );
    }

    /** Search matches the highlighted text and the highlight's tags. */
    matchesSearch(h: Highlight): boolean {
        if (!this.searchQuery) return true;
        return (
            h.text.toLowerCase().includes(this.searchQuery) ||
            highlightTags(h).some((tag) => tag.includes(this.searchQuery))
        );
    }

    /** The highlights every filter lets through: properties, search, colour and tag. */
    filteredHighlights(): ResearchHighlight[] {
        return this.applyPropertyFilter(this.collectHighlights()).filter(
            (h) => this.matchesSearch(h) && this.matchesColorFilter(h) && this.matchesTagFilter(h)
        );
    }

    /**
     * One chip per colour the scan found, labelled with its meaning when it has
     * one, and one for highlights in the theme's default colour. Built from the
     * highlights, not the settings: a colour without a meaning, or with the
     * toolbar's palette switched off, is still something to filter by.
     */
    renderColorFilters() {
        const el = this.colorFilterEl;
        if (!el) return;
        el.empty();
        const found = new Set<ColorFilter>(this.collectHighlights().map((h) => h.color ?? "plain"));
        // A filter for a colour the scan no longer finds would hide everything.
        for (const key of [...this.activeColors]) if (!found.has(key)) this.activeColors.delete(key);
        for (const key of [...HIGHLIGHT_COLORS, "plain"] as ColorFilter[]) {
            if (!found.has(key)) continue;
            const chip = el.createEl("button", { cls: "research-color-chip" });
            chip.toggleClass("is-active", this.activeColors.has(key));
            this.colorDot(chip, key);
            chip.createSpan({ text: this.colorFilterLabel(key) });
            chip.onclick = () => {
                if (this.activeColors.has(key)) this.activeColors.delete(key);
                else this.activeColors.add(key);
                chip.toggleClass("is-active", this.activeColors.has(key));
                this.renderContent();
            };
        }
    }

    colorFilterLabel(key: ColorFilter): string {
        if (key === "plain") return "Theme default";
        const meaning = this.plugin.settings.semanticColors.find((c) => c.color === key)?.meaning?.trim();
        return meaning || COLOR_LABELS[key];
    }

    /** Whether a highlight passes the colour filter; none chosen passes all. */
    matchesColorFilter(h: Highlight): boolean {
        return this.activeColors.size === 0 || this.activeColors.has(h.color ?? "plain");
    }

    updatePropertySelector() {
        if (!this.propertySelect) return;
        const currentVal = this.filterKey;
        this.propertySelect.empty();

        const sortedKeys = Array.from(this.allPropertyKeys).sort((a, b) => {
            if (a === "All Properties") return -1;
            if (b === "All Properties") return 1;
            return a.localeCompare(b);
        });

        sortedKeys.forEach((key) => {
            const opt = this.propertySelect.createEl("option", { text: key, value: key });
            if (key === currentVal) opt.selected = true;
        });
    }

    private collectHighlights(): ResearchHighlight[] {
        const allHighlights: ResearchHighlight[] = [];
        for (const res of this.scanResults) {
            for (const h of res.highlights) {
                allHighlights.push({ ...h, file: res.file, frontmatter: res.frontmatter });
            }
        }
        return allHighlights;
    }

    private applyPropertyFilter(highlights: ResearchHighlight[]): ResearchHighlight[] {
        if (!(this.filterKey && this.filterKey !== "All Properties" && this.filterValue)) {
            return highlights;
        }
        const filterVal = this.filterValue.toLowerCase().replace(/^#/, "");
        return highlights.filter((h) => {
            const val = h.frontmatter?.[this.filterKey];
            if (val === undefined || val === null) return false;

            // Handle Tags specifically
            if (this.filterKey === "tags" || this.filterKey === "tag") {
                if (Array.isArray(val)) {
                    return (val as unknown[]).some((t) =>
                        asText(t).toLowerCase().replace(/^#/, "").includes(filterVal)
                    );
                }
                return asText(val).toLowerCase().replace(/^#/, "").includes(filterVal);
            }

            // Handle Arrays
            if (Array.isArray(val)) {
                return (val as unknown[]).some((v) => asText(v).toLowerCase().includes(filterVal));
            }

            // Default string match
            return asText(val).toLowerCase().includes(filterVal);
        });
    }

    renderContent() {
        if (this.isScanning) return;

        this.contentEl.empty();

        if (this.scanResults.length === 0) {
            this.contentEl.createDiv({
                cls: "research-empty",
                text: "No highlights found. Click 'Scan Vault' to analyze.",
            });
            return;
        }

        const totalHighlights = this.collectHighlights().length;
        const allHighlights = this.filteredHighlights();

        // Stats summary
        const statsRow = this.contentEl.createDiv({ cls: "research-stats" });

        if (this.searchQuery) {
            // Group filtered results by file for the detailed view
            const fileMap = new Map<string, { file: TFile; highlights: ResearchHighlight[] }>();
            for (const h of allHighlights) {
                if (!fileMap.has(h.file.path)) {
                    fileMap.set(h.file.path, { file: h.file, highlights: [] });
                }
                fileMap.get(h.file.path).highlights.push(h);
            }
            const filteredGroups = [...fileMap.values()];
            const fileCount = filteredGroups.length;

            statsRow.textContent = `Found ${allHighlights.length} highlights in ${fileCount} files (filtered from ${totalHighlights}).`;

            // Render grouped/expanded view when searching
            for (const group of filteredGroups) {
                const groupEl = this.contentEl.createDiv({ cls: "research-group" });

                const headerEl = groupEl.createDiv({ cls: "research-group-header" });

                const expandIcon = headerEl.createSpan({ cls: "research-expand-icon" });
                expandIcon.setText("▼");

                headerEl.createSpan({ cls: "research-group-title", text: group.file.basename });
                headerEl.createSpan({ cls: "research-group-badge", text: `${group.highlights.length}` });

                const listEl = groupEl.createDiv({ cls: "research-highlight-list" });

                group.highlights.forEach((h) => {
                    const itemEl = listEl.createDiv({ cls: "research-highlight-item" });

                    if (h.color) this.colorDot(itemEl, h.color);

                    itemEl.createSpan({ cls: "research-item-text", text: h.text });

                    itemEl.onclick = (e) => {
                        e.stopPropagation();
                        void this.jumpToHighlight(group.file, h.line);
                    };
                });
            }
        } else {
            // Default: simplified flat list of all highlights
            const totalFileCount = this.scanResults.length;
            // With a colour or property filter on, count what is listed, not
            // the whole vault.
            if (allHighlights.length !== totalHighlights) {
                const fileCount = new Set(allHighlights.map((h) => h.file.path)).size;
                statsRow.textContent = `${allHighlights.length} of ${totalHighlights} highlights, in ${fileCount} of ${totalFileCount} files.`;
            } else {
                statsRow.textContent = `${totalHighlights} highlights across ${totalFileCount} files.`;
            }

            const listEl = this.contentEl.createDiv({ cls: "research-highlight-list research-flat-list" });

            for (const h of allHighlights) {
                const itemEl = listEl.createDiv({ cls: "research-highlight-item" });

                // Color dot
                if (h.color) this.colorDot(itemEl, h.color);

                // Highlight text (truncated for readability)
                const displayText = h.text.length > 120 ? h.text.substring(0, 120) + "..." : h.text;
                itemEl.createSpan({ cls: "research-item-text", text: displayText });

                // Source file badge
                itemEl.createSpan({ cls: "research-source-badge", text: h.file.basename });

                // Click to jump
                itemEl.onclick = (e) => {
                    e.stopPropagation();
                    void this.jumpToHighlight(h.file, h.line);
                };
            }
        }
    }

    /** A dot in the native colour, drawn from the theme's own colour variables. */
    colorDot(parent: HTMLElement, color: ColorFilter) {
        parent.createSpan({
            cls: "research-color-dot highlight-swatch reading-highlighter-swatch",
            attr: { "data-highlight": color },
        });
    }

    async jumpToHighlight(file: TFile, line: number) {
        // Open file in new leaf/tab OR current active
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(file);

        if (leaf.view instanceof MarkdownView) {
            leaf.setEphemeralState({
                line: line,
                focus: true,
            });
        }
    }

    async exportToCanvas() {
        if (this.isScanning) return;

        const allHighlights = this.filteredHighlights();

        if (allHighlights.length === 0) {
            this.plugin.notify("No highlights to export to canvas.");
            return;
        }

        try {
            this.plugin.notify("Generating canvas...");
            const exportPath = await exportHighlightsToCanvas(this.app, allHighlights);
            const file = this.app.vault.getAbstractFileByPath(exportPath);
            if (file instanceof TFile) {
                const leaf = this.app.workspace.getLeaf("tab");
                await leaf.openFile(file);
            }
        } catch (e) {
            console.error(e);
        }
    }
}
