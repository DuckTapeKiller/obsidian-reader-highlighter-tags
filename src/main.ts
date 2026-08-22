import {
    App,
    Plugin,
    Notice,
    Platform,
    PluginSettingTab,
    Setting,
    MarkdownView,
    View,
    TFile,
    WorkspaceLeaf,
    loadPdfJs,
    type SettingDefinitionItem,
} from "obsidian";
import { FloatingManager, type SelectionSnapshot } from "./ui/FloatingManager";
import { SelectionLogic } from "./core/SelectionLogic";
import { TagSuggestModal } from "./modals/TagSuggestModal";
import { AnnotationModal } from "./modals/AnnotationModal";
import { HighlightNavigatorView, HIGHLIGHT_NAVIGATOR_VIEW } from "./views/HighlightNavigator";
import { ResearchView, RESEARCH_VIEW } from "./views/ResearchView";
import { getScroll, applyScroll, type ScrollPosition } from "./utils/dom";
import { exportHighlightsToCSV, exportHighlightsToJSON, exportHighlightsToMD } from "./utils/export";
import { FailureRecoveryModal, type DerivedRule } from "./ui/FailureRecoveryModal";
import {
    parseHighlights,
    mergeAdjacentHighlightsInRaw,
    migrateSpanHighlightsInRaw,
    recolorMarkHighlightsInRaw,
    removeFootnoteFromRaw,
    removeAllFootnotesFromRaw,
} from "./utils/highlights";
import { getSelectedOccurrence, type SelectionHint } from "./utils/blockOccurrence";
import { kindForTag, type BlockKind } from "./utils/sourceBlocks";
import { BulkRecolorModal } from "./modals/BulkRecolorModal";

export interface SemanticColor {
    color: string;
    meaning: string;
}

interface LearnedNormRule {
    stripPattern: string;
}

interface ReadingHighlighterSettings {
    toolbarPosition: string;
    enableColorHighlighting: boolean;
    highlightColor: string;
    defaultTagPrefix: string;
    enableHaptics: boolean;
    showTagButton: boolean;
    showRemoveButton: boolean;
    showQuoteButton: boolean;
    enableColorPalette: boolean;
    showOnlyAssignedColors: boolean;
    semanticColors: SemanticColor[];
    quoteTemplate: string;
    enableAnnotations: boolean;
    showAnnotationButton: boolean;
    enableReadingProgress: boolean;
    readingPositions: Record<string, number>;
    enableSmartTagSuggestions: boolean;
    recentTags: string[];
    maxRecentTags: number;
    showNavigatorButton: boolean;
    showTooltips: boolean;
    enableFrontmatterTag: boolean;
    frontmatterTag: string;
    enableSmartParagraphSelection: boolean;
    learnedNormRules: LearnedNormRule[];
}

