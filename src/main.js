import { Plugin, Notice, Platform, PluginSettingTab, Setting, ItemView, WorkspaceLeaf } from "obsidian";
import { FloatingManager } from "./ui/FloatingManager";
import { SelectionLogic } from "./core/SelectionLogic";
import { TagSuggestModal } from "./modals/TagSuggestModal";
import { AnnotationModal } from "./modals/AnnotationModal";
import { HighlightNavigatorView, HIGHLIGHT_NAVIGATOR_VIEW } from "./views/HighlightNavigator";
import { getScroll, applyScroll } from "./utils/dom";
import { exportHighlightsToMD } from "./utils/export";

const DEFAULT_SETTINGS = {
    toolbarPosition: "right",
    enableColorHighlighting: false,
    highlightColor: "",
    defaultTagPrefix: "",
    enableHaptics: true,
    showTagButton: true,
    showRemoveButton: true,
    showQuoteButton: true,

    // NEW: Color Palette (optional, disabled by default = use == highlight)
    enableColorPalette: false,
    colorPalette: [
        { name: "Yellow", color: "#FFEE58", tag: "" },
        { name: "Blue", color: "#64B5F6", tag: "" },
        { name: "Green", color: "#81C784", tag: "" },
        { name: "Red", color: "#EF5350", tag: "" },
        { name: "Purple", color: "#BA68C8", tag: "" },
    ],

    // NEW: Highlight Styles (presets with color + tag)
    highlightStyles: [
        { name: "Important", color: "#FFEE58", tag: "important" },
        { name: "Question", color: "#64B5F6", tag: "question" },
        { name: "Definition", color: "#81C784", tag: "definition" },
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
            this.app.workspace.on("active-leaf-change", (leaf) => {
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

        // Color palette shortcuts (1-5)
        for (let i = 0; i < 5; i++) {
            this.addCommand({
                id: `apply-color-${i + 1}`,
                name: `Apply highlight color ${i + 1}`,
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

    getSelectionContext() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;

        const range = sel.getRangeAt(0);
        let container = range.commonAncestorContainer;

        while (container && container.nodeType !== 1) {
            container = container.parentElement;
        }

        const viewContainer = this.getActiveReadingView()?.containerEl;

        while (container && container !== viewContainer) {
            const tag = container.tagName.toLowerCase();
            if (['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'blockquote', 'pre'].includes(tag)) {
                return container;
            }
            container = container.parentElement;
        }

        if (container) return container;
        return null;
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

    async highlightSelection(view) {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) {
            new Notice("No text selected.");
            return;
        }

        const scrollPos = getScroll(view);

        // Save for undo
        await this.saveUndoState(view.file);

        const contextEl = this.getSelectionContext();
        const contextText = contextEl ? contextEl.innerText : null;
        const occurrenceIndex = this.getSelectionOccurrence(view, contextEl);

        const result = await this.logic.locateSelection(view.file, view, snippet, contextText, occurrenceIndex);

        if (!result) {
            new Notice("Could not locate selection in file.");
            return;
        }

        let mode = "highlight";
        let payload = "";

        if (this.settings.enableColorHighlighting && this.settings.highlightColor) {
            mode = "color";
            payload = this.settings.highlightColor;
        }

        await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, mode, payload);

        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();

        if (this.settings.enableHaptics && Platform.isMobile) {
            navigator.vibrate?.(10);
        }

        new Notice("Highlighted!");
    }

    // Apply color by palette index
    async applyColorByIndex(view, index) {
        if (index < 0 || index >= this.settings.colorPalette.length) return;

        const palette = this.settings.colorPalette[index];
        await this.applyColorHighlight(view, palette.color, palette.tag);
    }

    async tagSelection(view) {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) {
            new Notice("No text selected.");
            return;
        }

        const scrollPos = getScroll(view);

        // Save for undo
        await this.saveUndoState(view.file);

        const contextEl = this.getSelectionContext();
        const contextText = contextEl ? contextEl.innerText : null;
        const occurrenceIndex = this.getSelectionOccurrence(view, contextEl);

        const result = await this.logic.locateSelection(view.file, view, snippet, contextText, occurrenceIndex);

        if (!result) {
            new Notice("Could not locate selection in file.");
            return;
        }

        // Open suggestion modal
        new TagSuggestModal(this, async (tag) => {
            // Track recent tags
            if (tag && this.settings.enableSmartTagSuggestions) {
                this.addRecentTag(tag);
            }

            await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, "tag", tag);
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
    async annotateSelection(view) {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) {
            new Notice("No text selected.");
            return;
        }

        const scrollPos = getScroll(view);

        const contextEl = this.getSelectionContext();
        const contextText = contextEl ? contextEl.innerText : null;
        const occurrenceIndex = this.getSelectionOccurrence(view, contextEl);

        const result = await this.logic.locateSelection(view.file, view, snippet, contextText, occurrenceIndex);

        if (!result) {
            new Notice("Could not locate selection in file.");
            return;
        }

        // Open annotation modal
        new AnnotationModal(this.app, async (comment) => {
            if (!comment.trim()) return;

            // Save for undo
            await this.saveUndoState(view.file);

            await this.applyAnnotation(view.file, result.raw, result.start, result.end, comment);
            this.restoreScroll(view, scrollPos);
            window.getSelection()?.removeAllRanges();
            new Notice("Annotation added!");
        }).open();
    }

    // Apply annotation as footnote
    async applyAnnotation(file, raw, start, end, comment) {
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

    async removeHighlightSelection(view) {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) {
            new Notice("Select highlighted text to remove.");
            return;
        }

        const scrollPos = getScroll(view);

        // Save for undo
        await this.saveUndoState(view.file);

        const contextEl = this.getSelectionContext();
        const contextText = contextEl ? contextEl.innerText : null;
        const occurrenceIndex = this.getSelectionOccurrence(view, contextEl);

        const result = await this.logic.locateSelection(view.file, view, snippet, contextText, occurrenceIndex);

        if (!result) {
            new Notice("Could not locate selection in file.");
            return;
        }

        await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, "remove");

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

    async copyAsQuote(view) {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) {
            new Notice("No text selected.");
            return;
        }

        // Apply template
        const quotedText = snippet.split("\n").map(l => `> ${l}`).join("\n");

        let quote = this.settings.quoteTemplate
            .replace("{{text}}", quotedText)
            .replace("{{file}}", view.file.basename)
            .replace("{{path}}", view.file.path)
            .replace("{{date}}", window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().split("T")[0]);

        await navigator.clipboard.writeText(quote);
        new Notice("Copied as quote!");

        sel?.removeAllRanges();
    }

    async applyColorHighlight(view, color, autoTag = "") {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) return;

        const scrollPos = getScroll(view);

        // Save for undo
        await this.saveUndoState(view.file);

        const contextEl = this.getSelectionContext();
        const contextText = contextEl ? contextEl.innerText : null;
        const occurrenceIndex = this.getSelectionOccurrence(view, contextEl);

        const result = await this.logic.locateSelection(view.file, view, snippet, contextText, occurrenceIndex);
        if (!result) {
            new Notice("Could not locate selection.");
            return;
        }

        // Pass "color" mode and the specific color hex
        await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, "color", color, autoTag);
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

    async applyMarkdownModification(file, raw, start, end, mode, payload = "", autoTag = "") {
        let expandedStart = start;
        let expandedEnd = end;

        // Iterative Expansion
        let expanded = true;
        while (expanded) {
            expanded = false;

            const preceding = raw.substring(0, expandedStart);
            const matchBack = preceding.match(/(<mark[^>]*>|\*\*|==|~~|\*|_|\[\[|\[)$/);

            if (matchBack) {
                expandedStart -= matchBack[0].length;
                expanded = true;
            }

            const following = raw.substring(expandedEnd);
            const matchForward = following.match(/^(<\/mark>|\*\*|==|~~|\*|_|\]\]|\]\([^)]+\))/);

            if (matchForward) {
                expandedEnd += matchForward[0].length;
                expanded = true;
            }
        }

        const selectedText = raw.substring(expandedStart, expandedEnd);
        const paragraphs = selectedText.split(/\n\s*\n/);

        // Pre-calculate tag prefix
        let fullTag = "";
        if (mode === "tag" && payload) {
            const prefix = this.settings.defaultTagPrefix ? this.settings.defaultTagPrefix.trim() : "";
            const cleanPayload = payload.startsWith("#") ? payload.substring(1) : payload;

            if (prefix) {
                const cleanPrefix = prefix.startsWith("#") ? prefix.substring(1) : prefix;
                fullTag = `#${cleanPrefix} #${cleanPayload}`;
            } else {
                fullTag = `#${cleanPayload}`;
            }
        } else if ((mode === "highlight" || mode === "color") && this.settings.defaultTagPrefix) {
            const autoTagSetting = this.settings.defaultTagPrefix.trim();
            if (autoTagSetting) {
                const cleanTag = autoTagSetting.startsWith("#") ? autoTagSetting.substring(1) : autoTagSetting;
                fullTag = `#${cleanTag}`;
            }
        }

        // Add autoTag if provided (from color palette)
        if (autoTag) {
            const cleanAutoTag = autoTag.startsWith("#") ? autoTag : `#${autoTag}`;
            fullTag = fullTag ? `${fullTag} ${cleanAutoTag}` : cleanAutoTag;
        }

        const processedParagraphs = paragraphs.map(paragraph => {
            if (!paragraph.trim()) return paragraph;

            const lines = paragraph.split("\n");

            const processedLines = lines.map(line => {
                let cleanLine = line.replace(/<mark[^>]*>/g, "").replace(/<\/mark>/g, "");

                if (mode === "highlight" || mode === "color" || mode === "tag") {
                    cleanLine = cleanLine.split('==').join('');
                } else if (mode === "bold") {
                    cleanLine = cleanLine.split('**').join('');
                } else if (mode === "italic") {
                    cleanLine = cleanLine.split('*').join('');
                } else if (mode === "remove") {
                    cleanLine = cleanLine.split('==').join('');
                }

                if (mode === "remove") {
                    return cleanLine;
                }

                const matchIndent = cleanLine.match(/^(\s*)/);
                const indent = matchIndent ? matchIndent[0] : "";
                const contentAfterIndent = cleanLine.substring(indent.length);

                const prefixRegex = /^((?:#{1,6}\s+)|(?:[-*+]\s+)|(?:\d+\.\s+)|(?:>\s+)|(?:-\s\[[ x]\]\s+))/;
                const matchPrefix = contentAfterIndent.match(prefixRegex);

                let prefix = "";
                let content = contentAfterIndent;

                if (matchPrefix) {
                    prefix = matchPrefix[0];
                    content = contentAfterIndent.substring(prefix.length);
                }

                const tagStr = fullTag ? `${fullTag} ` : "";
                let wrappedContent = content;

                if (mode === "highlight" || mode === "tag") {
                    if (this.settings.enableColorHighlighting && this.settings.highlightColor) {
                        wrappedContent = `<mark style="background: ${this.settings.highlightColor}; color: black;">${content}</mark>`;
                    } else {
                        wrappedContent = `==${content}==`;
                    }
                } else if (mode === "color") {
                    wrappedContent = `<mark style="background: ${payload}; color: black;">${content}</mark>`;
                }

                return `${indent}${prefix}${tagStr}${wrappedContent}`;
            });

            return processedLines.join("\n");
        });

        const replaceBlock = processedParagraphs.join("\n\n");
        const newContent = raw.substring(0, expandedStart) + replaceBlock + raw.substring(expandedEnd);
        await this.app.vault.modify(file, newContent);
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
            containerEl.createEl("h4", { text: "Color Palette" });

            this.plugin.settings.colorPalette.forEach((item, index) => {
                new Setting(containerEl)
                    .setName(`Color ${index + 1}: ${item.name}`)
                    .addColorPicker(color => color
                        .setValue(item.color)
                        .onChange(async (value) => {
                            this.plugin.settings.colorPalette[index].color = value;
                            await this.plugin.saveSettings();
                        }))
                    .addText(text => text
                        .setPlaceholder("Auto-tag (optional)")
                        .setValue(item.tag)
                        .onChange(async (value) => {
                            this.plugin.settings.colorPalette[index].tag = value;
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
                    this.plugin.settings.defaultTagPrefix = value;
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

        // === Quote Template ===
        containerEl.createEl("h3", { text: "Quote Template" });

        new Setting(containerEl)
            .setName("Quote Format")
            .setDesc("Template for copying text as quote. Variables: {{text}}, {{file}}, {{path}}, {{date}}")
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
    }
}
