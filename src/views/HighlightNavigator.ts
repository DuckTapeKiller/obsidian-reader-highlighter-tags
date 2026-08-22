import {
    ItemView,
    MarkdownView,
    Menu,
    MenuItem,
    Notice,
    Platform,
    WorkspaceLeaf,
    TFile,
    TAbstractFile,
} from "obsidian";
import type ReadingHighlighterPlugin from "../main";
import { getHighlightsFromContent } from "../utils/export";
import type { Highlight } from "../utils/highlights";
import { parseHighlights, findHighlightById, removeHighlightFromRaw } from "../utils/highlights";
import type { HighlightWithFile } from "../utils/canvas";
import { HighlightEditModal } from "../modals/HighlightEditModal";
import { BulkRecolorModal } from "../modals/BulkRecolorModal";

export const HIGHLIGHT_NAVIGATOR_VIEW = "highlight-navigator";

interface NavFootnote {
    id: string;
    text: string;
    line: number;
    displayNumber: number | null;
    refLine: number;
}

type NavItem = Highlight | NavFootnote;
type ListType = "highlights" | "footnotes";

/**
 * Enhanced Sidebar view that displays all highlights and footnotes in the current document.
 * Includes tabbed switching and split views for premium navigator experience.
 */
export class HighlightNavigatorView extends ItemView {
    plugin: ReadingHighlighterPlugin;
    highlights: Highlight[];
    footnotes: NavFootnote[];
    currentFile: TFile | null;
    viewMode: string;
    searchQuery: string;

    constructor(leaf: WorkspaceLeaf, plugin: ReadingHighlighterPlugin) {
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
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass("highlight-navigator-container");

        // Header
        const header = container.createDiv({ cls: "highlight-navigator-header" });

        // View Mode Switcher
        const btnGroup = header.createDiv({ cls: "highlight-navigator-btn-group" });
        const modes = [
            { label: "Highlights", value: "highlights" },
            { label: "Footnotes", value: "footnotes" },
            { label: "Both", value: "split" },
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
            cls: "nav-search-input",
        });
        searchInput.oninput = (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
            this.renderContent();
        };

        // Content area
        this.contentEl = container.createDiv({ cls: "highlight-navigator-content" });

        // Footer with Export + Scan Vault
        const footer = container.createDiv({ cls: "highlight-navigator-footer" });
        const footerBtnGroup = footer.createDiv({ cls: "highlight-navigator-footer-buttons" });