const SMART_SELECTION_TAGS = new Set(["P", "LI", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH"]);

const FRONTMATTER_NEEDS_QUOTES_RE = new RegExp("[:\\s{}\\[\\],&*#?|<>=!%@\\\\-]");
const FRONTMATTER_RESERVED_RE = /^(true|false|null|yes|no|on|off)$/i;

const DEFAULT_SETTINGS: ReadingHighlighterSettings = {
    toolbarPosition: "right",
    enableColorHighlighting: false,
    highlightColor: "",
    defaultTagPrefix: "",
    enableHaptics: true,
    showTagButton: true,
    showRemoveButton: true,
    showQuoteButton: true,
    enableColorPalette: false,
    showOnlyAssignedColors: true,
    semanticColors: [
        { color: "#FFCDD2", meaning: "Important" },
        { color: "#F8BBD0", meaning: "" },
        { color: "#E1BEE7", meaning: "" },
        { color: "#D1C4E9", meaning: "" },
        { color: "#C5CAE9", meaning: "" },
        { color: "#BBDEFB", meaning: "Vocabulary" },
        { color: "#B3E5FC", meaning: "" },
        { color: "#B2EBF2", meaning: "" },
        { color: "#B2DFDB", meaning: "" },
        { color: "#C8E6C9", meaning: "Key Concept" },
        { color: "#DCEDC8", meaning: "" },
        { color: "#F0F4C0", meaning: "" },
        { color: "#FFF9C4", meaning: "General" },
        { color: "#FFECB3", meaning: "" },
        { color: "#FFE0B2", meaning: "" },
    ],
    quoteTemplate: "> {{text}}\n>\n> — [[{{file}}]]",
    enableAnnotations: true,
    showAnnotationButton: true,
    enableReadingProgress: true,
    readingPositions: {},
    enableSmartTagSuggestions: true,
    recentTags: [],
    maxRecentTags: 10,
    showNavigatorButton: true,
    showTooltips: false,
    enableFrontmatterTag: false,
    frontmatterTag: "resaltados",
    enableSmartParagraphSelection: false,
    learnedNormRules: [],
};

// Stringify an unknown frontmatter value the same way `String(value || "")`
// did, but in a form the type-checker is happy with.
function toDisplayString(value: unknown): string {
    if (typeof value === "string") return value;
    if (!value) return "";
    const primitive: string | number | boolean = value as string | number | boolean;
    return String(primitive);
}

/** What `SelectionLogic.locateSelection` resolves a selection to. */
interface LocatedRange {
    file: TFile;
    start: number;
    end: number;
}

interface SelectionRequest {
    snippet: string;
    contextElement: HTMLElement | null;
    blocks: HTMLElement[];
    range: Range | null;
    contextText: string | null;
    occurrenceIndex: number;
    withinBlock: SelectionHint | null;
    contextKind: BlockKind | null;
}

interface PdfTextItem {
    str: string;
    transform: number[];
}

interface PdfPage {
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
    numPages: number;
    getPage(n: number): Promise<PdfPage>;
}

interface PdfJs {
    getDocument(args: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
}

export default class ReadingHighlighterPlugin extends Plugin {
    settings: ReadingHighlighterSettings;
    floatingManager: FloatingManager;
    logic: SelectionLogic;
    lastModification: { file: TFile; original: string } | null = null;
    lastScrollPosition: ScrollPosition | null = null;

    async onload() {
        await this.loadSettings();

        this.floatingManager = new FloatingManager(this);
        this.logic = new SelectionLogic(this.app, () => this.settings.learnedNormRules);

        this.registerView(HIGHLIGHT_NAVIGATOR_VIEW, (leaf) => new HighlightNavigatorView(leaf, this));

        this.registerView(RESEARCH_VIEW, (leaf) => new ResearchView(leaf, this));

        this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));
        this.registerCommands();

        this.registerDomEvent(activeDocument, "selectionchange", () => {
            this.floatingManager.handleSelection();
        });

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                this.floatingManager.handleSelection();
            })
        );

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                if (this.settings.enableReadingProgress) {
                    this.saveReadingProgress();
                }
            })
        );

        if (Platform.isMobile) {
            const btn = this.addRibbonIcon("highlighter", "Highlight selection", () => {
                const view = this.getActiveReadingView();
                if (view) void this.highlightSelection(view);
                else new Notice("Open a note in reading view first.");
            });
            this.register(() => btn.remove());
        }

        this.addRibbonIcon("lamp", "Highlight navigator", () => {
            void this.activateNavigatorView();
        });

        this.floatingManager.load();
    }

    registerCommands() {
        this.addCommand({
            id: "highlight-selection-reading",
            name: "Highlight selection (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.highlightSelection(view);
                return true;
            },
        });

        this.addCommand({
            id: "tag-selection",
            name: "Tag selection (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.tagSelection(view);
                return true;
            },
        });

        this.addCommand({
            id: "extract-all-pdf-text",
            name: "Extract all text from current PDF",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(View);
                if (view && view.getViewType() === "pdf") {
                    if (!checking) {
                        void this.extractAllPdfText(view);
                    }
                    return true;
                }
                return false;
            },
        });

        this.addCommand({
            id: "annotate-selection",
            name: "Add annotation to selection (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.annotateSelection(view);
                return true;
            },
        });

        this.addCommand({
            id: "copy-as-quote",
            name: "Copy selection as quote (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.copyAsQuote(view);
                return true;
            },
        });

        this.addCommand({
            id: "remove-highlight",
            name: "Remove highlight from selection (reading view)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.removeHighlightSelection(view);
                return true;
            },
        });

        this.addCommand({
            id: "undo-last-highlight",
            name: "Undo last highlight",
            callback: () => {
                void this.undoLastHighlight();
            },
        });

        this.addCommand({
            id: "open-highlight-navigator",
            name: "Open highlight navigator",
            callback: () => {
                void this.activateNavigatorView();
            },
        });

        this.addCommand({
            id: "open-research-view",
            name: "Open global research view",
            callback: () => {
                void this.activateResearchView();
            },
        });

        this.addCommand({
            id: "export-highlights",
            name: "Export highlights to new note",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.exportHighlights(view);
                return true;
            },
        });

        this.addCommand({
            id: "export-highlights-json",
            name: "Export highlights to JSON",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.exportHighlightsJSON(view);
                return true;
            },
        });

        this.addCommand({
            id: "export-highlights-csv",
            name: "Export highlights to CSV",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.exportHighlightsCSV(view);
                return true;
            },
        });

        this.addCommand({
            id: "remove-all-highlights",
            name: "Remove all highlights from note",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.removeAllHighlights(view);
                return true;
            },
        });

        this.addCommand({
            id: "remove-all-annotations",
            name: "Remove all annotations from note",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.removeAllAnnotations(view.file);
                return true;
            },
        });

        this.addCommand({
            id: "merge-adjacent-highlights",
            name: "Merge adjacent highlights in note",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.mergeAdjacentHighlightsInFile(view.file);
                return true;
            },
        });

        this.addCommand({
            id: "recolor-mark-highlights",
            name: "Recolor <mark> highlights in note…",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                new BulkRecolorModal(this, view.file).open();
                return true;
            },
        });

        this.addCommand({
            id: "migrate-span-highlights",
            name: "Migrate <span> highlights to <mark> in note",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.migrateSpanHighlightsInFile(view.file);
                return true;
            },
        });

        this.addCommand({
            id: "resume-reading",
            name: "Resume reading (jump to last position)",
            checkCallback: (checking) => {
                const view = this.getActiveReadingView();
                if (!view) return false;
                if (checking) return true;
                void this.resumeReading(view);
                return true;
            },
        });

        for (let i = 0; i < 9; i++) {
            this.addCommand({
                id: `apply-color-${i + 1}`,
                name: `Apply highlight color ${i + 1}`,
                checkCallback: (checking) => {
                    if (!this.settings.enableColorPalette) return false;
                    const view = this.getActiveReadingView();
                    if (!view) return false;
                    if (checking) return true;
                    void this.applyColorByIndex(view, i);
                    return true;
                },
            });
        }
    }

    async activateResearchView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(RESEARCH_VIEW);
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getLeaf("tab");
            await leaf.setViewState({ type: RESEARCH_VIEW, active: true });
        }
        void workspace.revealLeaf(leaf);
    }

    onunload() {
        this.floatingManager.unload();
    }

    async loadSettings() {
        const loaded = ((await this.loadData()) as Partial<ReadingHighlighterSettings>) || {};
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded, {
            semanticColors: loaded.semanticColors?.length ? loaded.semanticColors : DEFAULT_SETTINGS.semanticColors,
        });
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.floatingManager.refresh();
    }

    getActiveReadingView(): MarkdownView | null {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        return view && view.getMode() === "preview" ? view : null;
    }

    getSelectionContext(selectionSnapshot: SelectionSnapshot | null) {
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

    getSelectionRange(selectionSnapshot: SelectionSnapshot | null | undefined): Range | null {
        if (selectionSnapshot?.range) {
            return selectionSnapshot.range.cloneRange();
        }
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) {
            return null;
        }
        return selection.getRangeAt(0).cloneRange();
    }

    getAllowedBlocksInRange(range: Range, root: HTMLElement) {
        if (!root) return [];
        const selector = Array.from(SMART_SELECTION_TAGS)
            .map((tag) => tag.toLowerCase())
            .join(", ");
        const blocks = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => {
            const text = this.getElementText(element);
            if (!text) return false;
            try {
                return range.intersectsNode(element);
            } catch {
                return false;
            }
        });
        return blocks.filter((element) => !blocks.some((other) => other !== element && other.contains(element)));
    }

    getClosestAllowedBlock(node: Node, root: HTMLElement): HTMLElement | null {
        let current = node?.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement;
        while (current && current !== root) {
            if (SMART_SELECTION_TAGS.has(current.tagName) && this.getElementText(current)) {
                return current;
            }
            current = current.parentElement;
        }
        return current && SMART_SELECTION_TAGS.has(current.tagName) ? current : null;
    }

    getElementText(element: HTMLElement) {
        return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    }

    buildSelectionRequest(view: MarkdownView, selectionSnapshot: SelectionSnapshot | null) {
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
            blocks: selectionContext?.blocks || [],
            range: this.getSelectionRange(selectionSnapshot),
            contextText: contextElement ? this.getElementText(contextElement) : null,
            occurrenceIndex: this.getSelectionOccurrence(view, contextElement),
            withinBlock: this.getWithinBlockHint(contextElement, selectionSnapshot, snippet),
            contextKind: kindForTag(contextElement?.tagName),
        };
    }

    /**
     * Which occurrence of `snippet` inside `contextElement` the caret is on.
     *
     * `getSelectionOccurrence` distinguishes repeated *blocks*; this
     * distinguishes repeats *within* one block, which is what a paragraph
     * containing soft line breaks (Shift+Enter) produces — one <p>, one context
     * string, several identical snippets. Returns null when there is no live
     * range to read, leaving the matcher on its previous first-match behaviour.
     */
    getWithinBlockHint(
        contextElement: HTMLElement | null,
        selectionSnapshot: SelectionSnapshot | null,
        snippet: string
    ): SelectionHint | null {
        if (!contextElement) return null;
        const range = this.getSelectionRange(selectionSnapshot);
        if (!range) return null;
        return getSelectedOccurrence(contextElement, range, snippet);
    }

    getSelectionOccurrence(view: MarkdownView, contextElement: HTMLElement | null) {
        if (!contextElement) return 0;
        const contextText = contextElement.innerText.trim();
        const tagName = contextElement.tagName.toLowerCase();
        const allElements = view.contentEl.querySelectorAll(tagName);
        let count = 0;
        let foundIndex = 0;
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i] as HTMLElement;
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

    async saveUndoState(file: TFile) {
        this.lastModification = {
            file: file,
            original: await this.app.vault.read(file),
        };
    }

    async undoLastHighlight() {
        if (!this.lastModification) {
            new Notice("Nothing to undo.");
            return;
        }
        try {
            await this.app.vault.modify(this.lastModification.file, this.lastModification.original);
            new Notice("Undone last highlight.");
            this.lastModification = null;
        } catch (err) {
            new Notice("Failed to undo.");
            console.error(err);
        }
    }

    /**
     * The portion of `range` that falls inside `block`, as its own range.
     * Blocks in the middle of a selection are covered entirely; the first and
     * last are usually partial.
     */
    intersectRangeWithBlock(range: Range, block: HTMLElement): Range | null {
        try {
            const blockRange = activeDocument.createRange();
            blockRange.selectNodeContents(block);
            if (range.compareBoundaryPoints(Range.START_TO_START, blockRange) > 0) {
                blockRange.setStart(range.startContainer, range.startOffset);
            }
            if (range.compareBoundaryPoints(Range.END_TO_END, blockRange) < 0) {
                blockRange.setEnd(range.endContainer, range.endOffset);
            }
            return blockRange.collapsed ? null : blockRange;
        } catch {
            return null;
        }
    }

    /**
     * Locate the portion of the selection that lies in `block`.
     */
    async locateBlockPortion(view: MarkdownView, range: Range, block: HTMLElement): Promise<LocatedRange | null> {
        const blockRange = this.intersectRangeWithBlock(range, block);
        if (!blockRange) return null;
        const snippet = blockRange.toString();
        if (!snippet.trim()) return null;
        return this.logic.locateSelection(
            view.file,
            view,
            snippet,
            this.getElementText(block),
            this.getSelectionOccurrence(view, block),
            getSelectedOccurrence(block, blockRange, snippet),
            kindForTag(block.tagName)
        );
    }

    /**
     * Handle a selection spanning several blocks.
     *
     * Matching the whole article as one snippet fails: it asks the engine to
     * align thousands of characters of rendered text — across headings, list
     * markers, footnote references and existing highlights — against the source
     * in one pass, and the user gets the recovery dialog instead of a highlight.
     *
     * A multi-block selection is contiguous, though, so only its two ends need
     * locating. Anchor on the first and last blocks and apply a single edit
     * across the span between them; `applyMarkdownModification` already walks a
     * multi-line range line by line, keeping each line's `- ` or `#` prefix
     * outside its highlight. Locating every block instead would be O(blocks)
     * whole-file scans — minutes of frozen UI on a long article.
     */
    async highlightSpanningBlocks(view: MarkdownView, request: SelectionRequest, mode: string, payload: string) {
        if (!request.range || !view.file) return false;
        const blocks = request.blocks;

        let head: LocatedRange | null = null;
        for (let i = 0; i < blocks.length && !head; i++) {
            head = await this.locateBlockPortion(view, request.range, blocks[i]);
        }
        let tail: LocatedRange | null = null;
        for (let i = blocks.length - 1; i >= 0 && !tail; i--) {
            tail = await this.locateBlockPortion(view, request.range, blocks[i]);
        }
        if (!head || !tail || head.file.path !== tail.file.path) return false;

        const start = Math.min(head.start, tail.start);
        const end = Math.max(head.end, tail.end);
        if (end <= start) return false;

        await this.saveUndoState(head.file);
        await this.applyMarkdownModification(head.file, "", start, end, mode, payload);
        return true;
    }

    async highlightSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }
        const scrollPos = getScroll(view);

        let mode = "highlight";
        let payload = "";
        if (this.settings.enableColorHighlighting && this.settings.highlightColor) {
            mode = "color";
            payload = this.settings.highlightColor;
        }

        // A selection spanning several blocks is handled one block at a time.
        // Matching a whole article as a single snippet asks the engine to align
        // thousands of characters of rendered text — across headings, list
        // markers, footnote references and existing highlights — against the
        // source in one go, and it simply fails, leaving the user with the
        // recovery dialog. Each block on its own matches reliably.
        if (request.blocks.length > 1) {
            const ok = await this.highlightSpanningBlocks(view, request, mode, payload);
            if (!ok) {
                this.handleSelectionFailure(view, request, "highlightSelection");
                return;
            }
            this.restoreScroll(view, scrollPos);
            sel?.removeAllRanges();
            new Notice("Highlighted!");
            return;
        }

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex,
            request.withinBlock,
            request.contextKind
        );

        if (!result) {
            this.handleSelectionFailure(view, request, "highlightSelection");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        await this.applyMarkdownModification(targetFile, "", result.start, result.end, mode, payload);
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();

        if (this.settings.enableHaptics && Platform.isMobile) {
            navigator.vibrate?.(10);
        }
        new Notice("Highlighted!");
    }

    async applyColorByIndex(view: MarkdownView, index: number, selectionSnapshot?: SelectionSnapshot | null) {
        if (index < 0 || index >= this.settings.semanticColors.length) return;
        const palette = this.settings.semanticColors[index];
        await this.applyColorHighlight(view, palette.color, "", selectionSnapshot);
    }

    async savePdfHighlight(
        view: View & { file?: TFile },
        selectionSnapshot: SelectionSnapshot | null,
        mode: string,
        payload: string | number
    ) {
        if (!view.file) return;
        let snippet = selectionSnapshot?.text || window.getSelection()?.toString() || "";
        if (!snippet.trim()) {
            new Notice("No text selected.");
            return;
        }
        snippet = this.sanitizePdfText(snippet);
        const pdfName = view.file.basename;
        const companionFile = `${view.file.parent?.path}/${pdfName} - Highlights.md`;
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
                highlightOutput = snippet.trim();
            } else if (payload === "copyAsQuote") {
                void this.copyAsQuote(view as unknown as MarkdownView, { ...selectionSnapshot, text: snippet });
                return;
            } else {
                return;
            }
        }

        const blockId = "^" + Math.random().toString(36).substring(2, 8);
        const blockquotedText = highlightOutput
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
        const appendString = `${blockquotedText}\n> — [[${view.file.path}|${pdfName}]] ${blockId}\n\n`;

        try {
            if (fileExists instanceof TFile) {
                const fileContent = await this.app.vault.read(fileExists);
                await this.app.vault.modify(fileExists, fileContent + "\n" + appendString);
            } else {
                const fileContent = `# Highlights from [[${view.file.path}|${pdfName}]]\n\n${appendString}`;
                await this.app.vault.create(companionFile, fileContent);
            }
            new Notice("Saved to " + pdfName + " - Highlights");
            window.getSelection()?.removeAllRanges();
            if (this.settings.enableHaptics && Platform.isMobile) {
                navigator.vibrate?.(10);
            }
        } catch (e) {
            console.error("Failed to save PDF highlight", e);
            new Notice("Failed to save PDF highlight");
        }
    }

    sanitizePdfText(text: string) {
        if (!text) return text;
        let sanitized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
        sanitized = sanitized.replace(/(\w)-\n(\w)/g, "$1$2");
        sanitized = sanitized.replace(/\n\n+/g, "[[PAR_BREAK]]");
        sanitized = sanitized.replace(/\n(?=[ \t]*[-*+] |[ \t]*\d+[.)] )/g, "[[LIST_BREAK]]");
        // A newline that does not follow sentence-ending punctuation is a soft
        // wrap, so it becomes a space. Written with a replacer rather than a
        // lookbehind: lookbehind is a parse error on iOS before 16.4, which
        // would stop the whole plugin from loading there.
        sanitized = sanitized.replace(/\n/g, (match, offset: number, full: string) =>
            offset > 0 && ".!?/:;".includes(full[offset - 1]) ? match : " "
        );
        sanitized = sanitized.replace(/\[\[PAR_BREAK\]\]/g, "\n\n");
        sanitized = sanitized.replace(/\[\[LIST_BREAK\]\]/g, "\n");
        return sanitized.replace(/[ \t]+/g, " ").trim();
    }

    async extractAllPdfText(view: View & { file?: TFile }) {
        if (!view || view.getViewType() !== "pdf" || !view.file) {
            new Notice("Please open a PDF file first.");
            return;
        }

        const notice = new Notice("Extracting all PDF text...", 0);

        try {
            const pdfjs = (await loadPdfJs()) as PdfJs;
            const buffer = await this.app.vault.readBinary(view.file);
            const loadingTask = pdfjs.getDocument({ data: buffer });
            const pdf = await loadingTask.promise;

            let fullText = "";
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                let lastY = -1;
                let pageText = "";
                for (const item of content.items) {
                    if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) {
                        pageText += "\n";
                    } else if (lastY !== -1) {
                        pageText += " ";
                    }
                    pageText += item.str;
                    lastY = item.transform[5];
                }
                fullText += pageText + "\n\n";
                if (i % 10 === 0) notice.setMessage(`Extracting text... Page ${i}/${pdf.numPages}`);
            }

            const dummySnapshot = { text: fullText };
            await this.savePdfHighlight(view, dummySnapshot, "action", "highlightSelection");
            notice.hide();
            new Notice(`Successfully extracted ${pdf.numPages} pages.`);
        } catch (e) {
            console.error("Full PDF extraction failed", e);
            notice.hide();
            new Notice("Failed to extract PDF text.");
        }
    }

    async tagSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
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
            request.occurrenceIndex,
            request.withinBlock,
            request.contextKind
        );

        if (!result) {
            this.handleSelectionFailure(view, request, "tagSelection");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        new TagSuggestModal(this, async (tag) => {
            const newResult = await this.logic.locateSelection(
                view.file,
                view,
                request.snippet,
                request.contextText,
                request.occurrenceIndex,
                request.withinBlock,
                request.contextKind
            );
            if (!newResult) {
                new Notice("Selection lost - file may have changed.");
                return;
            }

            if (tag && this.settings.enableSmartTagSuggestions) {
                this.addRecentTag(tag);
            }

            await this.applyMarkdownModification(targetFile, "", newResult.start, newResult.end, "tag", tag);
            this.restoreScroll(view, scrollPos);
            window.getSelection()?.removeAllRanges();
        }).open();
    }

    addRecentTag(tag: string) {
        const cleanTag = tag.replace(/^#/, "").trim();
        if (!cleanTag) return;
        this.settings.recentTags = this.settings.recentTags.filter((t) => t !== cleanTag);
        this.settings.recentTags.unshift(cleanTag);
        if (this.settings.recentTags.length > this.settings.maxRecentTags) {
            this.settings.recentTags = this.settings.recentTags.slice(0, this.settings.maxRecentTags);
        }
        void this.saveData(this.settings);
    }

    async annotateSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
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
            request.occurrenceIndex,
            request.withinBlock,
            request.contextKind
        );

        if (!result) {
            this.handleSelectionFailure(view, request, "annotateSelection");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);

        new AnnotationModal(this.app, async (comment) => {
            const newResult = await this.logic.locateSelection(
                view.file,
                view,
                request.snippet,
                request.contextText,
                request.occurrenceIndex,
                request.withinBlock,
                request.contextKind
            );
            if (!newResult) {
                new Notice("Selection lost - file may have changed.");
                return;
            }

            const currentRaw = await this.app.vault.read(targetFile);
            await this.applyAnnotation(targetFile, currentRaw, newResult.start, newResult.end, comment);
            this.restoreScroll(view, scrollPos);
            window.getSelection()?.removeAllRanges();
            new Notice("Annotation added!");
        }).open();
    }

    async applyAnnotation(file: TFile, raw: string, start: number, end: number, comment: string) {
        if (!raw) {
            raw = await this.app.vault.read(file);
        }
        const footnotePattern = /\[\^(\d+)\]/g;
        let maxNumber = 0;
        let match: RegExpExecArray | null;
        while ((match = footnotePattern.exec(raw)) !== null) {
            const num = parseInt(match[1]);
            if (num > maxNumber) maxNumber = num;
        }
        const footnoteNum = maxNumber + 1;
        const beforeSelection = raw.substring(0, end);
        const afterSelection = raw.substring(end);
        const footnoteRef = `[^${footnoteNum}]`;
        const footnoteDef = `\n\n[^${footnoteNum}]: ${comment}`;
        let newContent = beforeSelection + footnoteRef + afterSelection;
        newContent = newContent.trimEnd() + footnoteDef + "\n";
        await this.app.vault.modify(file, newContent);
    }

    async removeHighlightSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("Select highlighted text to remove.");
            return;
        }
        const scrollPos = getScroll(view);

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex,
            request.withinBlock,
            request.contextKind
        );

        if (!result) {
            this.handleSelectionFailure(view, request, "removeHighlightSelection");
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);
        await this.applyMarkdownModification(targetFile, "", result.start, result.end, "remove");
        new Notice("Highlighting removed.");
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
    }

    async removeAllHighlights(view: MarkdownView) {
        await this.saveUndoState(view.file);
        let raw = await this.app.vault.read(view.file);
        raw = raw.replace(/==(.*?)==/gs, "$1");
        raw = raw.replace(/<mark[^>]*>(.*?)<\/mark>/gs, "$1");
        await this.app.vault.modify(view.file, raw);
        new Notice("All highlights removed.");
    }

    async removeAnnotationById(file: TFile, footnoteId: string) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = removeFootnoteFromRaw(raw, footnoteId);
        if (!result.changed) {
            new Notice("Annotation not found.");
            return;
        }
        await this.app.vault.modify(file, result.raw);
        new Notice("Annotation removed.");
    }

    async removeAllAnnotations(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = removeAllFootnotesFromRaw(raw);
        if (!result.removedCount) {
            new Notice("No annotations to remove.");
            return;
        }
        await this.app.vault.modify(file, result.raw);
        new Notice(`Removed ${result.removedCount} annotation${result.removedCount === 1 ? "" : "s"}.`);
    }

    async mergeAdjacentHighlightsInFile(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = mergeAdjacentHighlightsInRaw(raw);

        if (!result.mergedCount) {
            new Notice("No adjacent highlights to merge.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        new Notice(`Merged ${result.mergedCount} highlight${result.mergedCount === 1 ? "" : "s"}.`);
    }

    async recolorMarkHighlightsInFile(file: TFile, fromColor: string, toColor: string) {
        const targetColor = String(toColor || "").trim();
        if (!targetColor) {
            new Notice("Choose a target color first.");
            return;
        }

        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = recolorMarkHighlightsInRaw(raw, { fromColor, toColor: targetColor });

        if (!result.changedCount) {
            new Notice("No matching <mark> highlights to recolor.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        new Notice(`Recolored ${result.changedCount} highlight${result.changedCount === 1 ? "" : "s"}.`);
    }

    async migrateSpanHighlightsInFile(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = migrateSpanHighlightsInRaw(raw);

        if (!result.changedCount) {
            new Notice("No <span> background highlights found to migrate.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        new Notice(`Migrated ${result.changedCount} highlight${result.changedCount === 1 ? "" : "s"} to <mark>.`);
    }

    async exportHighlights(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToMD(this.app, view.file);
            new Notice(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            new Notice("Failed to export highlights.");
            console.error(err);
        }
    }

    async exportHighlightsJSON(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToJSON(this.app, view.file);
            new Notice(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            new Notice("Failed to export highlights to JSON.");
            console.error(err);
        }
    }

    async exportHighlightsCSV(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToCSV(this.app, view.file);
            new Notice(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            new Notice("Failed to export highlights to CSV.");
            console.error(err);
        }
    }

    async copyAsQuote(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            new Notice("No text selected.");
            return;
        }
        const quotedText = request.snippet
            .split(/\r?\n/)
            .map((line) => `> ${line}`)
            .join("\n");
        const frontmatter =
            (this.app.metadataCache.getFileCache(view.file)?.frontmatter as Record<string, unknown>) || {};
        const quote = this.expandQuoteTemplate(view.file, quotedText, frontmatter);
        const copied = await this.writeClipboardText(quote);
        if (!copied) {
            new Notice("Failed to copy quote.");
            return;
        }
        new Notice("Copied as quote!");
        sel?.removeAllRanges();
    }

    async applyColorHighlight(
        view: MarkdownView,
        color: string,
        autoTag = "",
        selectionSnapshot?: SelectionSnapshot | null
    ) {
        const sel = window.getSelection();
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) return;
        const scrollPos = getScroll(view);

        const result = await this.logic.locateSelection(
            view.file,
            view,
            request.snippet,
            request.contextText,
            request.occurrenceIndex,
            request.withinBlock,
            request.contextKind
        );
        if (!result) {
            this.handleSelectionFailure(view, request, "applyColorHighlight", color);
            return;
        }

        const targetFile = result.file;
        await this.saveUndoState(targetFile);
        await this.applyMarkdownModification(targetFile, result.raw, result.start, result.end, "color", color, autoTag);
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
        new Notice("Highlighted!");
    }

    saveReadingProgress() {
        const view = this.getActiveReadingView();
        if (!view || !view.file) return;
        const pos = getScroll(view);
        if (pos && pos.y > 0) {
            this.settings.readingPositions[view.file.path] = pos.y;
            void this.saveData(this.settings);
        }
    }

    async resumeReading(view: MarkdownView) {
        const pos = this.settings.readingPositions[view.file.path];
        if (pos) {
            applyScroll(view, { x: 0, y: pos });
            new Notice("Resumed reading position.");
        } else {
            new Notice("No saved position for this file.");
        }
    }

    async activateNavigatorView() {
        const existing = this.app.workspace.getLeavesOfType(HIGHLIGHT_NAVIGATOR_VIEW);
        if (existing.length) {
            void this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
        await leaf.setViewState({
            type: HIGHLIGHT_NAVIGATOR_VIEW,
            active: true,
        });
        void this.app.workspace.revealLeaf(leaf);
    }

    expandQuoteTemplate(file: TFile, quotedText: string, frontmatter: Record<string, unknown> = {}) {
        const sourceUrl = toDisplayString(frontmatter.url || frontmatter.source || frontmatter.link).replace(
            /#:~:text=[^&]+(&|$)/,
            ""
        );
        const timestamp = this.formatTimestamp(new Date());
        const variables: Record<string, string> = {
            text: quotedText,
            file: file.basename,
            path: file.path,
            date: timestamp.split("T")[0],
            time: timestamp,
            domain: this.extractDomain(sourceUrl),
            author: this.normalizeFrontmatterValue(
                frontmatter.author || frontmatter.authors || frontmatter.creator || ""
            ),
        };
        return this.settings.quoteTemplate.replace(
            /{{(text|file|path|date|time|domain|author)}}/g,
            (_match: string, key: string) => variables[key] || ""
        );
    }

    async writeClipboardText(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            console.error("Failed to write to clipboard", e);
            return false;
        }
    }

    formatTimestamp(date: Date) {
        const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, "0");
        const offsetMinutes = -date.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? "+" : "-";
        const offsetHours = pad(offsetMinutes / 60);
        const offsetRemainder = pad(offsetMinutes % 60);
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offsetHours}:${offsetRemainder}`;
    }

    extractDomain(url: string) {
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
        } catch {
            return "";
        }
    }

    normalizeFrontmatterValue(value: unknown) {
        if (Array.isArray(value)) {
            return (value as unknown[])
                .map((item) => String(item as string).trim())
                .filter(Boolean)
                .join(", ");
        }
        return toDisplayString(value).trim();
    }

    splitMarkdownLine(line: string) {
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

    getLineStart(raw: string, offset: number) {
        const lineBreak = raw.lastIndexOf("\n", Math.max(0, offset - 1));
        return lineBreak === -1 ? 0 : lineBreak + 1;
    }

    getLineEnd(raw: string, offset: number) {
        const lineBreak = raw.indexOf("\n", offset);
        return lineBreak === -1 ? raw.length : lineBreak;
    }

    needsYamlQuotes(value: string) {
        const trimmedValue = String(value || "").trim();
        return (
            FRONTMATTER_NEEDS_QUOTES_RE.test(trimmedValue) ||
            /^\d/.test(trimmedValue) ||
            FRONTMATTER_RESERVED_RE.test(trimmedValue)
        );
    }

    normalizeTagForComparison(tag: string) {
        return String(tag || "")
            .trim()
            .replace(/^['"]|['"]$/g, "")
            .replace(/^#/, "")
            .replace(/\s+/g, "_");
    }

    formatFrontmatterTag(tag: string) {
        const normalized = this.normalizeTagForComparison(tag);
        if (!normalized) {
            return "";
        }
        return this.needsYamlQuotes(normalized) ? `"${normalized.replace(/"/g, '\\"')}"` : normalized;
    }

    /** The full line of `raw` containing `offset`. */
    lineContaining(raw: string, offset: number): string {
        return raw.substring(this.getLineStart(raw, offset), this.getLineEnd(raw, offset));
    }

    /**
     * Cell ranges of a table row, split on unescaped pipes only.
     *
     * `\|` is an escaped pipe: it is content, not a column boundary. Splitting
     * on it tears wiki links (`[[Note\|Alias]]`) and code spans (`` `a \| b` ``)
     * in half and writes a marker into the middle of them.
     */
    splitTableCells(line: string): { start: number; end: number }[] {
        const cells: { start: number; end: number }[] = [];
        let cursor = 0;
        for (let i = 0; i < line.length; i++) {
            if (line[i] === "\\") {
                i++;
                continue;
            }
            if (line[i] === "|") {
                cells.push({ start: cursor, end: i });
                cursor = i + 1;
            }
        }
        cells.push({ start: cursor, end: line.length });
        return cells;
    }

    /**
     * Rewrite one table row, wrapping only the cells the selection covers.
     *
     * Highlighting a row cannot be done by wrapping the selected span: a `==`
     * pair spanning a `|` swallows the column boundary and the table stops
     * rendering as a table. Each covered cell gets its own pair instead.
     */
    applyToTableRow(
        line: string,
        lineStart: number,
        selectionStart: number,
        selectionEnd: number,
        mode: string,
        payload: string
    ): string {
        const cells = this.splitTableCells(line);
        const pieces: string[] = [];

        cells.forEach((cell, index) => {
            const text = line.substring(cell.start, cell.end);
            const stripped = text
                .replace(/<mark[^>]*>/g, "")
                .replace(/<\/mark>/g, "")
                .split("==")
                .join("");
            const trimmed = stripped.trim();

            // The fragments outside the outer pipes are not cells.
            const isEdge = index === 0 || index === cells.length - 1;
            // Coverage is measured against the cell's *content*, not its padding.
            // A match can run a little past a cell boundary — the flexible
            // matcher treats spaces and `|` as skippable — and counting the
            // padding would drag the neighbouring cell in with it.
            let contentStart = cell.start;
            let contentEnd = cell.end;
            while (contentStart < contentEnd && /\s/.test(line[contentStart])) contentStart++;
            while (contentEnd > contentStart && /\s/.test(line[contentEnd - 1])) contentEnd--;
            const covered = lineStart + contentEnd > selectionStart && lineStart + contentStart < selectionEnd;

            if (isEdge || !trimmed || !covered || mode === "remove") {
                pieces.push(mode === "remove" ? stripped : covered && !isEdge ? stripped : text);
                return;
            }

            const leadWS = stripped.match(/^(\s*)/)?.[1] ?? "";
            const trailWS = stripped.match(/(\s*)$/)?.[1] ?? "";
            let wrapped: string;
            if (mode === "color" || (this.settings.enableColorHighlighting && this.settings.highlightColor)) {
                const color = mode === "color" ? payload : this.settings.highlightColor;
                wrapped = `<mark style="background: ${color}; color: black;">${trimmed}</mark>`;
            } else {
                wrapped = `==${trimmed}==`;
            }
            pieces.push(`${leadWS}${wrapped}${trailWS}`);
        });

        return pieces.join("|");
    }

    isTableAlignmentRow(line: string) {
        return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
    }

    isTableDataRow(line: string) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) return false;
        if (this.isTableAlignmentRow(line)) return false;
        return (trimmed.match(/\|/g) || []).length >= 2;
    }

    async applyMarkdownModification(
        file: TFile,
        raw: string,
        start: number,
        end: number,
        mode: string,
        payload = "",
        autoTag = ""
    ) {
        if (!raw) {
            raw = await this.app.vault.read(file);
        }
        let expandedStart = start;
        let expandedEnd = end;
        let bodyStart = 0;
        if (raw.startsWith("---")) {
            const secondDash = raw.indexOf("---", 3);
            if (secondDash !== -1) {
                bodyStart = secondDash + 3;
            }
        }
        let expanded = true;
        while (expanded) {
            expanded = false;
            const preceding = raw.substring(0, expandedStart);
            const matchBack = preceding.match(/(<mark[^>]*>|\*\*|==|~~|\*|_|\[\[|\[\^[^\]]+\]:?\s?|[([{"'«“‘‹])$/);
            if (matchBack && expandedStart > bodyStart) {
                const newStart = expandedStart - matchBack[0].length;
                if (newStart >= bodyStart) {
                    expandedStart = newStart;
                    expanded = true;
                }
            }
            const following = raw.substring(expandedEnd);
            // Expanded to include balanced punctuation, quotes (including « »), and footnotes
            const matchForward = following.match(
                /^(<\/mark>|\*\*|==|~~|\*|_|\]\]|\]\([^)]+\)|\[\^[^\]]+\]|[.?!,;:]["']?|[)\]}"'»”’›.?!,;:](\s|$)?)/
            );
            if (matchForward) {
                expandedEnd += matchForward[0].length;
                expanded = true;
            }
        }
        // Merge with any highlight the selection overlaps.
        //
        // Extending a highlight — selecting from inside it out past its end —
        // otherwise consumes the existing closing marker (the wrap step strips
        // every `==` inside the selected span) and leaves the original opening
        // marker unpaired, so one highlight becomes two broken fragments. Widen
        // the range to the union of the selection and every highlight it touches;
        // the interior markers are then stripped as usual and a single pair is
        // written around the whole span.
        if (mode === "highlight" || mode === "color" || mode === "tag" || mode === "remove") {
            for (const existing of parseHighlights(raw).highlights) {
                const overlaps = existing.openTagStart < expandedEnd && existing.closeTagEnd > expandedStart;
                if (!overlaps) continue;
                expandedStart = Math.min(expandedStart, existing.openTagStart);
                expandedEnd = Math.max(expandedEnd, existing.closeTagEnd);
            }
        }

        const initiallySelectedText = raw.substring(expandedStart, expandedEnd);
        if (/\r?\n/.test(initiallySelectedText)) {
            expandedStart = this.getLineStart(raw, expandedStart);
            expandedEnd = this.getLineEnd(raw, expandedEnd);
        }
        // A table row must be rewritten as whole cells, so the range is widened
        // to full lines — but the caller's own range is kept, because only the
        // cells it actually covers should be highlighted.
        const selectionStart = expandedStart;
        const selectionEnd = expandedEnd;
        if (
            this.isTableDataRow(this.lineContaining(raw, expandedStart)) ||
            this.isTableDataRow(this.lineContaining(raw, expandedEnd))
        ) {
            expandedStart = this.getLineStart(raw, expandedStart);
            expandedEnd = this.getLineEnd(raw, expandedEnd);
        }

        const selectedText = raw.substring(expandedStart, expandedEnd);
        const newline = raw.includes("\r\n") ? "\r\n" : "\n";
        const lines = selectedText.split(/\r?\n/);
        // Absolute offset of each line, so a table row can work out which of its
        // cells the selection covers.
        const lineOffsets: number[] = [];
        let runningOffset = expandedStart;
        for (const line of lines) {
            lineOffsets.push(runningOffset);
            runningOffset += line.length + newline.length;
        }
        let fullTag = "";
        const sanitizeTag = (t: string) => t.trim().replace(/^#/, "").replace(/\s+/g, "_");
        if (mode === "tag" && payload) {
            const prefix = this.settings.defaultTagPrefix ? sanitizeTag(this.settings.defaultTagPrefix) : "";
            const cleanPayload = payload
                .split(/\s+/)
                .map(sanitizeTag)
                .filter((t) => t)
                .map((t) => `#${t}`)
                .join(" ");
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
        if (autoTag) {
            const cleanAutoTag = sanitizeTag(autoTag);
            fullTag = fullTag ? `${fullTag} #${cleanAutoTag}` : `#${cleanAutoTag}`;
        }
        const processedLines = lines.map((line, lineIndex) => {
            let cleanLine = line.replace(/<mark[^>]*>/g, "").replace(/<\/mark>/g, "");
            if (this.isTableAlignmentRow(line)) return line;
            if (this.isTableDataRow(line)) {
                return this.applyToTableRow(line, lineOffsets[lineIndex], selectionStart, selectionEnd, mode, payload);
            }
            if (mode === "highlight" || mode === "color" || mode === "tag" || mode === "remove") {
                cleanLine = cleanLine.split("==").join("");
            } else if (mode === "bold") {
                cleanLine = cleanLine.split("**").join("");
            } else if (mode === "italic") {
                cleanLine = cleanLine.split("*").join("");
            }
            if (mode === "remove") return cleanLine;
            const { indent, prefix, content } = this.splitMarkdownLine(cleanLine);
            if (!content.trim()) return line;

            // Extract leading and trailing whitespace to preserve it outside the highlight
            const leadWS = content.match(/^(\s*)/)?.[1] || "";
            const trailWS = content.match(/(\s*)$/)?.[1] || "";
            const actualContent = content.substring(leadWS.length, content.length - trailWS.length);

            if (!actualContent) return line;

            const tagStr = fullTag ? `${fullTag} ` : "";
            let wrappedContent = actualContent;

            if (mode === "highlight" || mode === "tag") {
                if (this.settings.enableColorHighlighting && this.settings.highlightColor) {
                    wrappedContent = `<mark style="background: ${this.settings.highlightColor}; color: black;">${actualContent}</mark>`;
                } else {
                    wrappedContent = `==${actualContent}==`;
                }
            } else if (mode === "color") {
                wrappedContent = `<mark style="background: ${payload}; color: black;">${actualContent}</mark>`;
            } else if (mode === "bold") {
                wrappedContent = `**${actualContent}**`;
            } else if (mode === "italic") {
                wrappedContent = `*${actualContent}*`;
            }

            return `${indent}${prefix}${leadWS}${tagStr}${wrappedContent}${trailWS}`;
        });
        const replaceBlock = processedLines.join(newline);
        const newContent = raw.substring(0, expandedStart) + replaceBlock + raw.substring(expandedEnd);
        await this.app.vault.modify(file, newContent);
        if (mode !== "remove" && this.settings.enableFrontmatterTag && this.settings.frontmatterTag) {
            const targetTag = this.formatFrontmatterTag(this.settings.frontmatterTag);
            if (targetTag) {
                try {
                    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
                        if (frontmatter.tags === undefined || frontmatter.tags === null) {
                            frontmatter.tags = [targetTag];
                            return;
                        }
                        if (Array.isArray(frontmatter.tags)) {
                            const existingTags = (frontmatter.tags as unknown[]).map((tag) =>
                                this.normalizeTagForComparison(String(tag as string))
                            );
                            if (!existingTags.includes(this.normalizeTagForComparison(targetTag))) {
                                (frontmatter.tags as unknown[]).push(targetTag);
                            }
                        } else if (typeof frontmatter.tags === "string") {
                            const existingTags = frontmatter.tags.includes(",")
                                ? frontmatter.tags.split(",").map((t) => t.trim())
                                : frontmatter.tags.split(/\s+/).map((t) => t.trim());
                            const cleanTags = existingTags.filter(
                                (tag) =>
                                    this.normalizeTagForComparison(tag) !== this.normalizeTagForComparison(targetTag) &&
                                    tag !== ""
                            );
                            if (cleanTags.length === existingTags.length) {
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

    restoreScroll(view: MarkdownView, pos: ScrollPosition) {
        window.requestAnimationFrame(() => {
            applyScroll(view, pos);
        });
    }

    handleSelectionFailure(
        view: MarkdownView,
        request: SelectionRequest,
        actionType: string,
        payload: string | null = null
    ) {
        const report = this.logic.lastFailureReport;
        if (!report) {
            new Notice("Selection failed, but no diagnostic report was generated.");
            return;
        }
        new FailureRecoveryModal(this.app, report, async (correctedText: string, learnedRule: DerivedRule | null) => {
            if (learnedRule && learnedRule.stripPattern) {
                const existing = this.settings.learnedNormRules.find(
                    (r) => r.stripPattern === learnedRule.stripPattern
                );
                if (!existing) {
                    this.settings.learnedNormRules.push({ stripPattern: learnedRule.stripPattern });
                    await this.saveSettings();
                    new Notice("Normalization rule learned for future selections!");
                }
            }
            const mockSnapshot = { text: correctedText, range: null };
            if (actionType === "applyColorHighlight") {
                await this.applyColorHighlight(view, payload ?? "", "", mockSnapshot);
            } else if (actionType === "highlightSelection") {
                await this.highlightSelection(view, mockSnapshot);
            } else if (actionType === "tagSelection") {
                await this.tagSelection(view, mockSnapshot);
            } else if (actionType === "annotateSelection") {
                await this.annotateSelection(view, mockSnapshot);
            } else if (actionType === "removeHighlightSelection") {
                await this.removeHighlightSelection(view, mockSnapshot);
            }
        }).open();
    }
}

class ReadingHighlighterSettingTab extends PluginSettingTab {
    plugin: ReadingHighlighterPlugin;
    constructor(app: App, plugin: ReadingHighlighterPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    // Render a section heading without raw <h2>/<h3> tags. Styled via styles.css
    // using the theme's own heading variables so it matches the previous look.
    sectionHeading(text: string, variant: "h2" | "h3" | "h4") {
        return this.containerEl.createDiv({
            text,
            cls: `rht-settings-heading rht-settings-heading--${variant}`,
        });
    }
    /**
     * Declarative settings, so every option is reachable from Obsidian's
     * settings search on 1.13 and later.
     *
     * `display()` below is kept for older versions: Obsidian only calls it when
     * this returns an empty array, so the two never both run. Anything added
     * here must also be added there, or it disappears for one audience or the
     * other.
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        const s = this.plugin.settings;
        const colourMeanings: SettingDefinitionItem[] = s.semanticColors.map((item, index) => ({
            name: `Color ${index + 1}`,
            desc: item.color,
            aliases: item.meaning ? [item.meaning] : [],
            control: { type: "text", key: `semanticColors.${index}.meaning`, placeholder: "Meaning (e.g. Disagree)" },
        }));

        return [
            {
                type: "group",
                heading: "Highlighting",
                items: [
                    {
                        name: "Toolbar position",
                        desc: "Choose where the floating toolbar should appear.",
                        control: {
                            type: "dropdown",
                            key: "toolbarPosition",
                            options: {
                                text: "Next to text",
                                top: "Fixed at top center",
                                bottom: "Fixed at bottom center",
                                left: "Fixed left side",
                                right: "Fixed right side (default)",
                            },
                        },
                    },
                    {
                        name: "Enable color highlighting",
                        desc: "Use HTML <mark> tags with specific colors instead of == syntax.",
                        control: { type: "toggle", key: "enableColorHighlighting" },
                    },
                    {
                        name: "Highlight color",
                        desc: "Hex code for the default highlight color.",
                        visible: () => this.plugin.settings.enableColorHighlighting,
                        control: { type: "color", key: "highlightColor" },
                    },
                    {
                        name: "Enable color palette",
                        desc: "Show the semantic colour palette in the toolbar for quick selection.",
                        control: { type: "toggle", key: "enableColorPalette" },
                    },
                    {
                        name: "Only show colours with a meaning",
                        desc: "Hide palette colours that have no meaning assigned below, so the toolbar shows only the ones you actually use. Turn this off to show all of them.",
                        visible: () => this.plugin.settings.enableColorPalette,
                        control: { type: "toggle", key: "showOnlyAssignedColors" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Semantic colour meanings",
                visible: () => this.plugin.settings.enableColorPalette,
                items: colourMeanings,
            },
            {
                type: "group",
                heading: "Tags",
                items: [
                    {
                        name: "Default tag prefix",
                        desc: "Automatically add this tag to every highlight (e.g., 'book').",
                        control: { type: "text", key: "defaultTagPrefix", placeholder: "Book" },
                    },
                    {
                        name: "Smart tag suggestions",
                        desc: "Suggest tags based on recent usage, folder, and frontmatter.",
                        control: { type: "toggle", key: "enableSmartTagSuggestions" },
                    },
                    {
                        name: "Enable smart paragraph selection",
                        desc: "Snap selections inside a paragraph, list item, heading, or blockquote to the entire block.",
                        control: { type: "toggle", key: "enableSmartParagraphSelection" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Quote template",
                items: [
                    {
                        name: "Quote format",
                        desc: "Template for copying text as quote. Variables: {{text}}, {{file}}, {{path}}, {{date}}, {{time}}, {{domain}}, {{author}}",
                        control: { type: "textarea", key: "quoteTemplate" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Annotations",
                items: [
                    {
                        name: "Enable annotations",
                        desc: "Add comments to selections as footnotes.",
                        control: { type: "toggle", key: "enableAnnotations" },
                    },
                    {
                        name: "Show annotation button",
                        desc: "Show the annotation button in the toolbar.",
                        control: { type: "toggle", key: "showAnnotationButton" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Reading progress",
                items: [
                    {
                        name: "Track reading progress",
                        desc: "Remember scroll position when leaving a file.",
                        control: { type: "toggle", key: "enableReadingProgress" },
                    },
                    {
                        name: "Clear reading positions",
                        desc: `Currently tracking ${Object.keys(s.readingPositions).length} file(s).`,
                        action: (el: HTMLElement) => {
                            new Setting(el).addButton((button) =>
                                button.setButtonText("Clear all").onClick(async () => {
                                    this.plugin.settings.readingPositions = {};
                                    await this.plugin.saveSettings();
                                    new Notice("Reading positions cleared.");
                                    this.refreshDefinitions();
                                })
                            );
                        },
                    },
                ],
            },
            {
                type: "group",
                heading: "Toolbar buttons",
                items: [
                    { name: "Show tag button", control: { type: "toggle", key: "showTagButton" } },
                    { name: "Show quote button", control: { type: "toggle", key: "showQuoteButton" } },
                    { name: "Show remove button", control: { type: "toggle", key: "showRemoveButton" } },
                ],
            },
            {
                type: "group",
                heading: "Mobile and UX",
                items: [
                    {
                        name: "Haptic feedback",
                        desc: "Vibrate slightly on success (mobile only).",
                        control: { type: "toggle", key: "enableHaptics" },
                    },
                    {
                        name: "Show button tooltips",
                        desc: "Show tooltips when hovering over toolbar buttons.",
                        control: { type: "toggle", key: "showTooltips" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Frontmatter integration",
                items: [
                    {
                        name: "Auto-tag highlight in frontmatter",
                        desc: "Automatically inject a specific tag into the note's frontmatter whenever you highlight text.",
                        control: { type: "toggle", key: "enableFrontmatterTag" },
                    },
                    {
                        name: "Frontmatter highlight tag",
                        desc: "The tag to add (e.g. 'resaltados'). Do not include the # symbol.",
                        visible: () => this.plugin.settings.enableFrontmatterTag,
                        control: { type: "text", key: "frontmatterTag", placeholder: "Resaltados" },
                    },
                ],
            },
            {
                type: "group",
                heading: "Learned normalization rules",
                items: s.learnedNormRules.length
                    ? [
                          ...s.learnedNormRules.map((rule, index) => ({
                              name: `Rule ${index + 1}`,
                              desc: `Ignore: "${rule.stripPattern}"`,
                              action: (el: HTMLElement) => {
                                  new Setting(el).addButton((btn) => {
                                      btn.setButtonText("Delete").onClick(async () => {
                                          this.plugin.settings.learnedNormRules.splice(index, 1);
                                          await this.plugin.saveSettings();
                                          new Notice("Rule deleted.");
                                          this.refreshDefinitions();
                                      });
                                      btn.buttonEl.addClass("mod-warning");
                                  });
                              },
                          })),
                          {
                              name: "Clear all rules",
                              action: (el: HTMLElement) => {
                                  new Setting(el).addButton((btn) => {
                                      btn.setButtonText("Clear all rules").onClick(async () => {
                                          this.plugin.settings.learnedNormRules = [];
                                          await this.plugin.saveSettings();
                                          new Notice("All rules cleared.");
                                          this.refreshDefinitions();
                                      });
                                      btn.buttonEl.addClass("mod-warning");
                                  });
                              },
                          },
                      ]
                    : [{ name: "No rules learned yet." }],
            },
        ];
    }

    /** Read a declarative control's value out of the plugin's settings. */
    getControlValue(key: string): unknown {
        const colour = key.match(/^semanticColors\.(\d+)\.meaning$/);
        if (colour) return this.plugin.settings.semanticColors[Number(colour[1])]?.meaning ?? "";
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }

    /** Persist a declarative control's value, mirroring the imperative handlers. */
    setControlValue(key: string, value: unknown): void {
        const settings = this.plugin.settings as unknown as Record<string, unknown>;
        // Text-bearing controls hand back a string; anything else is stored as
        // given, so a toggle stays a boolean.
        const asText = typeof value === "string" ? value : "";
        const colour = key.match(/^semanticColors\.(\d+)\.meaning$/);
        if (colour) {
            const entry = this.plugin.settings.semanticColors[Number(colour[1])];
            if (entry) entry.meaning = asText;
        } else if (key === "defaultTagPrefix") {
            settings[key] = asText.replace(/\s+/g, "_").replace(/^#/, "");
        } else if (key === "frontmatterTag") {
            settings[key] = asText.replace(/^#/, "");
        } else {
            settings[key] = value;
        }
        void this.plugin.saveSettings();
        // Several settings gate whether others are shown at all, so re-evaluate
        // the definitions rather than leaving a stale panel behind.
        this.refreshDefinitions();
    }

    /** Re-read the definitions, on versions that have the declarative API. */
    refreshDefinitions(): void {
        const tab = this as unknown as { update?: () => void };
        if (typeof tab.update === "function") tab.update();
        else this.render();
    }

    display() {
        this.render();
    }

    render() {
        const { containerEl } = this;
        containerEl.empty();
        this.sectionHeading("Reader Highlighter Tags Settings", "h2");
        new Setting(containerEl)
            .setName("Toolbar position")
            .setDesc("Choose where the floating toolbar should appear.")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("text", "Next to text")
                    .addOption("top", "Fixed at top center")
                    .addOption("bottom", "Fixed at bottom center")
                    .addOption("left", "Fixed left side")
                    .addOption("right", "Fixed right side (default)")
                    .setValue(this.plugin.settings.toolbarPosition)
                    .onChange(async (value) => {
                        this.plugin.settings.toolbarPosition = value;
                        await this.plugin.saveSettings();
                    })
            );
        this.sectionHeading("Highlighting", "h3");
        new Setting(containerEl)
            .setName("Enable color highlighting")
            .setDesc("Use HTML <mark> tags with specific colors instead of == syntax.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableColorHighlighting).onChange(async (value) => {
                    this.plugin.settings.enableColorHighlighting = value;
                    await this.plugin.saveSettings();
                    this.render();
                })
            );
        if (this.plugin.settings.enableColorHighlighting) {
            new Setting(containerEl)
                .setName("Highlight color")
                .setDesc("Hex code for the default highlight color.")
                .addColorPicker((color) =>
                    color.setValue(this.plugin.settings.highlightColor || "#FFEE58").onChange(async (value) => {
                        this.plugin.settings.highlightColor = value;
                        await this.plugin.saveSettings();
                    })
                );
        }
        new Setting(containerEl)
            .setName("Enable color palette")
            .setDesc("Show the semantic colour palette in the toolbar for quick selection.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableColorPalette).onChange(async (value) => {
                    this.plugin.settings.enableColorPalette = value;
                    await this.plugin.saveSettings();
                    this.render();
                })
            );
        if (this.plugin.settings.enableColorPalette) {
            new Setting(containerEl)
                .setName("Only show colours with a meaning")
                .setDesc(
                    "Hide palette colours that have no meaning assigned below, so the toolbar shows only the ones you actually use. Turn this off to show all of them."
                )
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.showOnlyAssignedColors).onChange(async (value) => {
                        this.plugin.settings.showOnlyAssignedColors = value;
                        await this.plugin.saveSettings();
                    })
                );

            this.sectionHeading("Semantic colour meanings", "h4");
            this.plugin.settings.semanticColors.forEach((item, index) => {
                const setting = new Setting(containerEl).setName(`Color ${index + 1}`);
                const colorPreview = setting.controlEl.createDiv({ cls: "rht-color-swatch" });
                colorPreview.setCssStyles({ backgroundColor: item.color });
                setting.addText((text) =>
                    text
                        .setPlaceholder("Meaning (e.g. Disagree)")
                        .setValue(item.meaning)
                        .onChange(async (value) => {
                            this.plugin.settings.semanticColors[index].meaning = value;
                            await this.plugin.saveSettings();
                        })
                );
            });
        }
        this.sectionHeading("Tags", "h3");
        new Setting(containerEl)
            .setName("Default tag prefix")
            .setDesc("Automatically add this tag to every highlight (e.g., 'book').")
            .addText((text) =>
                text
                    .setPlaceholder("Book")
                    .setValue(this.plugin.settings.defaultTagPrefix)
                    .onChange(async (value) => {
                        this.plugin.settings.defaultTagPrefix = value.replace(/\s+/g, "_").replace(/^#/, "");
                        await this.plugin.saveSettings();
                    })
            );
        new Setting(containerEl)
            .setName("Smart tag suggestions")
            .setDesc("Suggest tags based on recent usage, folder, and frontmatter.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableSmartTagSuggestions).onChange(async (value) => {
                    this.plugin.settings.enableSmartTagSuggestions = value;
                    await this.plugin.saveSettings();
                })
            );
        new Setting(containerEl)
            .setName("Enable smart paragraph selection")
            .setDesc("Snap selections inside a paragraph, list item, heading, or blockquote to the entire block.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableSmartParagraphSelection).onChange(async (value) => {
                    this.plugin.settings.enableSmartParagraphSelection = value;
                    await this.plugin.saveSettings();
                })
            );
        this.sectionHeading("Quote Template", "h3");
        new Setting(containerEl)
            .setName("Quote format")
            .setDesc(
                "Template for copying text as quote. Variables: {{text}}, {{file}}, {{path}}, {{date}}, {{time}}, {{domain}}, {{author}}"
            )
            .addTextArea((text) =>
                text.setValue(this.plugin.settings.quoteTemplate).onChange(async (value) => {
                    this.plugin.settings.quoteTemplate = value;
                    await this.plugin.saveSettings();
                })
            );
        this.sectionHeading("Annotations", "h3");
        new Setting(containerEl)
            .setName("Enable annotations")
            .setDesc("Add comments to selections as footnotes.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableAnnotations).onChange(async (value) => {
                    this.plugin.settings.enableAnnotations = value;
                    await this.plugin.saveSettings();
                })
            );
        new Setting(containerEl)
            .setName("Show annotation button")
            .setDesc("Show the annotation button in the toolbar.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.showAnnotationButton).onChange(async (value) => {
                    this.plugin.settings.showAnnotationButton = value;
                    await this.plugin.saveSettings();
                })
            );
        this.sectionHeading("Reading Progress", "h3");
        new Setting(containerEl)
            .setName("Track reading progress")
            .setDesc("Remember scroll position when leaving a file.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableReadingProgress).onChange(async (value) => {
                    this.plugin.settings.enableReadingProgress = value;
                    await this.plugin.saveSettings();
                })
            );
        new Setting(containerEl)
            .setName("Clear reading positions")
            .setDesc(`Currently tracking ${Object.keys(this.plugin.settings.readingPositions).length} file(s).`)
            .addButton((button) =>
                button.setButtonText("Clear all").onClick(async () => {
                    this.plugin.settings.readingPositions = {};
                    await this.plugin.saveSettings();
                    new Notice("Reading positions cleared.");
                    this.render();
                })
            );
        this.sectionHeading("Toolbar Buttons", "h3");
        new Setting(containerEl).setName("Show tag button").addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.showTagButton).onChange(async (value) => {
                this.plugin.settings.showTagButton = value;
                await this.plugin.saveSettings();
            })
        );
        new Setting(containerEl).setName("Show quote button").addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.showQuoteButton).onChange(async (value) => {
                this.plugin.settings.showQuoteButton = value;
                await this.plugin.saveSettings();
            })
        );
        new Setting(containerEl).setName("Show remove button").addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.showRemoveButton).onChange(async (value) => {
                this.plugin.settings.showRemoveButton = value;
                await this.plugin.saveSettings();
            })
        );
        this.sectionHeading("Mobile & UX", "h3");
        new Setting(containerEl)
            .setName("Haptic feedback")
            .setDesc("Vibrate slightly on success (mobile only).")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableHaptics).onChange(async (value) => {
                    this.plugin.settings.enableHaptics = value;
                    await this.plugin.saveSettings();
                })
            );
        new Setting(containerEl)
            .setName("Show button tooltips")
            .setDesc("Show tooltips when hovering over toolbar buttons.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.showTooltips).onChange(async (value) => {
                    this.plugin.settings.showTooltips = value;
                    await this.plugin.saveSettings();
                })
            );
        this.sectionHeading("Frontmatter Integration", "h3");
        let tagSetting: Setting;
        new Setting(containerEl)
            .setName("Auto-tag highlight in frontmatter")
            .setDesc("Automatically inject a specific tag into the note's frontmatter whenever you highlight text.")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.enableFrontmatterTag).onChange(async (value) => {
                    this.plugin.settings.enableFrontmatterTag = value;
                    await this.plugin.saveSettings();
                    if (tagSetting !== undefined) {
                        tagSetting.settingEl.setCssStyles({ display: value ? "" : "none" });
                    }
                })
            );
        tagSetting = new Setting(containerEl)
            .setName("Frontmatter highlight tag")
            .setDesc("The tag to add (e.g. 'resaltados'). Do not include the # symbol.")
            .addText((text) =>
                text
                    .setPlaceholder("Resaltados")
                    .setValue(this.plugin.settings.frontmatterTag)
                    .onChange(async (value) => {
                        this.plugin.settings.frontmatterTag = value.replace(/^#/, "");
                        await this.plugin.saveSettings();
                    })
            );
        tagSetting.settingEl.setCssStyles({ display: this.plugin.settings.enableFrontmatterTag ? "" : "none" });
        this.sectionHeading("Learned Normalization Rules", "h3");
        if (this.plugin.settings.learnedNormRules.length === 0) {
            containerEl.createEl("p", { text: "No rules learned yet.", cls: "setting-item-description" });
        } else {
            this.plugin.settings.learnedNormRules.forEach((rule, index) => {
                new Setting(containerEl)
                    .setName(`Rule ${index + 1}`)
                    .setDesc(`Ignore: "${rule.stripPattern}"`)
                    .addButton((btn) => {
                        btn.setButtonText("Delete").onClick(async () => {
                            this.plugin.settings.learnedNormRules.splice(index, 1);
                            await this.plugin.saveSettings();
                            this.render();
                            new Notice("Rule deleted.");
                        });
                        btn.buttonEl.addClass("mod-warning");
                    });
            });
            new Setting(containerEl).addButton((btn) => {
                btn.setButtonText("Clear all rules").onClick(async () => {
                    this.plugin.settings.learnedNormRules = [];
                    await this.plugin.saveSettings();
                    this.render();
                    new Notice("All rules cleared.");
                });
                btn.buttonEl.addClass("mod-warning");
            });
        }
    }
}
