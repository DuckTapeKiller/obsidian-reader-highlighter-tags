import { ItemView, MarkdownView } from "obsidian";
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
        header.createEl("h4", { text: "Navigator" });

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

        // Content area
        this.contentEl = container.createDiv({ cls: "highlight-navigator-content" });

        // Footer with Export
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
        if (items.length === 0) {
            this.showEmpty(`No ${type} found.`, container);
            return;
        }

        const title = type === "highlights" ? "Highlights" : "Footnotes";
        const stats = container.createDiv({ cls: "highlight-navigator-stats" });
        stats.createSpan({ text: `${items.length} ${title.toLowerCase()}` });

        const list = container.createDiv({ cls: "highlight-navigator-list" });
        const fragment = document.createDocumentFragment();

        items.forEach((item, index) => {
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

            // Text preview
            const textPreview = item.text.length > 80
                ? item.text.substring(0, 80) + "..."
                : item.text;

            const textSpan = document.createElement("span");
            textSpan.addClass("highlight-text");
            textSpan.textContent = textPreview;
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
        // Cleanup if needed
    }
}
