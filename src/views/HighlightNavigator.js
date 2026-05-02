import { ItemView, MarkdownView, Platform } from "obsidian";
import { getHighlightsFromContent } from "../utils/export";

export const HIGHLIGHT_NAVIGATOR_VIEW = "highlight-navigator";

/**
 * Enhanced Sidebar view that displays all highlights and footnotes in the current document.
 * Includes tabbed switching and split views for premium navigator experience.
 */
export class HighlightNavigatorView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.highlights = [];
        this.footnotes = [];
        this.currentFile = null;
        this.viewMode = "highlights"; // 'highlights', 'footnotes', or 'split'
        this.searchQuery = ""; // Search filter
    }

    getViewType() {
        return HIGHLIGHT_NAVIGATOR_VIEW;
    }

    getDisplayText() {
        return "Highlights";
    }

    getIcon() {
        return "lamp";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass("highlight-navigator-container");

        // Header
        const header = container.createDiv({ cls: "highlight-navigator-header" });

        // View Mode Switcher
        const btnGroup = header.createDiv({ cls: "highlight-navigator-btn-group" });
        const modes = [
            { label: "Highlights", value: "highlights" },
            { label: "Footnotes", value: "footnotes" },
            { label: "Both", value: "split" }
        ];

        modes.forEach((m) => {
            const btn = btnGroup.createEl("button", { text: m.label, cls: "nav-btn" });
            if (this.viewMode === m.value) btn.addClass("is-active");
            
            btn.onclick = () => {
                btnGroup.querySelectorAll(".nav-btn").forEach((el) => el.removeClass("is-active"));
                btn.addClass("is-active");
                this.viewMode = m.value;
                this.renderContent();
            };
        });

        // Search Bar
        const searchContainer = container.createDiv({ cls: "highlight-navigator-search" });
        const searchInput = searchContainer.createEl("input", { 
            type: "text", 
            placeholder: "Search...",
            cls: "nav-search-input"
        });
        searchInput.oninput = (e) => {
            this.searchQuery = e.target.value.toLowerCase();
            this.renderContent();
        };

        // Content area
        this.contentEl = container.createDiv({ cls: "highlight-navigator-content" });

        // Footer with Export + Scan Vault
        const footer = container.createDiv({ cls: "highlight-navigator-footer" });
        const footerBtnGroup = footer.createDiv({ cls: "highlight-navigator-footer-buttons" });

        const exportBtn = footerBtnGroup.createEl("button", { text: "Export MD", cls: "mod-cta" });
        exportBtn.onclick = () => this.exportHighlights();

        const canvasBtn = footerBtnGroup.createEl("button", { text: "Canvas", cls: "mod-cta" });
        canvasBtn.onclick = () => this.exportCurrentFileToCanvas();

        const scanBtn = footerBtnGroup.createEl("button", { text: "Scan Vault", cls: "mod-cta" });
        scanBtn.onclick = () => this.plugin.activateResearchView();

        // Register for file changes
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                this.refresh();
            })
        );

        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (this.currentFile && file.path === this.currentFile.path) {
                    this.refresh(true);
                }
            })
        );

        this.refresh();
    }

    async refresh(force = false) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);

        // Prevent wiping list on brief focus loss
        if (!view || !view.file) {
            return;
        }

        // Only re-parse if file changed or forced (on modify)
        if (!force && this.currentFile && view.file.path === this.currentFile.path) {
            return;
        }

        this.currentFile = view.file;

        try {
            const raw = await this.app.vault.read(view.file);
            this.highlights = getHighlightsFromContent(raw);
            this.footnotes = this.getFootnotesFromContent(raw);
            this.renderContent();
        } catch (err) {
            this.showEmpty("Error loading content.");
            console.error(err);
        }
    }

    getFootnotesFromContent(raw) {
        const footnotes = [];
        const lines = raw.split("\n");
        // Matches [^id]: text
        const pattern = /\[\^([^\]]+)\]:\s*([^\n]+)/g;

        lines.forEach((line, lineIdx) => {
            let match;
            while ((match = pattern.exec(line)) !== null) {
                footnotes.push({
                    id: match[1],
                    text: match[2].trim(),
                    line: lineIdx
                });
            }
        });
        return footnotes;
    }

    showEmpty(message, container = this.contentEl) {
        container.empty();
        container.createDiv({ cls: "highlight-navigator-empty", text: message });
    }

    stripMarkdown(text) {
        if (!text) return "";
        return text
            .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1") // [[Link]] or [[Link|Alias]] -> Link/Alias
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [Link](URL) -> Link
            .replace(/[*_~`]+/g, ""); // Bold, Italics, Strikethrough, Code
    }

    renderContent() {
        this.contentEl.empty();
        this.contentEl.removeClass("split-view");

        if (this.viewMode === "highlights") {
            this.renderList(this.contentEl, this.highlights, "highlights");
        } else if (this.viewMode === "footnotes") {
            this.renderList(this.contentEl, this.footnotes, "footnotes");
        } else if (this.viewMode === "split") {
            this.contentEl.addClass("split-view");
            const topHalf = this.contentEl.createDiv({ cls: "split-half split-top" });
            const bottomHalf = this.contentEl.createDiv({ cls: "split-half split-bottom" });
            this.renderList(topHalf, this.highlights, "highlights");
            this.renderList(bottomHalf, this.footnotes, "footnotes");
        }
    }

    renderList(container, items, type) {
        // Filter items based on search query
        const filteredItems = items.filter(item => {
            if (!this.searchQuery) return true;
            return item.text.toLowerCase().includes(this.searchQuery);
        });

        if (filteredItems.length === 0) {
            if (this.searchQuery) {
                this.showEmpty(`No matches for "${this.searchQuery}".`, container);
            } else {
                this.showEmpty(`No ${type} found.`, container);
            }
            return;
        }

        const title = type === "highlights" ? "Highlights" : "Footnotes";
        const stats = container.createDiv({ cls: "highlight-navigator-stats" });
        
        let statsText = `${filteredItems.length} ${title.toLowerCase()}`;
        if (this.searchQuery && filteredItems.length !== items.length) {
            statsText += ` (filtered from ${items.length})`;
        }
        stats.createSpan({ text: statsText });

        const list = container.createDiv({ cls: "highlight-navigator-list" });
        const fragment = document.createDocumentFragment();

        filteredItems.forEach((item, index) => {
            const el = document.createElement("div");
            el.addClass("highlight-navigator-item");

            if (type === "highlights") {
                // Color indicator
                if (item.color) {
                    const colorDot = document.createElement("span");
                    colorDot.addClass("highlight-color-dot");
                    colorDot.style.backgroundColor = item.color;
                    el.appendChild(colorDot);
                } else {
                    const colorDot = document.createElement("span");
                    colorDot.addClass("highlight-color-dot", "highlight-default");
                    el.appendChild(colorDot);
                }
            } else {
                // Footnote ID indicator
                const idSpan = document.createElement("span");
                idSpan.addClass("footnote-id");
                idSpan.textContent = `[${item.id}] `;
                idSpan.style.marginRight = "5px";
                idSpan.style.color = "var(--text-muted)";
                el.appendChild(idSpan);
            }

            const textSpan = document.createElement("span");
            textSpan.addClass("highlight-text");
            textSpan.textContent = this.stripMarkdown(item.text);
            el.appendChild(textSpan);

            if (type === "highlights") {
                // Number badge
                const numberBadge = document.createElement("span");
                numberBadge.addClass("highlight-number");
                numberBadge.textContent = `${index + 1}`;
                el.appendChild(numberBadge);
            }

            // Click to jump to line
            el.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.jumpToLine(item.line);
            };

            fragment.appendChild(el);
        });

        list.appendChild(fragment);
    }

    async jumpToLine(line) {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (leaf && leaf.view instanceof MarkdownView) {
            leaf.setEphemeralState({ 
                line: line,
                focus: true 
            });
        }

        // Close the panel (collapse sidebar) on mobile only
        if (Platform.isMobile) {
            const root = this.leaf.getRoot();
            if (root === this.app.workspace.leftSplit) {
                this.app.workspace.leftSplit.collapse();
            } else if (root === this.app.workspace.rightSplit) {
                this.app.workspace.rightSplit.collapse();
            }
        }
    }

    async exportHighlights() {
        if (!this.currentFile) return;

        try {
            const { exportHighlightsToMD } = await import("../utils/export");
            const exportPath = await exportHighlightsToMD(this.app, this.currentFile);

            // Open the exported file
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile) {
                await this.app.workspace.getLeaf('tab').openFile(exportFile);
            }
        } catch (err) {
            console.error(err);
        }
    }

    async exportCurrentFileToCanvas() {
        if (!this.currentFile) return;

        try {
            const { exportHighlightsToCanvas } = await import("../utils/canvas");
            
            // Map current highlights to the format expected by canvas util
            const highlights = this.highlights.map(h => ({
                ...h,
                file: this.currentFile
            }));

            if (highlights.length === 0) {
                const { Notice } = require("obsidian");
                new Notice("No highlights to export.");
                return;
            }

            const { Notice } = require("obsidian");
            new Notice("Generating Canvas...");
            const exportPath = await exportHighlightsToCanvas(this.app, highlights);
            
            const file = this.app.vault.getAbstractFileByPath(exportPath);
            if (file) {
                await this.app.workspace.getLeaf('tab').openFile(file);
            }
        } catch (err) {
            console.error(err);
        }
    }

    async onClose() {
        // Cleanup if needed
    }
}
