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
    normalizePath,
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
    convertHtmlHighlightsInRaw,
    recolorHighlightsInRaw,
    removeAllHighlightsFromRaw,
    removeFootnoteFromRaw,
    removeAllFootnotesFromRaw,
    parseFootnotes,
    type RecolorSource,
} from "./utils/highlights";
import {
    COLOR_EMOJI,
    COLOR_LABELS,
    HIGHLIGHT_COLORS,
    isHighlightColor,
    nearestHighlightColor,
    stripHighlightMarkers,
    wrapHighlight,
    type HighlightColor,
} from "./utils/colors";
import { getSelectedOccurrence, type SelectionHint } from "./utils/blockOccurrence";
import { kindForTag, splitSourceBlocks, type BlockKind } from "./utils/sourceBlocks";
import { emphasisPairs, highlightInLine } from "./utils/inlineMarkdown";
import { BulkRecolorModal } from "./modals/BulkRecolorModal";
import { confirmAction } from "./modals/ConfirmModal";

/** A change the plugin made, kept so it can be undone. */
export interface UndoEntry {
    file: TFile;
    original: string;
    after?: string;
}

/** How many changes back undo can go. */
const MAX_UNDO_STEPS = 20;

/** How long a notice offering Undo stays, in milliseconds. */
const UNDO_NOTICE_MS = 3000;

export interface SemanticColor {
    color: HighlightColor;
    meaning: string;
}

interface LearnedNormRule {
    stripPattern: string;
}

/** Settings written by versions that coloured highlights with HTML. */
interface LegacyColorSettings {
    enableColorHighlighting?: boolean;
    highlightColor?: string;
    semanticColors?: { color?: string; meaning?: string }[];
}

interface ReadingHighlighterSettings {
    toolbarPosition: string;
    /** Colour the plain highlight button writes; empty for the theme's default. */
    defaultHighlightColor: HighlightColor | "";
    defaultTagPrefix: string;
    enableHaptics: boolean;
    showTagButton: boolean;
    showRemoveButton: boolean;
    showQuoteButton: boolean;
    enableColorPalette: boolean;
    showOnlyAssignedColors: boolean;
    semanticColors: SemanticColor[];
    /** The meanings versions up to 1.0.8 filled in themselves have been cleared. */
    builtInMeaningsCleared: boolean;
    quoteTemplate: string;
    enableAnnotations: boolean;
    showAnnotationButton: boolean;
    enableReadingProgress: boolean;
    readingPositions: Record<string, number>;
    enableSmartTagSuggestions: boolean;
    recentTags: string[];
    maxRecentTags: number;
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
    defaultHighlightColor: "",
    defaultTagPrefix: "",
    enableHaptics: true,
    showTagButton: true,
    showRemoveButton: true,
    showQuoteButton: true,
    enableColorPalette: false,
    showOnlyAssignedColors: true,
    semanticColors: HIGHLIGHT_COLORS.map((color) => ({ color, meaning: "" })),
    builtInMeaningsCleared: false,
    quoteTemplate: "> {{text}}\n>\n> — [[{{file}}]]",
    enableAnnotations: true,
    showAnnotationButton: true,
    enableReadingProgress: true,
    readingPositions: {},
    enableSmartTagSuggestions: true,
    recentTags: [],
    maxRecentTags: 10,
    showTooltips: false,
    enableFrontmatterTag: false,
    frontmatterTag: "resaltados",
    enableSmartParagraphSelection: false,
    learnedNormRules: [],
};

/**
 * The palette, one entry per native colour in Obsidian's order.
 *
 * Older versions kept fifteen hex colours. Each meaning the reader gave one of
 * those moves to the native colour nearest it, so a taxonomy survives the
 * switch; two meanings landing on one colour are joined rather than lost.
 */
function migratePalette(saved: LegacyColorSettings["semanticColors"]): SemanticColor[] {
    const palette: SemanticColor[] = HIGHLIGHT_COLORS.map((color) => ({ color, meaning: "" }));
    for (const entry of saved ?? []) {
        const meaning = (entry?.meaning ?? "").trim();
        const color = isHighlightColor(entry?.color) ? entry.color : nearestHighlightColor(entry?.color);
        if (!meaning || !color) continue;
        const target = palette[HIGHLIGHT_COLORS.indexOf(color)];
        const existing = target.meaning.split(" / ").filter(Boolean);
        if (!existing.includes(meaning)) target.meaning = [...existing, meaning].join(" / ");
    }
    return palette;
}

/**
 * Meanings versions up to 1.0.8 filled in themselves. They were saved with the
 * settings and carried over to the native colours, so they looked like the
 * reader's own. A meaning is the reader's to give.
 */
const BUILT_IN_MEANINGS: Partial<Record<HighlightColor, string>> = {
    red: "Important",
    blue: "Vocabulary",
    green: "Key Concept",
    yellow: "General",
};

/** Examples shown in an empty meaning field; never saved. */
const MEANING_PLACEHOLDERS: Record<HighlightColor, string> = {
    red: "Meaning (e.g. Important)",
    orange: "Meaning (e.g. Question)",
    yellow: "Meaning (e.g. General)",
    green: "Meaning (e.g. Key concept)",
    blue: "Meaning (e.g. Vocabulary)",
    purple: "Meaning (e.g. Disagree)",
};

/**
 * Remove the built-in meanings from the palette, keeping any meaning the
 * reader gave that was joined to one.
 */
