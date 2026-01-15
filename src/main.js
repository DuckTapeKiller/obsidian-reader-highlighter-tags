import { Plugin, Notice, Platform } from "obsidian";
import { FloatingManager } from "./ui/FloatingManager";
import { SelectionLogic } from "./core/SelectionLogic";
import { TagSuggestModal } from "./modals/TagSuggestModal";
import { getScroll, applyScroll } from "./utils/dom";

export default class ReadingHighlighterPlugin extends Plugin {
    onload() {
        this.floatingManager = new FloatingManager(this);
        this.logic = new SelectionLogic(this.app);

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

        await this.applyMarkdownModification(view.file, result.raw, result.start, result.end, "highlight");

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

    async applyMarkdownModification(file, raw, start, end, mode, tag = "") {
        let expandedStart = start;
        let expandedEnd = end;

        // Expand to catch surrounding ==
        while (expandedStart > 0 && raw.substring(expandedStart - 1, expandedStart) === "=") {
            expandedStart--;
        }
        while (expandedEnd < raw.length && raw.substring(expandedEnd, expandedEnd + 1) === "=") {
            expandedEnd++;
        }

        const selectedText = raw.substring(expandedStart, expandedEnd);

        const paragraphs = selectedText.split(/\n\s*\n/);

        const processedParagraphs = paragraphs.map(paragraph => {
            if (!paragraph.trim()) return paragraph;

            const lines = paragraph.split("\n");

            const processedLines = lines.map(line => {
                const trimmed = line.trim();
                if (!trimmed) return line;

                // 1. CLEAN: Remove ALL existing == markers 
                const cleanLine = line.replace(/==/g, "");

                if (mode === "remove") {
                    return cleanLine;
                }

                // Mode is highlight or tag
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

                // Add tag if selected
                const tagStr = (mode === "tag" && tag) ? `${tag} ` : "";

                return `${indent}${prefix}${tagStr}==${content}==`;
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
