import { Plugin, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { FloatingManager } from "./ui/FloatingManager";
import { SelectionLogic } from "./core/SelectionLogic";
import { TagSuggestModal } from "./modals/TagSuggestModal";
import { AnnotationModal } from "./modals/AnnotationModal";
import { HighlightNavigatorView, HIGHLIGHT_NAVIGATOR_VIEW } from "./views/HighlightNavigator";
import { ResearchView, RESEARCH_VIEW } from "./views/ResearchView";
import { getScroll, applyScroll } from "./utils/dom";
import { exportHighlightsToMD } from "./utils/export";

const SMART_SELECTION_TAGS = new Set([
    "P",
    "LI",
    "BLOCKQUOTE",
    "PRE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "TD",
    "TH",
]);

const FRONTMATTER_NEEDS_QUOTES_RE = new RegExp("[:\\s{}\\[\\],&*#?|<>=!%@\\\\-]");
const FRONTMATTER_RESERVED_RE = /^(true|false|null|yes|no|on|off)$/i;

const DEFAULT_SETTINGS = {
    toolbarPosition: "right",
    enableColorHighlighting: false,
    highlightColor: "",
    defaultTagPrefix: "",
    enableHaptics: true,
    showTagButton: true,
    showRemoveButton: true,
    showQuoteButton: true,

    // NEW: Semantic Color Taxonomy (15 static colors)
    enableColorPalette: false,
    semanticColors: [
        { color: "#FFCDD2", meaning: "Important" }, // Red
        { color: "#F8BBD0", meaning: "" }, // Pink
        { color: "#E1BEE7", meaning: "" }, // Purple
        { color: "#D1C4E9", meaning: "" }, // Deep Purple
        { color: "#C5CAE9", meaning: "" }, // Indigo
        { color: "#BBDEFB", meaning: "Vocabulary" }, // Blue
        { color: "#B3E5FC", meaning: "" }, // Light Blue
        { color: "#B2EBF2", meaning: "" }, // Cyan
        { color: "#B2DFDB", meaning: "" }, // Teal
        { color: "#C8E6C9", meaning: "Key Concept" }, // Green
        { color: "#DCEDC8", meaning: "" }, // Light Green
        { color: "#F0F4C0", meaning: "" }, // Lime
        { color: "#FFF9C4", meaning: "General" }, // Yellow
        { color: "#FFECB3", meaning: "" }, // Amber
        { color: "#FFE0B2", meaning: "" }, // Orange
    ],

    // NEW: Quote Template
    quoteTemplate: "> {{text}}\n>\n> — [[{{file}}]]",

    // NEW: Annotations
    enableAnnotations: true,
    showAnnotationButton: true,

    // NEW: Reading Progress
    enableReadingProgress: true,
    readingPositions: {},

    // NEW: Smart Tags
    enableSmartTagSuggestions: true,
    recentTags: [],
    maxRecentTags: 10,

    // NEW: Navigator
    showNavigatorButton: true,

    // NEW: Tooltips (disabled by default)
    showTooltips: false,

    // NEW: Frontmatter Auto-Tag
    enableFrontmatterTag: false,
    frontmatterTag: "resaltados",

    // NEW: Smart paragraph snapping
    enableSmartParagraphSelection: false,
};

export default class ReadingHighlighterPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.floatingManager = new FloatingManager(this);
        this.logic = new SelectionLogic(this.app);

        // Undo state (in memory only)
        this.lastModification = null;

        // Track scroll position for reading progress
        this.lastScrollPosition = null;

        // Register the Highlight Navigator View
        this.registerView(
            HIGHLIGHT_NAVIGATOR_VIEW,
            (leaf) => new HighlightNavigatorView(leaf, this)
        );

        // Register the Global Research View
        this.registerView(
            RESEARCH_VIEW,
            (leaf) => new ResearchView(leaf, this)
        );

        // -- Settings Tab --
        this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));

        // -- Commands --
        this.registerCommands();

        // -- Events --
        this.registerDomEvent(document, "selectionchange", () => {
            this.floatingManager.handleSelection();
        });

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                this.floatingManager.handleSelection();
            })
        );

        // Track scroll for reading progress
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (_leaf) => {
                if (this.settings.enableReadingProgress) {
                    this.saveReadingProgress();
                }
            })
        );

        // -- Mobile Ribbon --
        if (Platform.isMobile) {
            const btn = this.addRibbonIcon("highlighter", "Highlight Selection", () => {
                const view = this.getActiveReadingView();
                if (view) this.highlightSelection(view);
                else new Notice("Open a note in Reading View first.");
            });
            this.register(() => btn.remove());
        }

        // Add ribbon icon for navigator
        this.addRibbonIcon("list", "Highlight Navigator", () => {
            this.activateNavigatorView();
        });

        this.floatingManager.load();
    }

    registerCommands() {
        // Main highlight command
        this.addCommand({
            id: "highlight-selection-reading",
            name: "Highlight selection (Reading View)",
            hotkeys: [{ modifiers: ["Mod", "Shift"], key: "h" }],
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                this.highlightSelection(view);
                return true;
            },
        });

        // Tag selection
        this.addCommand({
            id: "tag-selection",
            name: "Tag selection (Reading View)",
            hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }],
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                this.tagSelection(view);
                return true;
            },
        });

        // Annotate selection
        this.addCommand({
            id: "annotate-selection",
            name: "Add annotation to selection (Reading View)",
            hotkeys: [{ modifiers: ["Mod", "Shift"], key: "n" }],
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                this.annotateSelection(view);
                return true;
            },
        });

        // Copy as quote
        this.addCommand({
            id: "copy-as-quote",
            name: "Copy selection as quote (Reading View)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                this.copyAsQuote(view);
                return true;
            },
        });

        // Remove highlight
        this.addCommand({
            id: "remove-highlight",
            name: "Remove highlight from selection (Reading View)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                this.removeHighlightSelection(view);
                return true;
            },
        });

        // Undo last highlight
        this.addCommand({
            id: "undo-last-highlight",
            name: "Undo last highlight",
            callback: () => {
                this.undoLastHighlight();
            },
        });

        // Open highlight navigator
        this.addCommand({
            id: "open-highlight-navigator",
            name: "Open highlight navigator",
            callback: () => {
                this.activateNavigatorView();
            },
        });

        // Open global research view
        this.addCommand({
            id: "open-research-view",
            name: "Open global research view",
            callback: () => {
                this.activateResearchView();
            },
        });

        // Export highlights
        this.addCommand({
            id: "export-highlights",
            name: "Export highlights to new note",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                this.exportHighlights(view);
                return true;
            },
        });

        // Remove all highlights
        this.addCommand({
            id: "remove-all-highlights",
            name: "Remove all highlights from note",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                this.removeAllHighlights(view);
                return true;
            },
        });

        // Resume reading
        this.addCommand({
            id: "resume-reading",
            name: "Resume reading (jump to last position)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                this.resumeReading(view);
                return true;
            },
        });

        // Color palette shortcuts (1-9)
        for (let i = 0; i < 9; i++) {
            this.addCommand({
                id: `apply-color-${i + 1}`,
                name: `Apply highlight color ${i + 1}`,
                hotkeys: [{ modifiers: ["Mod", "Shift"], key: String(i + 1) }],
                checkCallback: (checking) => {
                    if (!this.settings.enableColorPalette) return false;
                    const view = this.getActiveReadingView();
                    if (!view) return false;
                    if (checking) return true;
                    this.applyColorByIndex(view, i);
                    return true;
                },
            });
        }
    }

    async activateResearchView() {
        const { workspace } = this.app;

        let leaf = null;
        const leaves = workspace.getLeavesOfType(RESEARCH_VIEW);

        if (leaves.length > 0) {
            // A leaf with our view already exists, use that
            leaf = leaves[0];
        } else {
            // Create a new leaf in the main workspace center
            leaf = workspace.getLeaf("tab");
            await leaf.setViewState({ type: RESEARCH_VIEW, active: true });
        }

        // "Reveal" the leaf in case it is hidden
        workspace.revealLeaf(leaf);
    }

    onunload() {
        this.floatingManager.unload();
        this.app.workspace.detachLeavesOfType(HIGHLIGHT_NAVIGATOR_VIEW);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.floatingManager.refresh();
    }

    getActiveReadingView() {
        const view = this.app.workspace.getActiveViewOfType(require("obsidian").MarkdownView);
        return (view && view.getMode() === "preview") ? view : null;
    }

    getSelectionContext(selectionSnapshot) {
        const view = this.getActiveReadingView();
        const range = this.getSelectionRange(selectionSnapshot);
        if (!view || !range) return null;

        const blocks = this.getAllowedBlocksInRange(range, view.contentEl);
        const fallbackBlock = this.getClosestAllowedBlock(range.commonAncestorContainer, view.contentEl);
        const contextElement = blocks[0] || fallbackBlock || null;
        const rawSnippet = selectionSnapshot?.text || window.getSelection()?.toString() || "";

        let snippet = rawSnippet;
        if (this.settings.enableSmartParagraphSelection && blocks.length === 1) {
            const blockText = this.getElementText(blocks[0]);
            if (blockText) {
                snippet = blockText;
            }
        }

        return {
            element: contextElement,
            blocks,
            snippet,
            text: contextElement ? this.getElementText(contextElement) : null,
        };
    }

    getSelectionRange(selectionSnapshot) {
        if (selectionSnapshot?.range) {
            return selectionSnapshot.range.cloneRange();
        }

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return null;
        }

        return selection.getRangeAt(0).cloneRange();
    }

    getAllowedBlocksInRange(range, root) {
        if (!root) return [];

        const selector = Array.from(SMART_SELECTION_TAGS).map((tag) => tag.toLowerCase()).join(", ");
        const blocks = Array.from(root.querySelectorAll(selector)).filter((element) => {
            const text = this.getElementText(element);
            if (!text) return false;
            try {
                return range.intersectsNode(element);
            } catch (_error) {
                return false;
            }
        });

        return blocks.filter((element) => !blocks.some((other) => other !== element && other.contains(element)));
    }

    getClosestAllowedBlock(node, root) {
        let current = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;

        while (current && current !== root) {
            if (SMART_SELECTION_TAGS.has(current.tagName) && this.getElementText(current)) {
                return current;
            }
            current = current.parentElement;
        }

        return current && SMART_SELECTION_TAGS.has(current.tagName) ? current : null;
    }

    getElementText(element) {
        return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    }

    buildSelectionRequest(view, selectionSnapshot) {
        const sel = window.getSelection();
        const selectionContext = this.getSelectionContext(selectionSnapshot);
        const snippet = selectionContext?.snippet || selectionSnapshot?.text || sel?.toString() || "";
        if (!snippet.trim()) {
            return null;
        }

        const contextElement = selectionContext?.element || null;
        return {
            snippet,
            contextElement,
            contextText: contextElement ? this.getElementText(contextElement) : null,
            occurrenceIndex: this.getSelectionOccurrence(view, contextElement),
        };
    }

    getSelectionOccurrence(view, contextElement) {
        if (!contextElement) return 0;

        const contextText = contextElement.innerText.trim();
        const tagName = contextElement.tagName.toLowerCase();

        const allElements = view.contentEl.querySelectorAll(tagName);

        let count = 0;
        let foundIndex = 0;

        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            if (el.innerText.trim() === contextText) {
                if (el === contextElement) {
                    foundIndex = count;
                    break;
                }
                count++;
            }
        }

        return foundIndex;
    }

    // Save state for undo
    async saveUndoState(file) {
        this.lastModification = {
            file: file,
            original: await this.app.vault.read(file),
        };
    }

    // Undo last highlight
    async undoLastHighlight() {
        if (!this.lastModification) {
            new Notice("Nothing to undo.");
            return;
        }

        try {
            await this.app.vault.modify(
                this.lastModification.file,
                this.lastModification.original
            );
            new Notice("Undone last highlight.");
            this.lastModification = null;
        } catch (err) {
            new Notice("Failed to undo.");
            console.error(err);
        }
    }

    async highlightSelection(view, selectionSnapshot) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }

        const scrollPos = getScroll(view);

        // Save for undo
        await this.saveUndoState(view.file);

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex
        );

        if (!result) {
            new Notice("Could not locate selection in file.");
            return;
        }

        // Use the file returned by locateSelection (may be an embed)
        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        let mode = "highlight";
        let payload = "";

        if (this.settings.enableColorHighlighting && this.settings.highlightColor) {
            mode = "color";
            payload = this.settings.highlightColor;
        }

        await this.applyMarkdownModification(targetFile, "", result.start, result.end, mode, payload);

        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();

        if (this.settings.enableHaptics && Platform.isMobile) {
            navigator.vibrate?.(10);
        }

        new Notice("Highlighted!");
    }

    // Apply color by palette index
    async applyColorByIndex(view, index, selectionSnapshot) {
        if (index < 0 || index >= this.settings.semanticColors.length) return;

        const palette = this.settings.semanticColors[index];
        await this.applyColorHighlight(view, palette.color, "", selectionSnapshot);
    }

    // PDF Companion Note Storage
    async savePdfHighlight(view, selectionSnapshot, mode, payload) {
        if (!view.file) return;

        const snippet = selectionSnapshot?.text || window.getSelection()?.toString() || "";
        if (!snippet.trim()) {
            const { Notice } = require('obsidian');
            new Notice("No text selected.");
            return;
        }

        const pdfName = view.file.basename;
        const companionFile = `${view.file.parent.path}/${pdfName} - Highlights.md`;
        
        const fileExists = this.app.vault.getAbstractFileByPath(companionFile);
        
        let highlightOutput = snippet.trim();
        if (mode === "color") {
            const index = typeof payload === "number" ? payload : parseInt(payload);
            const palette = this.settings.semanticColors[index];
            if (palette) {
                highlightOutput = `<mark style="background: ${palette.color}">${highlightOutput}</mark>`;
            }
        } else if (mode === "action") {
            if (payload === "highlightSelection") {
                highlightOutput = `==${highlightOutput}==`;
            } else if (payload === "copyAsQuote") {
                this.copyAsQuote(view, selectionSnapshot);
                return;
            } else {
                return; // other actions ignored currently for PDFs
            }
        }

        const blockId = "^" + Math.random().toString(36).substring(2, 8);
        const appendString = `> ${highlightOutput}\n> — [[${view.file.path}|${pdfName}]] ${blockId}\n\n`;

        try {
            const { Notice } = require("obsidian");
            if (fileExists) {
                const fileContent = await this.app.vault.read(fileExists);
                await this.app.vault.modify(fileExists, fileContent + "\n" + appendString);
            } else {
                const fileContent = `# Highlights from [[${view.file.path}|${pdfName}]]\n\n${appendString}`;
                await this.app.vault.create(companionFile, fileContent);
            }
            new Notice("Saved to " + pdfName + " - Highlights");
            
            // Clear selection
            window.getSelection()?.removeAllRanges();
            const { Platform } = require("obsidian");
            if (this.settings.enableHaptics && Platform.isMobile) {
                navigator.vibrate?.(10);
            }
        } catch (e) {
            console.error("Failed to save PDF highlight", e);
            const { Notice } = require("obsidian");
            new Notice("Failed to save PDF highlight");
        }
    }

    async tagSelection(view, selectionSnapshot) {
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }

        const scrollPos = getScroll(view);

        // Save for undo
        await this.saveUndoState(view.file);

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex
        );

        if (!result) {
            new Notice("Could not locate selection in file.");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        // Open suggestion modal
        new TagSuggestModal(this, async (tag) => {
            // Track recent tags
            if (tag && this.settings.enableSmartTagSuggestions) {
                this.addRecentTag(tag);
            }

            await this.applyMarkdownModification(targetFile, "", result.start, result.end, "tag", tag);
            this.restoreScroll(view, scrollPos);
            window.getSelection()?.removeAllRanges();
        }).open();
    }

    // Add to recent tags
    addRecentTag(tag) {
        const cleanTag = tag.replace(/^#/, "").trim();
        if (!cleanTag) return;

        // Remove if exists, then add to front
        this.settings.recentTags = this.settings.recentTags.filter(t => t !== cleanTag);
        this.settings.recentTags.unshift(cleanTag);

        // Limit size
        if (this.settings.recentTags.length > this.settings.maxRecentTags) {
            this.settings.recentTags = this.settings.recentTags.slice(0, this.settings.maxRecentTags);
        }

        this.saveSettings();
    }

    // Annotate selection with footnote
    async annotateSelection(view, selectionSnapshot) {
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }

        const scrollPos = getScroll(view);

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex
        );

        if (!result) {
            new Notice("Could not locate selection in file.");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        // Open annotation modal
        new AnnotationModal(this.app, async (comment) => {
            const currentRaw = await this.app.vault.read(targetFile);
            await this.applyAnnotation(targetFile, currentRaw, result.start, result.end, comment);
            this.restoreScroll(view, scrollPos);
            window.getSelection()?.removeAllRanges();
            new Notice("Annotation added!");
        }).open();
    }

    // Apply annotation as footnote
    async applyAnnotation(file, raw, start, end, comment) {
        if (!raw) {
            raw = await this.app.vault.read(file);
        }
        // Find next footnote number
        const footnotePattern = /\[\^(\d+)\]/g;
        let maxNumber = 0;
        let match;
        while ((match = footnotePattern.exec(raw)) !== null) {
            const num = parseInt(match[1]);
            if (num > maxNumber) maxNumber = num;
        }
        const footnoteNum = maxNumber + 1;

        // Insert footnote reference after selection
        const beforeSelection = raw.substring(0, end);
        const afterSelection = raw.substring(end);

        const footnoteRef = `[^${footnoteNum}]`;
        const footnoteDef = `\n\n[^${footnoteNum}]: ${comment}`;

        // Check if file already has footnotes section at end
        // Just append to end
        let newContent = beforeSelection + footnoteRef + afterSelection;

        // Add footnote definition at end
        newContent = newContent.trimEnd() + footnoteDef + "\n";

        await this.app.vault.modify(file, newContent);
    }

    async removeHighlightSelection(view, selectionSnapshot) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("Select highlighted text to remove.");
            return;
        }

        const scrollPos = getScroll(view);

        // Save for undo
        await this.saveUndoState(view.file);

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex
        );

        if (!result) {
            new Notice("Could not locate selection in file.");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        await this.applyMarkdownModification(targetFile, "", result.start, result.end, "remove");

        new Notice("Highlighting removed.");
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
    }

    // Remove all highlights from file
    async removeAllHighlights(view) {
        // Save for undo
        await this.saveUndoState(view.file);

        let raw = await this.app.vault.read(view.file);

        // Remove markdown highlights
        raw = raw.replace(/==(.*?)==/g, "$1");

        // Remove HTML highlights
        raw = raw.replace(/<mark[^>]*>(.*?)<\/mark>/g, "$1");

        await this.app.vault.modify(view.file, raw);
        new Notice("All highlights removed.");
    }

    // Export highlights to new MD file
    async exportHighlights(view) {
        try {
            const exportPath = await exportHighlightsToMD(this.app, view.file);
            new Notice(`Highlights exported to ${exportPath}`);

            // Open the new file
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            new Notice("Failed to export highlights.");
            console.error(err);
        }
    }

    async copyAsQuote(view, selectionSnapshot) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }

        const quotedText = request.snippet.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
        const frontmatter = this.app.metadataCache.getFileCache(view.file)?.frontmatter || {};
        const quote = this.expandQuoteTemplate(view.file, quotedText, frontmatter);

        const copied = await this.writeClipboardText(quote);
        if (!copied) {
            new Notice("Failed to copy quote.");
            return;
        }

        new Notice("Copied as quote!");

        sel?.removeAllRanges();
    }

    async applyColorHighlight(view, color, autoTag = "", selectionSnapshot) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) return;

        const scrollPos = getScroll(view);

        // Save for undo
        await this.saveUndoState(view.file);

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex
        );
        if (!result) {
            new Notice("Could not locate selection.");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        // Pass "color" mode and the specific color hex
        await this.applyMarkdownModification(targetFile, result.raw, result.start, result.end, "color", color, autoTag);
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();

        new Notice("Highlighted!");
    }

    // Reading progress
    saveReadingProgress() {
        const view = this.getActiveReadingView();
        if (!view || !view.file) return;

        const pos = getScroll(view);
        if (pos && pos.y > 0) {
            this.settings.readingPositions[view.file.path] = pos.y;
            this.saveSettings();
        }
    }

    async resumeReading(view) {
        const pos = this.settings.readingPositions[view.file.path];
        if (pos) {
            applyScroll(view, { y: pos });
            new Notice("Resumed reading position.");
        } else {
            new Notice("No saved position for this file.");
        }
    }

    // Activate navigator view
    async activateNavigatorView() {
        const existing = this.app.workspace.getLeavesOfType(HIGHLIGHT_NAVIGATOR_VIEW);

        if (existing.length) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
        }

        const leaf = this.app.workspace.getRightLeaf(false);
        await leaf.setViewState({
            type: HIGHLIGHT_NAVIGATOR_VIEW,
            active: true,
        });
        this.app.workspace.revealLeaf(leaf);
    }

    expandQuoteTemplate(file, quotedText, frontmatter = {}) {
        const sourceUrl = String(frontmatter.url || frontmatter.source || frontmatter.link || "").replace(/#:~:text=[^&]+(&|$)/, "");
        const timestamp = this.formatTimestamp(new Date());
        const variables = {
            text: quotedText,
            file: file.basename,
            path: file.path,
            date: timestamp.split("T")[0],
            time: timestamp,
            domain: this.extractDomain(sourceUrl),
            author: this.normalizeFrontmatterValue(frontmatter.author || frontmatter.authors || frontmatter.creator || ""),
        };

        return this.settings.quoteTemplate.replace(/{{(text|file|path|date|time|domain|author)}}/g, (_, key) => variables[key] || "");
    }

    async writeClipboardText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_error) {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.opacity = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();

            let copied = false;
            try {
                copied = document.execCommand("copy");
            } catch (_fallbackError) {
                copied = false;
            }

            textArea.remove();
            return copied;
        }
    }

    formatTimestamp(date) {
        const pad = (value) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
        const offsetMinutes = -date.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? "+" : "-";
        const offsetHours = pad(offsetMinutes / 60);
        const offsetRemainder = pad(offsetMinutes % 60);

        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offsetHours}:${offsetRemainder}`;
    }

    extractDomain(url) {
        if (!url) return "";

        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname;

            if (hostname === "localhost" || hostname === "127.0.0.1" || /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
                return hostname;
            }

            const hostParts = hostname.split(".");
            if (hostParts.length > 2) {
                const lastTwo = hostParts.slice(-2).join(".");
                if (/^(co|com|org|net|edu|gov|mil)\.[a-z]{2}$/i.test(lastTwo)) {
                    return hostParts.slice(-3).join(".");
                }
            }

            return hostParts.slice(-2).join(".");
        } catch (_error) {
            return "";
        }
    }

    normalizeFrontmatterValue(value) {
        if (Array.isArray(value)) {
            return value.map((item) => String(item).trim()).filter(Boolean).join(", ");
        }

        return String(value || "").trim();
    }

    splitMarkdownLine(line) {
        const indentMatch = line.match(/^\s*/);
        const indent = indentMatch ? indentMatch[0] : "";
        let remainder = line.substring(indent.length);
        let prefix = "";
        const prefixPatterns = [
            /^>\s*/,
            /^#{1,6}\s+/,
            /^-\s\[[ xX]\]\s+/,
            /^[-*+]\s+/,
            /^\d{1,3}[.)]\s+/,
            /^\[\^[^\]]+\]:\s*/,
            /^\[![^\]]+\]\s*/,
        ];

        let matched = true;
        while (matched && remainder) {
            matched = false;
            for (const pattern of prefixPatterns) {
                const match = remainder.match(pattern);
                if (match) {
                    prefix += match[0];
                    remainder = remainder.substring(match[0].length);
                    matched = true;
                    break;
                }
            }
        }

        return { indent, prefix, content: remainder };
    }

    getLineStart(raw, offset) {
        const lineBreak = raw.lastIndexOf("\n", Math.max(0, offset - 1));
        return lineBreak === -1 ? 0 : lineBreak + 1;
    }

    getLineEnd(raw, offset) {
        const lineBreak = raw.indexOf("\n", offset);
        return lineBreak === -1 ? raw.length : lineBreak;
    }

    needsYamlQuotes(value) {
        const trimmedValue = String(value || "").trim();
        return FRONTMATTER_NEEDS_QUOTES_RE.test(trimmedValue) || /^\d/.test(trimmedValue) || FRONTMATTER_RESERVED_RE.test(trimmedValue);
    }

    normalizeTagForComparison(tag) {
        return String(tag || "")
            .trim()
            .replace(/^['"]|['"]$/g, "")
            .replace(/^#/, "")
            .replace(/\s+/g, "_");
    }

    formatFrontmatterTag(tag) {
        const normalized = this.normalizeTagForComparison(tag);
        if (!normalized) {
            return "";
        }

        return this.needsYamlQuotes(normalized) ? `"${normalized.replace(/"/g, '\\"')}"` : normalized;
    }

    async applyMarkdownModification(file, raw, start, end, mode, payload = "", autoTag = "") {
        if (!raw) {
            raw = await this.app.vault.read(file);
        }
        let expandedStart = start;
        let expandedEnd = end;

        // EDGE CLAMP: Manual frontmatter detection for boundary protection
        let bodyStart = 0;
        if (raw.startsWith('---')) {
            const secondDash = raw.indexOf('---', 3);
            if (secondDash !== -1) {
                // The body starts exactly after the second separator
                bodyStart = secondDash + 3;
            }
        }

        // Iterative Expansion
        let expanded = true;
        while (expanded) {
            expanded = false;

            const preceding = raw.substring(0, expandedStart);
            // Updated matchBack to include footnote definitions like [^1]:
            const matchBack = preceding.match(/(<mark[^>]*>|\*\*|==|~~|\*|_|\[\[|\[\^[^\]]+\]:?\s?|\[)$/);

            if (matchBack && expandedStart > bodyStart) {
                const newStart = expandedStart - matchBack[0].length;
                if (newStart >= bodyStart) {
                    expandedStart = newStart;
                    expanded = true;
                }
            }

            const following = raw.substring(expandedEnd);
            const matchForward = following.match(/^(<\/mark>|\*\*|==|~~|\*|_|\]\]|\]\([^)]+\)|\[\^[^\]]+\])/);

            if (matchForward) {
                expandedEnd += matchForward[0].length;
                expanded = true;
            }
        }

        const initiallySelectedText = raw.substring(expandedStart, expandedEnd);
        if (/\r?\n/.test(initiallySelectedText)) {
            expandedStart = this.getLineStart(raw, expandedStart);
            expandedEnd = this.getLineEnd(raw, expandedEnd);
        }

        const selectedText = raw.substring(expandedStart, expandedEnd);
        const newline = raw.includes("\r\n") ? "\r\n" : "\n";
        const lines = selectedText.split(/\r?\n/);

        // Pre-calculate tag prefix
        let fullTag = "";
        const sanitizeTag = (t) => t.trim().replace(/^#/, '').replace(/\s+/g, '_');

        if (mode === "tag" && payload) {
            const prefix = this.settings.defaultTagPrefix ? sanitizeTag(this.settings.defaultTagPrefix) : "";
            // Payload can be a space-separated list of tags (each starting with #) from the modal
            const cleanPayload = payload.split(/\s+/).map(sanitizeTag).filter(t => t).map(t => `#${t}`).join(" ");

            if (prefix) {
                fullTag = `#${sanitizeTag(prefix)} ${cleanPayload}`;
            } else {
                fullTag = cleanPayload;
            }
        } else if ((mode === "highlight" || mode === "color") && this.settings.defaultTagPrefix) {
            const autoTagSetting = sanitizeTag(this.settings.defaultTagPrefix);
            if (autoTagSetting) {
                fullTag = `#${autoTagSetting}`;
            }
        }

        // Add autoTag if provided (from color palette)
        if (autoTag) {
            const cleanAutoTag = sanitizeTag(autoTag);
            fullTag = fullTag ? `${fullTag} #${cleanAutoTag}` : `#${cleanAutoTag}`;
        }

        const processedLines = lines.map((line) => {
            let cleanLine = line.replace(/<mark[^>]*>/g, "").replace(/<\/mark>/g, "");

            if (mode === "highlight" || mode === "color" || mode === "tag" || mode === "remove") {
                cleanLine = cleanLine.split("==").join("");
            } else if (mode === "bold") {
                cleanLine = cleanLine.split("**").join("");
            } else if (mode === "italic") {
                cleanLine = cleanLine.split("*").join("");
            }

            if (mode === "remove") {
                return cleanLine;
            }

            const { indent, prefix, content } = this.splitMarkdownLine(cleanLine);
            if (!content.trim()) {
                return line;
            }

            const trimmedContent = content.trim();
            const tagStr = fullTag ? `${fullTag} ` : "";
            let wrappedContent = trimmedContent;

            if (mode === "highlight" || mode === "tag") {
                if (this.settings.enableColorHighlighting && this.settings.highlightColor) {
                    wrappedContent = `<mark style="background: ${this.settings.highlightColor}; color: black;">${trimmedContent}</mark>`;
                } else {
                    wrappedContent = `==${trimmedContent}==`;
                }
            } else if (mode === "color") {
                wrappedContent = `<mark style="background: ${payload}; color: black;">${trimmedContent}</mark>`;
            }

            return `${indent}${prefix}${tagStr}${wrappedContent}`;
        });

        const replaceBlock = processedLines.join(newline);
        const newContent = raw.substring(0, expandedStart) + replaceBlock + raw.substring(expandedEnd);
        await this.app.vault.modify(file, newContent);

        // --- Frontmatter Auto-Tag Injection ---
        if (mode !== "remove" && this.settings.enableFrontmatterTag && this.settings.frontmatterTag) {
            const targetTag = this.formatFrontmatterTag(this.settings.frontmatterTag);
            if (targetTag) {
                try {
                    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                        // Initialize if missing
                        if (frontmatter.tags === undefined || frontmatter.tags === null) {
                            frontmatter.tags = [targetTag];
                            return;
                        }

                        // Deduplicate if already an array
                        if (Array.isArray(frontmatter.tags)) {
                            const existingTags = frontmatter.tags.map((tag) => this.normalizeTagForComparison(tag));
                            if (!existingTags.includes(this.normalizeTagForComparison(targetTag))) {
                                frontmatter.tags.push(targetTag);
                            }
                        }
                        // Handle legacy string format
                        else if (typeof frontmatter.tags === "string") {
                            // Support both space-separated and comma-separated tags
                            const existingTags = frontmatter.tags.includes(',') 
                                ? frontmatter.tags.split(',').map(t => t.trim())
                                : frontmatter.tags.split(/\s+/).map(t => t.trim());
                            
                            const cleanTags = existingTags.filter((tag) => this.normalizeTagForComparison(tag) !== this.normalizeTagForComparison(targetTag) && tag !== "");
                            
                            if (cleanTags.length === existingTags.length) {
                                // Tag not found, add it
                                frontmatter.tags = [...cleanTags, targetTag];
                            }
                        }
                    });
                } catch (e) {
                    console.error("Reader Highlighter Tags: Failed to inject frontmatter tag.", e);
                }
            }
        }
    }

    restoreScroll(view, pos) {
        requestAnimationFrame(() => {
            applyScroll(view, pos);
        });
    }
}

class ReadingHighlighterSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "Reader Highlighter Tags Settings" });

        // === Toolbar Position ===
        new Setting(containerEl)
            .setName("Toolbar Position")
            .setDesc("Choose where the floating toolbar should appear.")
            .addDropdown(dropdown => dropdown
                .addOption("text", "Next to text")
                .addOption("top", "Fixed at Top Center")
                .addOption("bottom", "Fixed at Bottom Center")
                .addOption("left", "Fixed Left Side")
                .addOption("right", "Fixed Right Side (Default)")
                .setValue(this.plugin.settings.toolbarPosition)
                .onChange(async (value) => {
                    this.plugin.settings.toolbarPosition = value;
                    await this.plugin.saveSettings();
                }));

        // === Visuals & Workflow ===
        containerEl.createEl("h3", { text: "Highlighting" });

        new Setting(containerEl)
            .setName("Enable Color Highlighting")
            .setDesc("Use HTML <mark> tags with specific colors instead of == syntax.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableColorHighlighting)
                .onChange(async (value) => {
                    this.plugin.settings.enableColorHighlighting = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.enableColorHighlighting) {
            new Setting(containerEl)
                .setName("Highlight Color")
                .setDesc("Hex code for the default highlight color.")
                .addColorPicker(color => color
                    .setValue(this.plugin.settings.highlightColor || "#FFEE58")
                    .onChange(async (value) => {
                        this.plugin.settings.highlightColor = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName("Enable Color Palette")
            .setDesc("Show a palette of 5 colors in the toolbar for quick selection.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableColorPalette)
                .onChange(async (value) => {
                    this.plugin.settings.enableColorPalette = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.enableColorPalette) {
            containerEl.createEl("h4", { text: "Semantic Color Meanings" });

            this.plugin.settings.semanticColors.forEach((item, index) => {
                const setting = new Setting(containerEl)
                    .setName(`Color ${index + 1}`);

                // Visual color block
                const colorPreview = document.createElement("div");
                colorPreview.style.width = "24px";
                colorPreview.style.height = "24px";
                colorPreview.style.borderRadius = "4px";
                colorPreview.style.backgroundColor = item.color;
                colorPreview.style.marginRight = "10px";
                setting.controlEl.appendChild(colorPreview);

                setting.addText(text => text
                    .setPlaceholder("Meaning (e.g. Disagree)")
                    .setValue(item.meaning)
                    .onChange(async (value) => {
                        this.plugin.settings.semanticColors[index].meaning = value;
                        await this.plugin.saveSettings();
                    }));
            });
        }

        // === Tags ===
        containerEl.createEl("h3", { text: "Tags" });

        new Setting(containerEl)
            .setName("Default Tag Prefix")
            .setDesc("Automatically add this tag to every highlight (e.g., 'book').")
            .addText(text => text
                .setPlaceholder("book")
                .setValue(this.plugin.settings.defaultTagPrefix)
                .onChange(async (value) => {
                    this.plugin.settings.defaultTagPrefix = value.replace(/\s+/g, '_').replace(/^#/, '');
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Smart Tag Suggestions")
            .setDesc("Suggest tags based on recent usage, folder, and frontmatter.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSmartTagSuggestions)
                .onChange(async (value) => {
                    this.plugin.settings.enableSmartTagSuggestions = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Enable Smart Paragraph Selection")
            .setDesc("Snap selections inside a paragraph, list item, heading, or blockquote to the entire block.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSmartParagraphSelection)
                .onChange(async (value) => {
                    this.plugin.settings.enableSmartParagraphSelection = value;
                    await this.plugin.saveSettings();
                }));

        // === Quote Template ===
        containerEl.createEl("h3", { text: "Quote Template" });

        new Setting(containerEl)
            .setName("Quote Format")
            .setDesc("Template for copying text as quote. Variables: {{text}}, {{file}}, {{path}}, {{date}}, {{time}}, {{domain}}, {{author}}")
            .addTextArea(text => text
                .setValue(this.plugin.settings.quoteTemplate)
                .onChange(async (value) => {
                    this.plugin.settings.quoteTemplate = value;
                    await this.plugin.saveSettings();
                }));

        // === Annotations ===
        containerEl.createEl("h3", { text: "Annotations" });

        new Setting(containerEl)
            .setName("Enable Annotations")
            .setDesc("Add comments to selections as footnotes.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableAnnotations)
                .onChange(async (value) => {
                    this.plugin.settings.enableAnnotations = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Show Annotation Button")
            .setDesc("Show the annotation button in the toolbar.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showAnnotationButton)
                .onChange(async (value) => {
                    this.plugin.settings.showAnnotationButton = value;
                    await this.plugin.saveSettings();
                }));

        // === Reading Progress ===
        containerEl.createEl("h3", { text: "Reading Progress" });

        new Setting(containerEl)
            .setName("Track Reading Progress")
            .setDesc("Remember scroll position when leaving a file.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableReadingProgress)
                .onChange(async (value) => {
                    this.plugin.settings.enableReadingProgress = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Clear Reading Positions")
            .setDesc(`Currently tracking ${Object.keys(this.plugin.settings.readingPositions).length} file(s).`)
            .addButton(button => button
                .setButtonText("Clear All")
                .onClick(async () => {
                    this.plugin.settings.readingPositions = {};
                    await this.plugin.saveSettings();
                    new Notice("Reading positions cleared.");
                    this.display();
                }));

        // === Toolbar Buttons ===
        containerEl.createEl("h3", { text: "Toolbar Buttons" });

        new Setting(containerEl)
            .setName("Show Tag Button")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showTagButton)
                .onChange(async (value) => {
                    this.plugin.settings.showTagButton = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Show Quote Button")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showQuoteButton)
                .onChange(async (value) => {
                    this.plugin.settings.showQuoteButton = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Show Remove Button")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showRemoveButton)
                .onChange(async (value) => {
                    this.plugin.settings.showRemoveButton = value;
                    await this.plugin.saveSettings();
                }));

        // === Mobile & UX ===
        containerEl.createEl("h3", { text: "Mobile & UX" });

        new Setting(containerEl)
            .setName("Haptic Feedback")
            .setDesc("Vibrate slightly on success (Mobile only).")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableHaptics)
                .onChange(async (value) => {
                    this.plugin.settings.enableHaptics = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Show Button Tooltips")
            .setDesc("Show tooltips when hovering over toolbar buttons.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showTooltips)
                .onChange(async (value) => {
                    this.plugin.settings.showTooltips = value;
                    await this.plugin.saveSettings();
                }));

        // === Frontmatter Integration ===
        containerEl.createEl("h3", { text: "Frontmatter Integration" });

        let tagSetting;

        new Setting(containerEl)
            .setName("Auto-tag highlight in Frontmatter")
            .setDesc("Automatically inject a specific tag into the note's frontmatter whenever you highlight text.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableFrontmatterTag)
                .onChange(async (value) => {
                    this.plugin.settings.enableFrontmatterTag = value;
                    await this.plugin.saveSettings();
                    // Fix jumping scroll: toggle visibility via CSS instead of this.display()
                    if (tagSetting) {
                        tagSetting.settingEl.style.display = value ? "" : "none";
                    }
                }));

        tagSetting = new Setting(containerEl)
            .setName("Frontmatter highlight tag")
            .setDesc("The tag to add (e.g. 'resaltados'). Do not include the # symbol.")
            .addText(text => text
                .setPlaceholder("resaltados")
                .setValue(this.plugin.settings.frontmatterTag)
                .onChange(async (value) => {
                    this.plugin.settings.frontmatterTag = value.replace(/^#/, ''); // Strip # if user adds it
                    await this.plugin.saveSettings();
                }));

        // Set initial visibility without calling this.display()
        tagSetting.settingEl.style.display = this.plugin.settings.enableFrontmatterTag ? "" : "none";
    }
}