function clearBuiltInMeanings(palette: SemanticColor[]) {
    for (const entry of palette) {
        const builtIn = BUILT_IN_MEANINGS[entry.color];
        if (!builtIn) continue;
        entry.meaning = entry.meaning
            .split(" / ")
            .filter((part) => part.trim() !== builtIn)
            .join(" / ");
    }
}

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
    /**
     * Changes the plugin can undo, oldest first. `after` is the note as the
     * change left it; undo refuses once the note no longer reads that way,
     * since restoring `original` would throw away whatever was written since.
     */
    undoHistory: UndoEntry[] = [];
    /** The plugin's notice on screen, if any: there is only ever one. */
    currentNotice: Notice | null = null;
    lastScrollPosition: ScrollPosition | null = null;
    /** A reading position waiting to be saved once scrolling settles. */
    pendingProgress: { view: MarkdownView; file: TFile } | null = null;
    progressTimer: number | null = null;

    async onload() {
        await this.loadSettings();

        this.floatingManager = new FloatingManager(this);
        this.logic = new SelectionLogic(this.app, () => this.settings.learnedNormRules);

        this.registerView(HIGHLIGHT_NAVIGATOR_VIEW, (leaf) => new HighlightNavigatorView(leaf, this));

        this.registerView(RESEARCH_VIEW, (leaf) => new ResearchView(leaf, this));

        this.addSettingTab(new ReadingHighlighterSettingTab(this.app, this));
        this.registerCommands();

        this.registerWindowEvents(activeDocument);
        // A popout window has a document of its own, which fires its own
        // selection and scroll events.
        this.registerEvent(this.app.workspace.on("window-open", (win) => this.registerWindowEvents(win.doc)));

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                this.floatingManager.handleSelection();
            })
        );

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => {
                // The position waiting to be saved belongs to the note being left.
                this.flushReadingProgress();
            })
        );

        if (Platform.isMobile) {
            const btn = this.addRibbonIcon("highlighter", "Highlight selection", () => {
                const view = this.getActiveReadingView();
                if (view) this.runAction(this.highlightSelection(view));
                else this.notify("Open a note in reading view first.");
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
                this.runAction(this.highlightSelection(view));
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
                this.runAction(this.tagSelection(view));
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
                this.runAction(this.annotateSelection(view));
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
                this.runAction(this.copyAsQuote(view));
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
                this.runAction(this.removeHighlightSelection(view));
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
            id: "recolor-highlights",
            name: "Recolour highlights in note…",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                new BulkRecolorModal(this, view.file).open();
                return true;
            },
        });

        this.addCommand({
            id: "convert-html-highlights",
            name: "Convert HTML highlights to native highlights in note",
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                if (checking) return true;
                void this.convertHtmlHighlightsInFile(view.file);
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

        // The ids keep their old numbering, so hotkeys bound to the first six
        // still work; each now names the native colour it applies.
        HIGHLIGHT_COLORS.forEach((color, i) => {
            this.addCommand({
                id: `apply-color-${i + 1}`,
                name: `Apply ${COLOR_LABELS[color].toLowerCase()} highlight`,
                checkCallback: (checking) => {
                    const view = this.getActiveReadingView();
                    if (!view) return false;
                    if (checking) return true;
                    this.runAction(this.applyColorByIndex(view, i));
                    return true;
                },
            });
        });
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
        this.flushReadingProgress();
        this.floatingManager.unload();
    }

    registerWindowEvents(doc: Document) {
        this.registerDomEvent(doc, "selectionchange", () => {
            this.floatingManager.handleSelection();
        });
        // Scroll does not bubble, so listen in the capture phase.
        this.registerDomEvent(doc, "scroll", (evt) => this.onReadingScroll(evt), { capture: true, passive: true });
    }

    async loadSettings() {
        const loaded = ((await this.loadData()) as Partial<ReadingHighlighterSettings> & LegacyColorSettings) || {};
        const { enableColorHighlighting, highlightColor, ...current } = loaded;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, current, {
            semanticColors: migratePalette(loaded.semanticColors),
        });
        // Once only: a meaning typed after this is kept, even if it reads like
        // one of the old built-in ones. The flag is saved with the next change.
        if (!this.settings.builtInMeaningsCleared) {
            clearBuiltInMeanings(this.settings.semanticColors);
            this.settings.builtInMeaningsCleared = true;
        }
        if (!isHighlightColor(this.settings.defaultHighlightColor)) {
            // A default colour chosen when highlights were HTML becomes the
            // nearest native one.
            this.settings.defaultHighlightColor =
                (enableColorHighlighting && nearestHighlightColor(highlightColor)) || "";
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.floatingManager.refresh();
    }

    getActiveReadingView(): MarkdownView | null {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        return view && view.getMode() === "preview" ? view : null;
    }

    /**
     * The selection of the window holding `view`. A note moved to a popout
     * window has its own selection, which `window.getSelection()` — the main
     * window's — never sees.
     */
    selectionFor(view: View | null | undefined): Selection | null {
        const win = view?.containerEl?.ownerDocument?.defaultView ?? window;
        return win.getSelection();
    }

    getSelectionContext(selectionSnapshot: SelectionSnapshot | null) {
        const view = this.getActiveReadingView();
        const range = this.getSelectionRange(selectionSnapshot);
        if (!view || !range) return null;

        const blocks = this.getAllowedBlocksInRange(range, view.contentEl);
        const fallbackBlock = this.getClosestAllowedBlock(range.commonAncestorContainer, view.contentEl);
        // A selection inside one list item nested in another belongs to that
        // item. `blocks` holds the outermost block it touches, whose text
        // takes in the whole nested list: the selected word's occurrence
        // would be counted across every nested item.
        const innermost =
            blocks.length === 1 && fallbackBlock && blocks[0].contains(fallbackBlock) ? fallbackBlock : null;
        const contextElement = innermost || blocks[0] || fallbackBlock || null;
        const rawSnippet = selectionSnapshot?.text || this.selectionFor(view)?.toString() || "";

        let snippet = rawSnippet;
        if (this.settings.enableSmartParagraphSelection && blocks.length === 1 && contextElement) {
            const blockText = this.getElementText(contextElement);
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
        const selection = this.selectionFor(this.getActiveReadingView());
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

    /**
     * The kind of source block a rendered block comes from. Reading view
     * renders a footnote as a list item at the end of the note, but in the
     * source it is a footnote definition, not a list item: without telling them
     * apart, a footnote reading like an entry of the note's bibliography was
     * found in the bibliography.
     */
    blockKindOf(element: HTMLElement | null | undefined): BlockKind | null {
        if (element?.tagName === "LI" && element.closest("section.footnotes, .footnotes")) return "footnote";
        return kindForTag(element?.tagName);
    }

    /**
     * A block's rendered text. A list item's own text leaves out the lists
     * nested in it: in the source, each of their items is a block of its own.
     * A footnote's back arrow is not text of the note either.
     */
    getElementText(element: HTMLElement) {
        let source = element;
        if (
            element?.querySelector?.(".footnote-backref") ||
            (element?.tagName === "LI" && element.querySelector("ul, ol"))
        ) {
            source = element.cloneNode(true) as HTMLElement;
            if (element.tagName === "LI") source.querySelectorAll("ul, ol").forEach((list) => list.remove());
            source.querySelectorAll(".footnote-backref").forEach((arrow) => arrow.remove());
        }
        return (source?.innerText || source?.textContent || "").replace(/\s+/g, " ").trim();
    }

    buildSelectionRequest(view: MarkdownView, selectionSnapshot: SelectionSnapshot | null) {
        const sel = this.selectionFor(view);
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
            contextKind: this.blockKindOf(contextElement),
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
        const contextText = this.getElementText(contextElement);
        const tagName = contextElement.tagName.toLowerCase();
        // Only blocks of the same kind: a footnote and a bibliography entry
        // reading alike are both list items, but not the same sequence.
        const kind = this.blockKindOf(contextElement);
        const allElements = view.contentEl.querySelectorAll(tagName);
        let count = 0;
        let foundIndex = 0;
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i] as HTMLElement;
            if (this.blockKindOf(el) === kind && this.getElementText(el) === contextText) {
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
        // An entry without a result was never written (a tag or annotation
        // dialog that was cancelled), so there is nothing in it to undo.
        this.undoHistory = this.undoHistory.filter((entry) => entry.after !== undefined);
        this.undoHistory.push({ file, original: await this.app.vault.read(file) });
        if (this.undoHistory.length > MAX_UNDO_STEPS) this.undoHistory.shift();
    }

    /** Record the note as a change left it, so undo can tell if it was edited since. */
    async recordUndoResult(file: TFile, content?: string) {
        const last = this.undoHistory[this.undoHistory.length - 1];
        if (!last || last.file !== file) return;
        last.after = content ?? (await this.app.vault.read(file));
    }

    /**
     * Undo the latest change to the open note, or the latest change anywhere
     * when the open note has none. Run again to go further back.
     */
    async undoLastHighlight() {
        const done = this.undoHistory.filter((entry) => entry.after !== undefined);
        const active = this.app.workspace.getActiveFile();
        const entry = [...done].reverse().find((e) => e.file === active) ?? done[done.length - 1];
        if (!entry) {
            this.notify("Nothing to undo.");
            return;
        }
        await this.undoChange(entry);
    }

    /** Undo one recorded change, if the note still reads as it left it. */
    async undoChange(entry: UndoEntry) {
        if (!this.undoHistory.includes(entry)) {
            this.notify("Already undone.");
            return;
        }
        try {
            const current = await this.app.vault.read(entry.file);
            if (current !== entry.after) {
                // Nothing written since can be kept by restoring, so this
                // change can no longer be undone.
                this.undoHistory = this.undoHistory.filter((e) => e !== entry);
                this.notify("The note has changed since, so undoing would lose those changes.");
                return;
            }
            await this.app.vault.modify(entry.file, entry.original);
            this.undoHistory = this.undoHistory.filter((e) => e !== entry);
            this.notify("Undone.");
        } catch (err) {
            this.notify("Failed to undo.");
            console.error(err);
        }
    }

    /**
     * Run an action started from the toolbar or a command. It is not awaited
     * by its caller, so a failure would otherwise vanish: the selection stays,
     * the toolbar goes, and nothing says why.
     */
    runAction(action: Promise<unknown>) {
        action.catch((err: unknown) => {
            console.error("Reader Highlighter Tags: action failed.", err);
            this.notify(`That did not work: ${err instanceof Error ? err.message : "unknown error"}`);
        });
    }

    /**
     * Show a notice in place of the plugin's previous one. Notices stacked up
     * one per action, and an Undo left on screen after a newer change or after
     * its own change was undone could no longer do anything.
     */
    notify(message: string | DocumentFragment, duration?: number): Notice {
        this.currentNotice?.hide();
        // Wrapped so styles.css can draw the plugin's notices as one slim line
        // without touching anyone else's.
        const content =
            typeof message === "string"
                ? createFragment((f) => f.createSpan({ cls: "reading-highlighter-notice", text: message }))
                : message;
        this.currentNotice = new Notice(content, duration);
        return this.currentNotice;
    }

    /** A notice for a change just made, with a button that undoes it. */
    noticeWithUndo(message: string) {
        const entry = this.undoHistory[this.undoHistory.length - 1];
        if (!entry || entry.after === undefined) {
            this.notify(message);
            return;
        }
        const fragment = createFragment((f) => {
            const row = f.createSpan({ cls: "reading-highlighter-notice" });
            row.createSpan({ text: message });
            row.createEl("button", { text: "Undo", cls: "reading-highlighter-undo-btn" });
        });
        const button = fragment.querySelector(".reading-highlighter-undo-btn");
        this.notify(fragment, UNDO_NOTICE_MS);
        button?.addEventListener("click", (evt) => {
            evt.stopPropagation();
            // Undoing replaces this notice with its outcome. Left open, it
            // stayed on a phone: after a tap the finger counts as hovering
            // over it, and Obsidian never hides a hovered notice.
            void this.undoChange(entry);
        });
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
    async locateBlockPortion(
        view: MarkdownView,
        range: Range,
        block: HTMLElement,
        after: { file: TFile; offset: number } | null = null
    ): Promise<LocatedRange | null> {
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
            this.blockKindOf(block),
            after
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
        if (!head) return false;
        let tail: LocatedRange | null = null;
        for (let i = blocks.length - 1; i >= 0 && !tail; i--) {
            tail = await this.locateBlockPortion(view, request.range, blocks[i], {
                file: head.file,
                offset: head.start,
            });
        }
        // The end found before the start means one of them is in the wrong
        // place: everything between would be highlighted. Ask instead.
        if (!tail || head.file.path !== tail.file.path || tail.start < head.start) return false;

        const start = head.start;
        const end = Math.max(head.end, tail.end);
        if (end <= start) return false;

        await this.saveUndoState(head.file);
        await this.applyMarkdownModification(head.file, "", start, end, mode, payload);
        return true;
    }

    async highlightSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const sel = this.selectionFor(view);
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            this.notify("No text selected.");
            return;
        }
        const scrollPos = getScroll(view);

        const mode = "highlight";
        const payload = "";

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
            this.noticeWithUndo("Highlighted.");
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
        this.noticeWithUndo("Highlighted.");
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
        let snippet = selectionSnapshot?.text || this.selectionFor(view)?.toString() || "";
        if (!snippet.trim()) {
            this.notify("No text selected.");
            return;
        }
        snippet = this.sanitizePdfText(snippet);
        const pdfName = view.file.basename;
        // normalizePath, because a PDF at the vault root has the parent path
        // "/" and the joined path would start with "//".
        const companionFile = normalizePath(`${view.file.parent?.path ?? ""}/${pdfName} - Highlights.md`);
        const fileExists = this.app.vault.getAbstractFileByPath(companionFile);

        let highlightOutput = snippet.trim();
        if (mode === "color") {
            const index = typeof payload === "number" ? payload : parseInt(payload);
            const palette = this.settings.semanticColors[index];
            if (palette) {
                // One highlight per line: a pair cannot span the quote's lines.
                highlightOutput = highlightOutput
                    .split("\n")
                    .map((line) => wrapHighlight(line, palette.color))
                    .join("\n");
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
            this.notify("Saved to " + pdfName + " - Highlights");
            this.selectionFor(view)?.removeAllRanges();
            if (this.settings.enableHaptics && Platform.isMobile) {
                navigator.vibrate?.(10);
            }
        } catch (e) {
            console.error("Failed to save PDF highlight", e);
            this.notify("Failed to save PDF highlight");
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
            this.notify("Please open a PDF file first.");
            return;
        }

        const notice = this.notify("Extracting all PDF text...", 0);

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
            this.notify(`Successfully extracted ${pdf.numPages} pages.`);
        } catch (e) {
            console.error("Full PDF extraction failed", e);
            notice.hide();
            this.notify("Failed to extract PDF text.");
        }
    }

    async tagSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            this.notify("No text selected.");
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
                this.notify("Selection lost - file may have changed.");
                return;
            }

            if (tag && this.settings.enableSmartTagSuggestions) {
                this.addRecentTag(tag);
            }

            await this.applyMarkdownModification(targetFile, "", newResult.start, newResult.end, "tag", tag);
            this.restoreScroll(view, scrollPos);
            this.selectionFor(view)?.removeAllRanges();
            this.noticeWithUndo("Tagged.");
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
            this.notify("No text selected.");
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
                this.notify("Selection lost - file may have changed.");
                return;
            }

            const currentRaw = await this.app.vault.read(targetFile);
            await this.applyAnnotation(targetFile, currentRaw, newResult.start, newResult.end, comment);
            this.restoreScroll(view, scrollPos);
            this.selectionFor(view)?.removeAllRanges();
            this.noticeWithUndo("Annotation added.");
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
        await this.recordUndoResult(file, newContent);
    }

    async removeHighlightSelection(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const sel = this.selectionFor(view);
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            this.notify("Select highlighted text to remove.");
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
        this.noticeWithUndo("Highlighting removed.");
        this.restoreScroll(view, scrollPos);
        sel?.removeAllRanges();
    }

    async removeAllHighlights(view: MarkdownView) {
        await this.removeAllHighlightsInFile(view.file);
    }

    async removeAllHighlightsInFile(file: TFile) {
        const raw = await this.app.vault.read(file);
        const result = removeAllHighlightsFromRaw(raw);
        if (!result.removedCount) {
            this.notify("No highlights to remove.");
            return;
        }
        const count = result.removedCount;
        const confirmed = await confirmAction(this.app, {
            title: "Remove all highlights?",
            message: `This removes ${count} highlight${count === 1 ? "" : "s"} from "${file.basename}". The text stays.`,
            confirmText: "Remove highlights",
        });
        if (!confirmed) return;
        // Read again: the note may have changed while the dialog was open.
        await this.saveUndoState(file);
        const current = await this.app.vault.read(file);
        const final = removeAllHighlightsFromRaw(current);
        await this.app.vault.modify(file, final.raw);
        await this.recordUndoResult(file, final.raw);
        this.noticeWithUndo("All highlights removed.");
    }

    async removeAnnotationById(file: TFile, footnoteId: string) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = removeFootnoteFromRaw(raw, footnoteId);
        if (!result.changed) {
            this.notify("Annotation not found.");
            return;
        }
        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        this.noticeWithUndo("Annotation removed.");
    }

    /**
     * Remove every annotation of the note — every footnote, as the navigator
     * lists them — after showing how many and which. Citations are footnotes
     * too, and there is no telling them apart, so the dialog says so.
     */
    async removeAllAnnotations(file: TFile) {
        const raw = await this.app.vault.read(file);
        const footnotes = [...parseFootnotes(raw).values()];
        const count = footnotes.length;
        if (!count) {
            this.notify("No annotations to remove.");
            return;
        }
        const shown = footnotes.slice(0, 8).map((f) => `[^${f.id}] ${f.text}`.slice(0, 120));
        if (count > shown.length) shown.push(`…and ${count - shown.length} more`);
        const confirmed = await confirmAction(this.app, {
            title: "Remove all annotations?",
            message: `This removes all ${count} footnote${count === 1 ? "" : "s"} in "${file.basename}", with their references. Citations are footnotes too and are removed with them.`,
            details: shown,
            confirmText: "Remove annotations",
        });
        if (!confirmed) return;
        // Read again: the note may have changed while the dialog was open.
        await this.saveUndoState(file);
        const current = await this.app.vault.read(file);
        const result = removeAllFootnotesFromRaw(current);
        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        this.noticeWithUndo(`Removed ${result.removedCount} annotation${result.removedCount === 1 ? "" : "s"}.`);
    }

    async mergeAdjacentHighlightsInFile(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = mergeAdjacentHighlightsInRaw(raw);

        if (!result.mergedCount) {
            this.notify("No adjacent highlights to merge.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        this.noticeWithUndo(`Merged ${result.mergedCount} highlight${result.mergedCount === 1 ? "" : "s"}.`);
    }

    async recolorHighlightsInFile(file: TFile, from: RecolorSource, to: HighlightColor | null) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = recolorHighlightsInRaw(raw, { from, to });

        if (!result.changedCount) {
            this.notify("No matching highlights to recolour.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        this.noticeWithUndo(`Recoloured ${result.changedCount} highlight${result.changedCount === 1 ? "" : "s"}.`);
    }

    async convertHtmlHighlightsInFile(file: TFile) {
        await this.saveUndoState(file);
        const raw = await this.app.vault.read(file);
        const result = convertHtmlHighlightsInRaw(raw);

        if (!result.changedCount) {
            this.notify("No HTML highlights in this note.");
            return;
        }

        await this.app.vault.modify(file, result.raw);
        await this.recordUndoResult(file, result.raw);
        this.noticeWithUndo(
            `Converted ${result.changedCount} HTML highlight${result.changedCount === 1 ? "" : "s"} to native highlights.`
        );
    }

    async exportHighlights(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToMD(this.app, view.file);
            this.notify(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            this.notify("Failed to export highlights.");
            console.error(err);
        }
    }

    async exportHighlightsJSON(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToJSON(this.app, view.file);
            this.notify(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            this.notify("Failed to export highlights to JSON.");
            console.error(err);
        }
    }

    async exportHighlightsCSV(view: MarkdownView) {
        try {
            const exportPath = await exportHighlightsToCSV(this.app, view.file);
            this.notify(`Highlights exported to ${exportPath}`);
            const exportFile = this.app.vault.getAbstractFileByPath(exportPath);
            if (exportFile instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(exportFile);
            }
        } catch (err) {
            this.notify("Failed to export highlights to CSV.");
            console.error(err);
        }
    }

    async copyAsQuote(view: MarkdownView, selectionSnapshot?: SelectionSnapshot | null) {
        const sel = this.selectionFor(view);
        const request = this.buildSelectionRequest(view, selectionSnapshot);
        if (!request) {
            this.notify("No text selected.");
            return;
        }
        const frontmatter =
            (this.app.metadataCache.getFileCache(view.file)?.frontmatter as Record<string, unknown>) || {};
        const quote = this.expandQuoteTemplate(view.file, request.snippet, frontmatter);
        const copied = await this.writeClipboardText(quote);
        if (!copied) {
            this.notify("Failed to copy quote.");
            return;
        }
        this.notify("Copied as quote!");
        sel?.removeAllRanges();
    }

    async applyColorHighlight(
        view: MarkdownView,
        color: HighlightColor,
        autoTag = "",
        selectionSnapshot?: SelectionSnapshot | null
    ) {
        const sel = this.selectionFor(view);
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
        this.noticeWithUndo("Highlighted.");
    }

    /**
     * Note where the active reading view has scrolled to, once it stops.
     *
     * Saving on `active-leaf-change` alone read the note being *opened*, not
     * the one being left, and missed navigation within a tab altogether.
     */
    onReadingScroll(evt: Event) {
        if (!this.settings.enableReadingProgress) return;
        const view = this.getActiveReadingView();
        const target = evt.target as Node | null;
        if (!view?.file || !target || !view.containerEl.contains(target)) return;
        this.pendingProgress = { view, file: view.file };
        if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
        this.progressTimer = window.setTimeout(() => this.flushReadingProgress(), 800);
    }

    flushReadingProgress() {
        if (this.progressTimer !== null) {
            window.clearTimeout(this.progressTimer);
            this.progressTimer = null;
        }
        const pending = this.pendingProgress;
        this.pendingProgress = null;
        // A tab that has moved on to another note scrolls for that note now.
        if (!pending || pending.view.file !== pending.file || !this.settings.enableReadingProgress) return;
        let y = 0;
        try {
            y = getScroll(pending.view).y;
        } catch {
            return;
        }
        const path = pending.file.path;
        if (y > 0) this.settings.readingPositions[path] = y;
        else if (path in this.settings.readingPositions) delete this.settings.readingPositions[path];
        else return;
        void this.saveData(this.settings);
    }

    async resumeReading(view: MarkdownView) {
        const pos = this.settings.readingPositions[view.file.path];
        if (pos) {
            applyScroll(view, { x: 0, y: pos });
            this.notify("Resumed reading position.");
        } else {
            this.notify("No saved position for this file.");
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

    /**
     * Fill the quote template.
     *
     * Whatever precedes `{{text}}` on its line (`> ` in the default) starts
     * every line of the selection, so a quote of several lines stays one
     * blockquote. The selection used to arrive already quoted, which with the
     * default template nested its first line one level deeper (`> > `). A
     * template with `{{text}}` alone at the start of a line still gets each line
     * quoted; one quoting it inline, such as `«{{text}}»`, gets the text as it
     * is, without a `>` inside its quotation marks.
     */
    expandQuoteTemplate(file: TFile, text: string, frontmatter: Record<string, unknown> = {}) {
        const sourceUrl = toDisplayString(frontmatter.url || frontmatter.source || frontmatter.link).replace(
            /#:~:text=[^&]+(&|$)/,
            ""
        );
        const timestamp = this.formatTimestamp(new Date());
        const variables: Record<string, string> = {
            file: file.basename,
            path: file.path,
            date: timestamp.split("T")[0],
            time: timestamp,
            domain: this.extractDomain(sourceUrl),
            author: this.normalizeFrontmatterValue(
                frontmatter.author || frontmatter.authors || frontmatter.creator || ""
            ),
        };
        const lines = text.split(/\r?\n/);
        return this.settings.quoteTemplate
            .replace(/{{(file|path|date|time|domain|author)}}/g, (_match: string, key: string) => variables[key] || "")
            .replace(/^(.*?){{text}}/gm, (_match: string, prefix: string) => {
                if (/>\s*$/.test(prefix)) return prefix + lines.join(`\n${prefix}`);
                if (prefix.trim()) return prefix + lines.join("\n");
                return prefix + lines.map((line) => `> ${line}`).join("\n");
            });
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
        // Markdown takes only a space or a tab after a marker: "1.\u00a0Usos",
        // with a no-break space, is a paragraph, not a list item.
        const heading = /^#{1,6}[ \t]+/;
        const prefixPatterns = [
            /^>\s*/,
            heading,
            /^-[ \t]\[[ xX]\][ \t]+/,
            // A marker alone on its line is an empty list item.
            /^[-*+](?:[ \t]+|$)/,
            /^\d{1,3}[.)](?:[ \t]+|$)/,
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
                    // A heading's text is not a list: "### 2. Functions"
                    // keeps its "2.".
                    matched = pattern !== heading;
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
        color: HighlightColor | null
    ): string {
        const cells = this.splitTableCells(line);
        const pieces: string[] = [];

        cells.forEach((cell, index) => {
            const text = line.substring(cell.start, cell.end);
            const stripped = stripHighlightMarkers(text.replace(/<mark[^>]*>/g, "").replace(/<\/mark>/g, ""));
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

            pieces.push(wrapHighlight(stripped, color));
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
        // The highlights Obsidian renders. A `==` that is not one of their
        // markers — a comparison, code — is text and is never taken in or
        // removed.
        const existingHighlights = parseHighlights(raw).highlights;
        const markerStarts = new Set(existingHighlights.flatMap((h) => [h.openTagStart, h.closeTagStart]));
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
            const backIsText = matchBack?.[0] === "==" && !markerStarts.has(expandedStart - 2);
            if (matchBack && !backIsText && expandedStart > bodyStart) {
                const newStart = expandedStart - matchBack[0].length;
                if (newStart >= bodyStart) {
                    expandedStart = newStart;
                    expanded = true;
                }
            }
            const following = raw.substring(expandedEnd);
            // Expanded to include balanced punctuation, quotes (including « »), and footnotes
            const matchForward = following.match(
                /^(<\/mark>|\*\*|==|~~|\*|_|\]\]|\]\([^)]+\)|\[\^[^\]]+\]|[.?!,;:]["']?|[)\]}"'»”’›.?!,;:][ \t]?)/
            );
            if (matchForward && !(matchForward[0] === "==" && !markerStarts.has(expandedEnd))) {
                expandedEnd += matchForward[0].length;
                expanded = true;
            }
        }
        // Obsidian shows a wikilink's text exactly as written, so a marker
        // inside `[[…]]` either shows as text or, in the link's target, breaks
        // the link. A selection reaching into one takes the whole link.
        const linkScanStart = this.getLineStart(raw, expandedStart);
        const linkScan = raw.substring(linkScanStart, this.getLineEnd(raw, expandedEnd));
        for (const link of linkScan.matchAll(/!?\[\[(?:[^\]\n]|\](?!\]))*\]\]/g)) {
            const linkStart = linkScanStart + link.index;
            const linkEnd = linkStart + link[0].length;
            if (linkStart < expandedStart && expandedStart < linkEnd) expandedStart = linkStart;
            if (linkStart < expandedEnd && expandedEnd < linkEnd) expandedEnd = linkEnd;
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
        // The first highlight merged in lends its colour, so extending or
        // tagging a coloured highlight keeps it coloured.
        let mergedColor: HighlightColor | null = null;
        let mergedAny = false;
        if (mode === "highlight" || mode === "color" || mode === "tag" || mode === "remove") {
            for (const existing of existingHighlights) {
                const overlaps = existing.openTagStart < expandedEnd && existing.closeTagEnd > expandedStart;
                if (!overlaps) continue;
                if (!mergedAny) mergedColor = existing.color;
                mergedAny = true;
                expandedStart = Math.min(expandedStart, existing.openTagStart);
                expandedEnd = Math.max(expandedEnd, existing.closeTagEnd);
            }
        }
        // A colour button sets the colour; the plain button and tagging keep
        // what is there, or fall back to the default colour.
        const color: HighlightColor | null =
            mode === "color" && isHighlightColor(payload)
                ? payload
                : mergedAny
                  ? mergedColor
                  : this.settings.defaultHighlightColor || null;

        // A selection across lines is not widened to whole lines: from the
        // middle of one paragraph to the middle of the next, only the selected
        // part of each is highlighted. The first and last lines keep the text
        // outside the selection as `lineHead` and `lineTail` below.
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
        // The markers of the highlights now inside the range: the ones to
        // remove before writing it back.
        const markerRanges = existingHighlights
            .filter((h) => h.openTagStart >= expandedStart && h.closeTagEnd <= expandedEnd)
            .flatMap((h): [number, number][] => [
                [h.openTagStart, h.openTagEnd],
                [h.closeTagStart, h.closeTagEnd],
            ]);
        const withoutMarkers = (line: string, lineStart: number) => {
            let out = "";
            for (let k = 0; k < line.length; k++) {
                const at = lineStart + k;
                if (!markerRanges.some(([a, b]) => at >= a && at < b)) out += line[k];
            }
            return out;
        };
        // Where each kept character of a line came from in `raw`.
        const keptOffsets = (line: string, lineStart: number) => {
            const offsets: number[] = [];
            for (let k = 0; k < line.length; k++) {
                const at = lineStart + k;
                if (!markerRanges.some(([a, b]) => at >= a && at < b)) offsets.push(at);
            }
            return offsets;
        };
        // Delimiters that pair with a partner on another line of their
        // paragraph — an italic poem, a bold passage across soft line breaks.
        // Highlighted line by line, each line alone would look unpaired.
        const crossLineDelimiters = new Set<number>();
        if (mode === "highlight" || mode === "tag" || mode === "color") {
            for (const block of splitSourceBlocks(raw)) {
                if (block.end <= expandedStart || block.start >= expandedEnd) continue;
                const text = raw.substring(block.start, block.end);
                if (!text.includes("\n")) continue;
                // Quote markers are not part of the paragraph's text; blank them
                // so offsets stay put.
                const paragraph = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, (m) => " ".repeat(m.length));
                for (const pair of emphasisPairs(paragraph)) {
                    if (!paragraph.slice(pair.open[1], pair.close[0]).includes("\n")) continue;
                    for (const [a, b] of [pair.open, pair.close]) {
                        for (let k = a; k < b; k++) crossLineDelimiters.add(block.start + k);
                    }
                }
            }
        }
        // The text of the first and last lines outside the range. Lines are
        // written back whole: a highlight can need a stray `==` before or
        // after it escaped, so that the stray cannot pair with it.
        const lineHead = raw.substring(this.getLineStart(raw, expandedStart), expandedStart);
        const lineTail = raw.substring(expandedEnd, this.getLineEnd(raw, expandedEnd));
        const processLine = (line: string, lineIndex: number): string | { whole: string } => {
            let cleanLine = line.replace(/<mark[^>]*>/g, "").replace(/<\/mark>/g, "");
            if (this.isTableAlignmentRow(line)) return line;
            if (this.isTableDataRow(line)) {
                return this.applyToTableRow(line, lineOffsets[lineIndex], selectionStart, selectionEnd, mode, color);
            }
            if (mode === "highlight" || mode === "color" || mode === "tag" || mode === "remove") {
                cleanLine = withoutMarkers(line, lineOffsets[lineIndex]);
            } else if (mode === "bold") {
                cleanLine = cleanLine.split("**").join("");
            } else if (mode === "italic") {
                cleanLine = cleanLine.split("*").join("");
            }
            if (mode === "remove") return cleanLine;
            // List markers, quote markers and heading hashes are only syntax at
            // the start of a line. Selected text that merely begins with "3. "
            // keeps it.
            const atLineStart = lineIndex > 0 || !lineHead.trim();
            // Read the markers off the whole line, not off the selected part of
            // it: "3." selected out of "3.12. Sustantivos" is no list item.
            const rest = lineIndex === lines.length - 1 ? lineTail : "";
            const markers = atLineStart ? this.splitMarkdownLine(cleanLine + rest) : null;
            const markerLength = markers
                ? Math.min(markers.indent.length + markers.prefix.length, cleanLine.length)
                : 0;
            const indent = cleanLine.slice(0, markerLength);
            const prefix = "";
            const content = cleanLine.slice(markerLength);
            if (!content.trim()) return line;

            // Extract leading and trailing whitespace to preserve it outside the highlight
            const leadWS = content.match(/^(\s*)/)?.[1] || "";
            const trailWS = content.match(/(\s*)$/)?.[1] || "";
            const actualContent = content.substring(leadWS.length, content.length - trailWS.length);

            if (!actualContent) return line;

            const tagStr = fullTag ? `${fullTag} ` : "";
            let wrappedContent = actualContent;

            if (mode === "highlight" || mode === "tag" || mode === "color") {
                // Read with the rest of its line, so a bold, italic or
                // struck-through delimiter can be matched with a partner
                // outside the selection and kept with it.
                const before = lineIndex === 0 ? lineHead : "";
                const after = lineIndex === lines.length - 1 ? lineTail : "";
                const head = `${before}${indent}${prefix}${leadWS}`;
                // An existing highlight's marker removed at an edge must be
                // written back there.
                const lineStart = lineOffsets[lineIndex];
                const firstChar = lineStart + (line.length - line.trimStart().length);
                const afterLastChar = lineStart + line.trimEnd().length;
                const markerAtEdge =
                    (lineIndex === 0 && markerRanges.some(([a]) => a === firstChar)) ||
                    (lineIndex === lines.length - 1 && markerRanges.some(([, b]) => b === afterLastChar));
                // The context is `before`, the line without its removed markers,
                // and `after`: map each character back to `raw`.
                const contextOffsets = [
                    ...Array.from({ length: before.length }, (_, k) => expandedStart - before.length + k),
                    ...keptOffsets(line, lineOffsets[lineIndex]),
                    ...Array.from({ length: after.length }, (_, k) => expandedEnd + k),
                ];
                const crossLine = contextOffsets.flatMap((at, k) => (crossLineDelimiters.has(at) ? [k] : []));
                const written = highlightInLine(
                    `${head}${actualContent}${trailWS}${after}`,
                    head.length,
                    head.length + actualContent.length,
                    `==${color ? COLOR_EMOJI[color] : ""}`,
                    tagStr,
                    markerAtEdge,
                    crossLine
                );
                return { whole: written };
            } else if (mode === "bold") {
                wrappedContent = `**${actualContent}**`;
            } else if (mode === "italic") {
                wrappedContent = `*${actualContent}*`;
            }

            return `${indent}${prefix}${leadWS}${tagStr}${wrappedContent}${trailWS}`;
        };
        const processedLines = lines.map((line, lineIndex) => {
            const result = processLine(line, lineIndex);
            if (typeof result !== "string") return result.whole;
            const before = lineIndex === 0 ? lineHead : "";
            const after = lineIndex === lines.length - 1 ? lineTail : "";
            return `${before}${result}${after}`;
        });
        const replaceBlock = processedLines.join(newline);
        const replaceStart = expandedStart - lineHead.length;
        const replaceEnd = expandedEnd + lineTail.length;
        const newContent = raw.substring(0, replaceStart) + replaceBlock + raw.substring(replaceEnd);
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
        // Read back rather than reuse newContent: the frontmatter step above
        // may have written to the note again.
        await this.recordUndoResult(file);
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
            this.notify("Selection failed, but no diagnostic report was generated.");
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
                    this.notify("Normalization rule learned for future selections!");
                }
            }
            const mockSnapshot = { text: correctedText, range: null };
            if (actionType === "applyColorHighlight" && isHighlightColor(payload)) {
                await this.applyColorHighlight(view, payload, "", mockSnapshot);
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

const HIGHLIGHT_COLOUR_DESC =
    "Colour the highlight button writes, as an Obsidian highlight colour (==🟡text==). Extending a highlight keeps its colour.";
const PALETTE_DESC =
    "Show Obsidian's six highlight colours in the toolbar. Highlight colours need Obsidian 1.14 or later; older versions show the colour emoji.";

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
            name: COLOR_LABELS[item.color],
            aliases: item.meaning ? [item.meaning] : [],
            control: {
                type: "text",
                key: `semanticColors.${index}.meaning`,
                placeholder: MEANING_PLACEHOLDERS[item.color],
            },
        }));
        const colourOptions: Record<string, string> = { "": "Theme default" };
        for (const color of HIGHLIGHT_COLORS) colourOptions[color] = COLOR_LABELS[color];

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
                        name: "Highlight colour",
                        desc: HIGHLIGHT_COLOUR_DESC,
                        control: { type: "dropdown", key: "defaultHighlightColor", options: colourOptions },
                    },
                    {
                        name: "Show colour palette",
                        desc: PALETTE_DESC,
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
                                    this.plugin.notify("Reading positions cleared.");
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
                                          this.plugin.notify("Rule deleted.");
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
                                          this.plugin.notify("All rules cleared.");
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
        } else if (key === "defaultHighlightColor") {
            settings[key] = isHighlightColor(asText) ? asText : "";
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
            .setName("Highlight colour")
            .setDesc(HIGHLIGHT_COLOUR_DESC)
            .addDropdown((dropdown) => {
                dropdown.addOption("", "Theme default");
                for (const color of HIGHLIGHT_COLORS) dropdown.addOption(color, COLOR_LABELS[color]);
                dropdown.setValue(this.plugin.settings.defaultHighlightColor).onChange(async (value) => {
                    this.plugin.settings.defaultHighlightColor = isHighlightColor(value) ? value : "";
                    await this.plugin.saveSettings();
                });
            });
        new Setting(containerEl)
            .setName("Show colour palette")
            .setDesc(PALETTE_DESC)
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
                const setting = new Setting(containerEl).setName(COLOR_LABELS[item.color]);
                setting.controlEl.createSpan({
                    cls: "highlight-swatch reading-highlighter-swatch rht-color-swatch",
                    attr: { "data-highlight": item.color },
                });
                setting.addText((text) =>
                    text
                        .setPlaceholder(MEANING_PLACEHOLDERS[item.color])
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
                    this.plugin.notify("Reading positions cleared.");
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
                            this.plugin.notify("Rule deleted.");
                        });
                        btn.buttonEl.addClass("mod-warning");
                    });
            });
            new Setting(containerEl).addButton((btn) => {
                btn.setButtonText("Clear all rules").onClick(async () => {
                    this.plugin.settings.learnedNormRules = [];
                    await this.plugin.saveSettings();
                    this.render();
                    this.plugin.notify("All rules cleared.");
                });
                btn.buttonEl.addClass("mod-warning");
            });
        }
    }
}