        const exportBtn = footerBtnGroup.createEl("button", { text: "Export md", cls: "mod-cta" });
        exportBtn.onclick = () => void this.exportHighlights();
        exportBtn.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openExportMenu(e);
        };

        const canvasBtn = footerBtnGroup.createEl("button", { text: "Canvas", cls: "mod-cta" });
        canvasBtn.onclick = () => void this.exportCurrentFileToCanvas();

        const scanBtn = footerBtnGroup.createEl("button", { text: "Scan vault", cls: "mod-cta" });
        scanBtn.onclick = () => void this.plugin.activateResearchView();

        const bulkBtn = footerBtnGroup.createEl("button", { text: "Bulk", cls: "mod-cta" });
        bulkBtn.onclick = (e) => this.openBulkMenu(e);

        // Register for file changes
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                void this.refresh();
            })
        );

        this.registerEvent(
            this.app.vault.on("modify", (file: TAbstractFile) => {
                if (this.currentFile && file.path === this.currentFile.path) {
                    void this.refresh(true);
                }
            })
        );

        void this.refresh();
    }

    async refresh(force = false) {
        let targetFile: TFile | null;

        if (force) {
            // Forced refresh (after an edit/removal, or on a modify event):
            // re-read the file we're already showing. Interacting with this
            // sidebar makes it the active leaf, so there may be no active
            // MarkdownView to read from — fall back to currentFile.
            targetFile = this.currentFile || this.app.workspace.getActiveViewOfType(MarkdownView)?.file || null;
            if (!targetFile) {
                return;
            }
        } else {
            // Following the active note (e.g. user switched files).
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);

            // Prevent wiping list on brief focus loss
            if (!view || !view.file) {
                return;
            }

            // Only re-parse if the file actually changed.
            if (this.currentFile && view.file.path === this.currentFile.path) {
                return;
            }

            targetFile = view.file;
        }

        this.currentFile = targetFile;

        try {
            const raw = await this.app.vault.read(targetFile);
            this.highlights = getHighlightsFromContent(raw);
            this.footnotes = this.getFootnotesFromContent(raw);
            this.renderContent();
        } catch (err) {
            this.showEmpty("Error loading content.");
            console.error(err);
        }
    }

    getFootnotesFromContent(raw: string): NavFootnote[] {
        const lines = raw.split("\n");

        // Pass 1: collect definitions `[^id]: text` (one per line).
        const definitions: { id: string; text: string; line: number }[] = [];
        const definedIds = new Set<string>();
        lines.forEach((line, lineIdx) => {
            const match = line.match(/^\s*\[\^([^\]]+)\]:\s*(.+)$/);
            if (match) {
                definitions.push({ id: match[1], text: match[2].trim(), line: lineIdx });
                definedIds.add(match[1]);
            }
        });

        // Pass 2: walk inline references `[^id]` (the `(?!:)` lookahead skips
        // definitions) in document order. This reproduces Obsidian's Reading
        // View numbering: each *defined* id gets the next sequential number on
        // its first appearance; repeats reuse it; undefined refs (e.g. `[^foo]`
        // with no definition) render as plain text and get no number. We also
        // record the first reference line as the jump target, since the
        // reference lives in the body and scrolls reliably (the definition
        // section at the bottom is not line-addressable in Reading View).
        const displayNumberById = new Map<string, number>();
        const refLineById = new Map<string, number>();
        let nextNumber = 1;
        lines.forEach((line, lineIdx) => {
            const refRe = /\[\^([^\]]+)\](?!:)/g;
            let m: RegExpExecArray | null;
            while ((m = refRe.exec(line)) !== null) {
                const id = m[1];
                if (!definedIds.has(id)) continue;
                if (!refLineById.has(id)) refLineById.set(id, lineIdx);
                if (!displayNumberById.has(id)) displayNumberById.set(id, nextNumber++);
            }
        });

        let footnotes: NavFootnote[] = definitions.map((def) => ({
            ...def,
            displayNumber: displayNumberById.has(def.id) ? displayNumberById.get(def.id) : null,
            refLine: refLineById.has(def.id) ? refLineById.get(def.id) : def.line,
        }));

        // Orphan handling is SCOPED, so normal notes are never affected.
        // "Grouped-notes style" notes — i.e. the Obsidian Web Clipper output,
        // which always defines a `[^0]` catch-all — produce many unreferenced
        // definitions (references that only existed inside removed tables/
        // figures/infoboxes). For those notes only, hide the orphans so every
        // entry has a clean sequential number matching Reading View. A normal,
        // hand-written note has no `[^0]` marker, so all of its definitions stay
        // visible exactly as before (orphans show their `[^id]`).
        const isGroupedNotesStyle = definedIds.has("0");
        if (isGroupedNotesStyle) {
            footnotes = footnotes.filter((f) => f.displayNumber != null);
        }

        // Order to match Reading View: referenced footnotes by rendered number;
        // any retained orphans (normal notes only) sort to the end, in source order.
        footnotes.sort((a, b) => {
            if (a.displayNumber == null && b.displayNumber == null) return a.line - b.line;
            if (a.displayNumber == null) return 1;
            if (b.displayNumber == null) return -1;
            return a.displayNumber - b.displayNumber;
        });

        return footnotes;
    }

    showEmpty(message: string, container: HTMLElement = this.contentEl) {
        container.empty();
        container.createDiv({ cls: "highlight-navigator-empty", text: message });
    }

    stripMarkdown(text: string): string {
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

    renderList(container: HTMLElement, items: NavItem[], type: ListType) {
        // Filter items based on search query
        const filteredItems = items.filter((item) => {
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
        const fragment = createFragment();

        filteredItems.forEach((item, index) => {
            const el = fragment.createDiv({ cls: "highlight-navigator-item" });

            if (type === "highlights") {
                const highlight = item as Highlight;
                // Color indicator
                if (highlight.color) {
                    const colorDot = el.createSpan({ cls: "highlight-color-dot" });
                    colorDot.setCssStyles({ backgroundColor: highlight.color });
                } else {
                    el.createSpan({ cls: "highlight-color-dot highlight-default" });
                }
            } else {
                const footnote = item as NavFootnote;
                // Footnote indicator: show the number Obsidian renders in
                // Reading View (sequential by first appearance), not the literal
                // id — those differ for out-of-order names (e.g. Wikipedia
                // imports). The source id is kept in a tooltip. Unreferenced
                // definitions have no rendered number, so fall back to `[^id]`.
                const idSpan = el.createSpan({ cls: "footnote-id" });
                idSpan.textContent =
                    footnote.displayNumber != null ? `${footnote.displayNumber} ` : `[^${footnote.id}] `;
                idSpan.setAttribute("title", `[^${footnote.id}]`);
                idSpan.setCssStyles({ marginRight: "5px", color: "var(--text-muted)" });
            }

            const textSpan = el.createSpan({ cls: "highlight-text" });
            textSpan.textContent = this.stripMarkdown(item.text);

            // Actions menu (hidden until hover on desktop; always available on mobile).
            // Available for both highlights and footnote annotations.
            const openMenu = (e: MouseEvent) => {
                if (type === "highlights") {
                    this.openHighlightActionsMenu(item as Highlight, e);
                } else {
                    this.openFootnoteActionsMenu(item as NavFootnote, e);
                }
            };

            const menuBtn = el.createEl("button", { cls: "highlight-item-menu" });
            menuBtn.setAttribute("aria-label", type === "highlights" ? "Highlight actions" : "Annotation actions");
            menuBtn.textContent = "⋯";
            menuBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openMenu(e);
            };

            // Trailing ordinal badge (highlights only). Footnotes already show
            // their Reading-View number as the leading badge.
            if (type === "highlights") {
                const numberBadge = el.createSpan({ cls: "highlight-number" });
                numberBadge.textContent = `${index + 1}`;
            }

            el.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                openMenu(e);
            };

            // Click to jump. Highlights scroll to their body line; footnotes
            // scroll to the footnote definition at the bottom (see jumpToFootnote).
            el.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (type === "footnotes") {
                    void this.jumpToFootnote(item as NavFootnote);
                } else {
                    void this.jumpToLine((item as Highlight).line);
                }
            };
        });

        list.appendChild(fragment);
    }

    async copyItemText(item: NavItem) {
        const text = (item?.text ?? "").trim();
        if (!text) {
            new Notice("Nothing to copy.");
            return;
        }
        const ok = await this.plugin.writeClipboardText(text);
        new Notice(ok ? "Copied to clipboard." : "Failed to copy.");
    }

    openHighlightActionsMenu(item: Highlight, event: MouseEvent) {
        const currentFile = this.currentFile;
        if (!currentFile) return;

        const menu = new Menu();
        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Copy")
                .setIcon("copy")
                .onClick(() => void this.copyItemText(item));
        });

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Edit…")
                .setIcon("pencil")
                .onClick(() => {
                    new HighlightEditModal(this.plugin, currentFile, item.id, () => {
                        void this.refresh(true);
                    }).open();
                });
        });

        menu.addSeparator();

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Remove highlight")
                .setIcon("trash-2")
                .onClick(() => void this.removeSingleHighlight(item));
        });

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Remove all highlights (note)")
                .setIcon("eraser")
                .setWarning(true)
                .onClick(async () => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view || !view.file || view.file.path !== currentFile.path) {
                        // Still allow removal even if user isn't in preview; operate on file directly.
                        await this.plugin.saveUndoState(currentFile);
                        let raw = await this.app.vault.read(currentFile);
                        raw = raw.replace(/==(.*?)==/gs, "$1");
                        raw = raw.replace(/<mark[^>]*>(.*?)<\/mark>/gs, "$1");
                        await this.app.vault.modify(currentFile, raw);
                        await this.refresh(true);
                        return;
                    }
                    await this.plugin.removeAllHighlights(view);
                    await this.refresh(true);
                });
        });

        menu.showAtMouseEvent(event);
    }

    /**
     * Delete one highlight, leaving its text in place. Removing a single
     * highlight previously meant opening the edit modal, which is several taps
     * for the most common cleanup there is.
     */
    async removeSingleHighlight(item: Highlight) {
        const currentFile = this.currentFile;
        if (!currentFile) return;
        try {
            await this.plugin.saveUndoState(currentFile);
            let found = false;
            await this.app.vault.process(currentFile, (data) => {
                const highlight = findHighlightById(parseHighlights(data), item.id);
                if (!highlight) return data;
                found = true;
                return removeHighlightFromRaw(data, highlight);
            });
            if (!found) {
                new Notice("Highlight not found (it may have moved).");
            }
            await this.refresh(true);
        } catch (err) {
            console.error("Reader Highlighter Tags: failed to remove highlight.", err);
            new Notice("Failed to remove highlight.");
        }
    }

    openFootnoteActionsMenu(item: NavFootnote, event: MouseEvent) {
        const currentFile = this.currentFile;
        if (!currentFile) return;

        const menu = new Menu();
        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Copy")
                .setIcon("copy")
                .onClick(() => void this.copyItemText(item));
        });

        menu.addSeparator();

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Remove annotation")
                .setIcon("trash-2")
                .setWarning(true)
                .onClick(async () => {
                    await this.plugin.removeAnnotationById(currentFile, item.id);
                    await this.refresh(true);
                });
        });

        menu.addSeparator();

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Remove all annotations (note)")
                .setIcon("eraser")
                .setWarning(true)
                .onClick(async () => {
                    await this.plugin.removeAllAnnotations(currentFile);
                    await this.refresh(true);
                });
        });

        menu.showAtMouseEvent(event);
    }

    openBulkMenu(event: MouseEvent) {
        const currentFile = this.currentFile;
        if (!currentFile) return;

        const menu = new Menu();
        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Merge adjacent highlights (note)")
                .setIcon("git-merge")
                .onClick(async () => {
                    await this.plugin.mergeAdjacentHighlightsInFile(currentFile);
                    void this.refresh(true);
                });
        });

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Recolor <mark> highlights (note)…")
                .setIcon("palette")
                .onClick(() => {
                    new BulkRecolorModal(this.plugin, currentFile, () => {
                        void this.refresh(true);
                    }).open();
                });
        });

        menu.addSeparator();

        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Migrate <span> highlights to <mark> (note)")
                .setIcon("wand")
                .onClick(async () => {
                    await this.plugin.migrateSpanHighlightsInFile(currentFile);
                    void this.refresh(true);
                });
        });

        menu.showAtMouseEvent(event);
    }

    async jumpToLine(line: number) {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (leaf && leaf.view instanceof MarkdownView) {
            leaf.setEphemeralState({
                line: line,
                focus: true,
            });
        }
        this.collapseSidebarOnMobile();
    }

    /**
     * Jump to a footnote's *definition* (the entry at the bottom), not its
     * inline reference. In an editor (source/Live Preview) the definition line
     * is directly scrollable. In Reading View the definition lives in an
     * aggregated, virtualized section that is not line-addressable, so we bring
     * the reference into view and then trigger Obsidian's own footnote
     * navigation by clicking the rendered reference link — that scrolls to the
     * definition and flashes it. If the link can't be found we fall back to the
     * reference, so behavior never regresses below "show me where it's used".
     */
    async jumpToFootnote(item: NavFootnote) {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const view = leaf && leaf.view instanceof MarkdownView ? leaf.view : null;

        if (!leaf || !view) {
            this.collapseSidebarOnMobile();
            return;
        }

        if (view.getMode() !== "preview" || item.displayNumber == null) {
            // Editor mode, or an unreferenced (orphan) footnote that has no
            // rendered reference to click: scroll straight to the definition line.
            leaf.setEphemeralState({ line: item.line, focus: true });
            this.collapseSidebarOnMobile();
            return;
        }

        // Reading View: surface the reference, then hand off to Obsidian's
        // native footnote scroll/flash via the rendered reference link.
        leaf.setEphemeralState({ line: item.refLine ?? item.line, focus: true });
        window.setTimeout(() => {
            const anchor = this.findFootnoteRefAnchor(view.contentEl, item);
            if (anchor) {
                anchor.click();
            }
        }, 120);

        this.collapseSidebarOnMobile();
    }

    findFootnoteRefAnchor(root: HTMLElement, item: NavFootnote): HTMLAnchorElement | null {
        if (!root) return null;
        const anchors = root.querySelectorAll<HTMLAnchorElement>(
            "sup.footnote-ref a, a.footnote-ref, sup[id^='fnref'] a"
        );
        const wanted = item.displayNumber != null ? String(item.displayNumber) : null;

        if (wanted) {
            for (const a of Array.from(anchors)) {
                // Reading View renders the sequential number as the link text.
                if ((a.textContent || "").replace(/\D/g, "") === wanted) {
                    return a;
                }
            }
        }
        return anchors.length ? anchors[0] : null;
    }

    collapseSidebarOnMobile() {
        if (!Platform.isMobile) return;
        const root = this.leaf.getRoot();
        if (root === this.app.workspace.leftSplit) {
            this.app.workspace.leftSplit.collapse();
        } else if (root === this.app.workspace.rightSplit) {
            this.app.workspace.rightSplit.collapse();
        }
    }

    async exportHighlights() {
        const currentFile = this.currentFile;
        if (!currentFile) return;

        try {
            const { exportHighlightsToMD } = await import("../utils/export");
            const exportPath = await exportHighlightsToMD(this.app, currentFile);

            // Open the exported file
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf("tab").openFile(exportFile);
            }
        } catch (err) {
            console.error(err);
        }
    }

    openExportMenu(event: MouseEvent) {
        if (!this.currentFile) return;

        const menu = new Menu();
        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Export md")
                .setIcon("file-text")
                .onClick(() => void this.exportHighlights());
        });
        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Export JSON")
                .setIcon("code")
                .onClick(() => void this.exportHighlightsJSON());
        });
        menu.addItem((mi: MenuItem) => {
            mi.setTitle("Export CSV")
                .setIcon("table")
                .onClick(() => void this.exportHighlightsCSV());
        });

        menu.showAtMouseEvent(event);
    }

    async exportHighlightsJSON() {
        const currentFile = this.currentFile;
        if (!currentFile) return;
        try {
            const { exportHighlightsToJSON } = await import("../utils/export");
            const exportPath = await exportHighlightsToJSON(this.app, currentFile);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf("tab").openFile(exportFile);
            }
        } catch (err) {
            console.error(err);
        }
    }

    async exportHighlightsCSV() {
        const currentFile = this.currentFile;
        if (!currentFile) return;
        try {
            const { exportHighlightsToCSV } = await import("../utils/export");
            const exportPath = await exportHighlightsToCSV(this.app, currentFile);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf("tab").openFile(exportFile);
            }
        } catch (err) {
            console.error(err);
        }
    }

    async exportCurrentFileToCanvas() {
        const currentFile = this.currentFile;
        if (!currentFile) return;

        try {
            const { exportHighlightsToCanvas } = await import("../utils/canvas");

            // Map current highlights to the format expected by canvas util
            const highlights: HighlightWithFile[] = this.highlights.map((h) => ({
                ...h,
                file: currentFile,
            }));

            if (highlights.length === 0) {
                new Notice("No highlights to export.");
                return;
            }

            new Notice("Generating canvas...");
            const exportPath = await exportHighlightsToCanvas(this.app, highlights);

            const file = this.app.vault.getAbstractFileByPath(exportPath);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf("tab").openFile(file);
            }
        } catch (err) {
            console.error(err);
        }
    }

    async onClose() {
        // Cleanup if needed
    }
}
