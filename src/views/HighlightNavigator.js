import { ItemView, MarkdownView } from "obsidian";
import { getHighlightsFromContent } from "../utils/export";

export const HIGHLIGHT_NAVIGATOR_VIEW = "highlight-navigator";

/**
 * Sidebar view that displays all highlights in the current document.
 * Allows clicking to jump to location and filtering by type/color.
 */
export class HighlightNavigatorView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.highlights = [];
        this.currentFile = null;
    }

    getViewType() {
        return HIGHLIGHT_NAVIGATOR_VIEW;
    }

    getDisplayText() {
        return "Highlights";
    }

    getIcon() {
        return "highlighter";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass("highlight-navigator-container");

        // Header
        const header = container.createDiv({ cls: "highlight-navigator-header" });
        header.createEl("h4", { text: "Highlights" });

        // Refresh button
        const refreshBtn = header.createEl("button", { cls: "clickable-icon" });
        refreshBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;
        refreshBtn.setAttribute("aria-label", "Refresh");
        refreshBtn.onclick = () => this.refresh();

        // Content area
        this.contentEl = container.createDiv({ cls: "highlight-navigator-content" });

        // Export button
        const footer = container.createDiv({ cls: "highlight-navigator-footer" });
        const exportBtn = footer.createEl("button", { text: "Export to MD", cls: "mod-cta" });
        exportBtn.onclick = () => this.exportHighlights();

        // Register for file changes
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                this.refresh();
            })
        );

        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (this.currentFile && file.path === this.currentFile.path) {
                    this.refresh();
                }
            })
        );

        this.refresh();
    }

    async refresh() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (!view || !view.file) {
            this.showEmpty("Open a note to see its highlights.");
            return;
        }

        this.currentFile = view.file;

        try {
            const raw = await this.app.vault.read(view.file);
            this.highlights = getHighlightsFromContent(raw);
            this.renderHighlights();
        } catch (err) {
            this.showEmpty("Error loading highlights.");
            console.error(err);
        }
    }

    showEmpty(message) {
        this.contentEl.empty();
        this.contentEl.createDiv({ cls: "highlight-navigator-empty", text: message });
    }

    renderHighlights() {
        this.contentEl.empty();

        if (this.highlights.length === 0) {
            this.showEmpty("No highlights in this file.");
            return;
        }

        // Stats
        const stats = this.contentEl.createDiv({ cls: "highlight-navigator-stats" });
        stats.createSpan({ text: `${this.highlights.length} highlight${this.highlights.length !== 1 ? "s" : ""}` });

        // List
        const list = this.contentEl.createDiv({ cls: "highlight-navigator-list" });

        this.highlights.forEach((highlight, index) => {
            const item = list.createDiv({ cls: "highlight-navigator-item" });

            // Color indicator
            if (highlight.color) {
                const colorDot = item.createSpan({ cls: "highlight-color-dot" });
                colorDot.style.backgroundColor = highlight.color;
            } else {
                const colorDot = item.createSpan({ cls: "highlight-color-dot highlight-default" });
            }

            // Text preview
            const textPreview = highlight.text.length > 80
                ? highlight.text.substring(0, 80) + "..."
                : highlight.text;

            const textEl = item.createSpan({ cls: "highlight-text", text: textPreview });

            // Number badge
            item.createSpan({ cls: "highlight-number", text: `${index + 1}` });

            // Click to jump
            item.onclick = () => this.jumpToHighlight(highlight);
        });
    }

    async jumpToHighlight(highlight) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;

        // Get the reading view content element
        const previewEl = view.containerEl.querySelector(".markdown-reading-view") ||
            view.containerEl.querySelector(".markdown-preview-view");

        if (!previewEl) return;

        // Find the highlight text in the rendered content
        const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT);
        let node;

        while ((node = walker.nextNode())) {
            if (node.textContent.includes(highlight.text.substring(0, 20))) {
                // Found it - scroll to parent element
                const parent = node.parentElement;
                if (parent) {
                    parent.scrollIntoView({ behavior: "smooth", block: "center" });

                    // Brief highlight effect
                    parent.addClass("highlight-flash");
                    setTimeout(() => parent.removeClass("highlight-flash"), 1000);
                    break;
                }
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
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            console.error(err);
        }
    }

    async onClose() {
        // Cleanup
    }
}
