import { Plugin, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { FloatingManager } from "./ui/FloatingManager";
import { SelectionLogic } from "./core/SelectionLogic";
import { TagSuggestModal } from "./modals/TagSuggestModal";
import { getScroll, applyScroll } from "./utils/dom";

const DEFAULT_SETTINGS = {
    toolbarPosition: "right", // text, top, bottom, left, right
    // highlightStyle removed
    enableColorHighlighting: false,
    highlightColor: "", // Default: None (Theme decides)
    defaultTagPrefix: "",
    enableHaptics: true,
    showTagButton: true,
    showRemoveButton: true,
    showQuoteButton: true, // New
    // showColorButtons removed
};

export default class ReadingHighlighterPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.floatingManager = new FloatingManager(this);
        this.logic = new SelectionLogic(this.app);

        // -- Settings Tab --
        this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));

        // -- Commands --
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

        // -- Events --
        this.registerDomEvent(document, "selectionchange", () => {
            this.floatingManager.handleSelection();
        });

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                this.floatingManager.handleSelection();
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

        this.floatingManager.load();
    }

    onunload() {
        this.floatingManager.unload();
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

    async highlightSelection(view) {
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

        let mode = "highlight";
        let payload = "";

        if (this.settings.enableColorHighlighting && this.settings.highlightColor) {
            mode = "color";
            payload = this.settings.highlightColor;
        }

        await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, mode, payload);

        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
    }

    async tagSelection(view) {
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

        // Open suggestion modal
        new TagSuggestModal(this, async (tag) => {
            // Callback when tag is selected
            await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, "tag", tag);
            this.restoreScroll(view, scrollPos);
            window.getSelection()?.removeAllRanges();
        }).open();
    }

    async removeHighlightSelection(view) {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) {
            new Notice("Select highlighted text to remove.");
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

        await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, "remove");

        new Notice("Highlighting removed.");
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
    }

    async copyAsQuote(view) {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) {
            new Notice("No text selected.");
            return;
        }

        // Format as quote: "> text"
        const quote = snippet.split("\n").map(l => `> ${l}`).join("\n");
        const link = `\n\n[[${view.file.basename}]]`;

        await navigator.clipboard.writeText(quote + link);
        new Notice("Copied as quote!");

        sel?.removeAllRanges();
    }

    async applyColorHighlight(view, color) {
        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";
        if (!snippet.trim()) return;

        const scrollPos = getScroll(view);
        const contextEl = this.getSelectionContext();
        const contextText = contextEl ? contextEl.innerText : null;
        const occurrenceIndex = this.getSelectionOccurrence(view, contextEl);

        const result = await this.logic.locateSelection(view.file, view, snippet, contextText, occurrenceIndex);
        if (!result) {
            new Notice("Could not locate selection.");
            return;
        }

        // Pass "color" mode and the specific color hex
        await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, "color", color);
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
    }

    async applyMarkdownModification(file, raw, start, end, mode, payload = "") {
        let expandedStart = start;
        let expandedEnd = end;

        // 1. Iterative Expansion: Check for neighbors INDEPENDENTLY
        // We use Regex to greedily capture markers **immediately** touching the selection.
        // This ensures == wraps around them: ==**Bold** text== instead of **==Bold** text==.

        let expanded = true;
        while (expanded) {
            expanded = false;

            // EXPAND START
            // Look for markers at the END of the preceding text.
            const preceding = raw.substring(0, expandedStart);
            // Regex matches: <mark...> OR ** OR == OR ~~ OR * OR _ OR [[ OR [ at the end of string ($)
            const matchBack = preceding.match(/(<mark[^>]*>|\*\*|==|~~|\*|_|\[\[|\[)$/);

            if (matchBack) {
                expandedStart -= matchBack[0].length;
                expanded = true;
            }

            // EXPAND END
            // Look for markers at the START of the following text.
            const following = raw.substring(expandedEnd);
            // Regex matches: </mark> OR ** OR == OR ~~ OR * OR _ OR ]] OR ](url) at the start of string (^)
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
            const autoTag = this.settings.defaultTagPrefix.trim();
            if (autoTag) {
                const cleanTag = autoTag.startsWith("#") ? autoTag.substring(1) : autoTag;
                fullTag = `#${cleanTag}`;
            }
        }

        const processedParagraphs = paragraphs.map(paragraph => {
            if (!paragraph.trim()) return paragraph;

            const lines = paragraph.split("\n");

            const processedLines = lines.map(line => {
                // trimmed removed, usage was redundant if any
                // 2. CLEANING: Stripping ALL markers from the content before re-wrapping
                // This ensures "Remove" works for everything and prevents **==stacking==**

                // Remove HTML tags first
                // Remove HTML tags always for consistency (or only if mode matches?)
                // Actually, <mark> is our primary "color" tool.
                let cleanLine = line.replace(/<mark[^>]*>/g, "").replace(/<\/mark>/g, "");

                // Conditional Cleaning based on Mode
                // If we are applying Highlight (==), we only strip existing == to avoid stacking. We KEEP ** and *.
                // If we are applying Bold (**), we strip existing **.

                if (mode === "highlight" || mode === "color" || mode === "tag") {
                    cleanLine = cleanLine.split('==').join('');
                } else if (mode === "bold") {
                    cleanLine = cleanLine.split('**').join('');
                } else if (mode === "italic") {
                    cleanLine = cleanLine.split('*').join('');
                } else if (mode === "remove") {
                    cleanLine = cleanLine.split('==').join('');
                    // For remove, should we remove bold/italic? 
                    // Safest is to only remove highlights (==) and color (<mark>). 
                    // If user highlight style was Bold, they might expect it removed.
                    // But deleting ** from a user's note is risky. 
                    // Let's stick to removing explicit highlights.
                }

                if (mode === "remove") {
                    return cleanLine;
                }

                const matchIndent = cleanLine.match(/^(\s*)/);
                const indent = matchIndent ? matchIndent[0] : "";
                const contentAfterIndent = cleanLine.substring(indent.length);

                // Detect prefixes
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

        containerEl.createEl("h3", { text: "Visuals & Workflow" });

        new Setting(containerEl)
            .setName("Enable Color Highlighting")
            .setDesc("Use HTML <mark> tags with specific colors. Overrides 'Highlight Style'.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableColorHighlighting)
                .onChange(async (value) => {
                    this.plugin.settings.enableColorHighlighting = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide color options?
                }));

        new Setting(containerEl)
            .setName("Highlight Color")
            .setDesc("Hex code for the highlight color (e.g. #FFEE58). Active when 'Enable Color Highlighting' is ON.")
            .addColorPicker(color => color
                .setValue(this.plugin.settings.highlightColor)
                .onChange(async (value) => {
                    this.plugin.settings.highlightColor = value;
                    await this.plugin.saveSettings();
                }))
            .addText(text => text
                .setPlaceholder("#FFEE58")
                .setValue(this.plugin.settings.highlightColor)
                .onChange(async (value) => {
                    this.plugin.settings.highlightColor = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Default Tag Prefix")
            .setDesc("Automatically nest tags (e.g., 'book'). Leave empty for no prefix. No need for slashes.")
            .addText(text => text
                .setPlaceholder("book")
                .setValue(this.plugin.settings.defaultTagPrefix)
                .onChange(async (value) => {
                    this.plugin.settings.defaultTagPrefix = value;
                    await this.plugin.saveSettings();
                }));

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
    }
}
