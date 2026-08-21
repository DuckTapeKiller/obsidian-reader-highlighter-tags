import { setIcon, MarkdownView, Platform, View, App } from "obsidian";
import type ReadingHighlighterPlugin from "../main";
import type { SemanticColor } from "../main";

type ActionName =
    | "highlightSelection"
    | "tagSelection"
    | "copyAsQuote"
    | "annotateSelection"
    | "removeHighlightSelection";

export interface SelectionSnapshot {
    text: string;
    range: Range | null;
}

export class FloatingManager {
    plugin: ReadingHighlighterPlugin;
    app: App;
    containerEl: HTMLDivElement | null;
    highlightBtn: HTMLButtonElement | null;
    tagBtn: HTMLButtonElement | null;
    removeBtn: HTMLButtonElement | null;
    quoteBtn: HTMLButtonElement | null;
    annotateBtn: HTMLButtonElement | null;
    extractAllBtn: HTMLButtonElement | null;
    colorButtons: HTMLButtonElement[];
    paletteContainer: HTMLDivElement | null;
    _handlers: (() => void)[];
    longPressTimer: number | null;
    _selectionDebounceTimer: number | null;
    _selectionSnapshot: SelectionSnapshot | null;

    constructor(plugin: ReadingHighlighterPlugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.containerEl = null;
        this.highlightBtn = null;
        this.tagBtn = null;
        this.removeBtn = null;
        this.quoteBtn = null;
        this.annotateBtn = null;
        this.extractAllBtn = null;
        this.colorButtons = [];
        this.paletteContainer = null;
        this._handlers = [];

        // Mobile gesture state
        this.longPressTimer = null;

        // Android selection debounce
        this._selectionDebounceTimer = null;

        // Selection snapshot — cached when toolbar is shown so actions can use it
        // even if Android clears the native selection on touchstart
        this._selectionSnapshot = null;
    }

    load() {
        this.createElements();
        this.registerEvents();
        if (Platform.isMobile) {
            this.setupMobileGestures();
        }
    }

    unload() {
        this.containerEl?.remove();
        this.containerEl = null;
        this._handlers.forEach((cleanup) => cleanup());
        this._handlers = [];
        if (this._selectionDebounceTimer) {
            window.clearTimeout(this._selectionDebounceTimer);
            this._selectionDebounceTimer = null;
        }
    }

    refresh() {
        // Rebuild toolbar when settings change
        if (this.containerEl) {
            this.containerEl.remove();
            this.containerEl = null;
        }
        this.colorButtons = [];
        this.createElements();
        this.registerEvents();
        // The rebuilt toolbar starts hidden, and visibility is only ever driven
        // by `selectionchange`. A settings change does not fire that event, so
        // without re-evaluating here the toolbar stays invisible for a selection
        // the user still has active — and looks like it needs a restart to come
        // back. Re-read the current selection so the new toolbar matches it.
        this._doHandleSelection();
    }

    /**
     * Palette entries to show in the toolbar, each keeping its index into
     * `semanticColors` so the colour applied stays correct however the list is
     * filtered.
     *
     * With "only show colours with a meaning" on, colours left unnamed are
     * hidden — a reader using a seven-colour taxonomy should not have to pick
     * past eight unused swatches. If nothing has been named yet, every colour is
     * shown rather than an empty palette that looks broken.
     */
    visiblePaletteColors(): { item: SemanticColor; index: number }[] {
        const all = this.plugin.settings.semanticColors.map((item, index) => ({ item, index }));
        if (!this.plugin.settings.showOnlyAssignedColors) return all;
        const named = all.filter(({ item }) => (item.meaning || "").trim().length > 0);
        return named.length > 0 ? named : all;
    }

    createElements() {
        if (this.containerEl) return;

        this.containerEl = activeDocument.createElement("div");
        this.containerEl.addClass("reading-highlighter-float-container");

        // Main highlight button
        this.highlightBtn = this.createButton("highlighter", "Highlight selection");
        this.containerEl.appendChild(this.highlightBtn);

        // Semantic Color palette (only if enabled)
        if (this.plugin.settings.enableColorPalette) {
            this.paletteContainer = activeDocument.createElement("div");
            this.paletteContainer.addClass("reading-highlighter-palette");

            for (const { item, index } of this.visiblePaletteColors()) {
                const colorBtn = activeDocument.createElement("button");
                colorBtn.addClass("reading-highlighter-color-btn");
                colorBtn.setCssStyles({ backgroundColor: item.color });
                colorBtn.setAttribute("aria-label", item.meaning || "Color " + (index + 1));
                colorBtn.setAttribute("data-color-index", index.toString());
                this.colorButtons.push(colorBtn);
                this.paletteContainer.appendChild(colorBtn);
            }

            this.containerEl.appendChild(this.paletteContainer);
        }

        // Tag button
        if (this.plugin.settings.showTagButton) {
            this.tagBtn = this.createButton("tag", "Tag selection");
            this.containerEl.appendChild(this.tagBtn);
        }

        // Quote button
        if (this.plugin.settings.showQuoteButton) {
            this.quoteBtn = this.createButton("quote", "Copy as quote");
            this.containerEl.appendChild(this.quoteBtn);
        }

        // Annotation button
        if (this.plugin.settings.enableAnnotations && this.plugin.settings.showAnnotationButton) {
            this.annotateBtn = this.createButton("message-square", "Add annotation");
            this.containerEl.appendChild(this.annotateBtn);
        }

        // Remove button
        if (this.plugin.settings.showRemoveButton) {
            this.removeBtn = this.createButton("trash-2", "Remove highlights");
            this.removeBtn.addClass("reading-highlighter-remove-btn");
            this.containerEl.appendChild(this.removeBtn);
        }

        // PDF Extract All Button (Special)
        this.extractAllBtn = this.createButton("file-text", "Extract All PDF Text");
        this.extractAllBtn.addClass("pdf-only-btn");
        this.containerEl.appendChild(this.extractAllBtn);

        activeDocument.body.appendChild(this.containerEl);
    }

    createButton(iconName: string, label: string): HTMLButtonElement {
        const btn = activeDocument.createElement("button");
        setIcon(btn, iconName);
        // Only add tooltip if enabled in settings
        if (this.plugin.settings.showTooltips) {
            btn.setAttribute("aria-label", label);
        }
        btn.addClass("reading-highlighter-btn");
        return btn;
    }

    registerEvents() {
        const preventFocus = (evt: Event) => {
            evt.preventDefault();
            evt.stopPropagation();
        };

        const attachAction = (btn: HTMLButtonElement | null, actionName: ActionName) => {
            if (!btn) return;

            const handler = (evt: Event) => {
                preventFocus(evt);
                let view: MarkdownView | View | null = this.app.workspace.getActiveViewOfType(MarkdownView);
                let isPdf = false;

                if (!view || (view as MarkdownView).getMode() !== "preview") {
                    view = this.app.workspace.getActiveViewOfType(View);
                    if (view && view.getViewType() === "pdf") {
                        isPdf = true;
                    } else {
                        this.hide();
                        return;
                    }
                }

                if (isPdf) {
                    void this.plugin.savePdfHighlight(view, this._selectionSnapshot, "action", actionName);
                } else {
                    void this.plugin[actionName](view as MarkdownView, this._selectionSnapshot);
                }

                this.hide();
            };

            btn.addEventListener("mousedown", handler);
            btn.addEventListener("touchstart", handler, { passive: false });
        };

        // Main actions
        attachAction(this.highlightBtn, "highlightSelection");
        attachAction(this.tagBtn, "tagSelection");
        attachAction(this.quoteBtn, "copyAsQuote");
        attachAction(this.annotateBtn, "annotateSelection");
        attachAction(this.removeBtn, "removeHighlightSelection");

        // Special: Extract All PDF
        if (this.extractAllBtn) {
            const handler = (evt: Event) => {
                preventFocus(evt);
                const view = this.app.workspace.getActiveViewOfType(View);
                if (view && view.getViewType() === "pdf") {
                    void this.plugin.extractAllPdfText(view);
                }
                this.hide();
            };
            this.extractAllBtn.addEventListener("mousedown", handler);
            this.extractAllBtn.addEventListener("touchstart", handler, { passive: false });
        }

        // Color palette buttons
        this.colorButtons.forEach((btn) => {
            // Read the index off the button: the palette may be filtered, so a
            // button's position is not its index into `semanticColors`.
            const index = Number(btn.getAttribute("data-color-index"));
            const handler = (evt: Event) => {
                preventFocus(evt);
                let view: MarkdownView | View | null = this.app.workspace.getActiveViewOfType(MarkdownView);
                let isPdf = false;

                if (!view || (view as MarkdownView).getMode() !== "preview") {
                    view = this.app.workspace.getActiveViewOfType(View);
                    if (view && view.getViewType() === "pdf") {
                        isPdf = true;
                    } else {
                        this.hide();
                        return;
                    }
                }

                if (isPdf) {
                    void this.plugin.savePdfHighlight(view, this._selectionSnapshot, "color", index);
                } else {
                    void this.plugin.applyColorByIndex(view as MarkdownView, index, this._selectionSnapshot);
                }

                this.hide();
            };

            btn.addEventListener("mousedown", handler);
            btn.addEventListener("touchstart", handler, { passive: false });
        });
    }

    setupMobileGestures() {
        // Long press to highlight without showing toolbar
        // Only enable on iOS — on Android this races with the native selection
        // behaviour and causes partial (single-word) highlights.
        if (!Platform.isIosApp) return;

        activeDocument.addEventListener(
            "touchstart",
            () => {
                this.longPressTimer = window.setTimeout(() => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    const sel = window.getSelection();

                    if (view && view.getMode() === "preview" && sel?.toString().trim()) {
                        void this.plugin.highlightSelection(view);
                        this.hide();
                    }
                }, 600);
            },
            { passive: true }
        );

        activeDocument.addEventListener(
            "touchmove",
            () => {
                if (this.longPressTimer) {
                    window.clearTimeout(this.longPressTimer);
                    this.longPressTimer = null;
                }
            },
            { passive: true }
        );

        activeDocument.addEventListener(
            "touchend",
            () => {
                if (this.longPressTimer) {
                    window.clearTimeout(this.longPressTimer);
                    this.longPressTimer = null;
                }
            },
            { passive: true }
        );
    }

    /**
     * Called on every `selectionchange` event.
     * On Android the event fires per-word during a drag, so we debounce it
     * to wait for the selection to settle before showing the toolbar.
     * On iOS/Desktop we keep the original instant behaviour.
     */
    handleSelection() {
        if (Platform.isAndroidApp) {
            // Debounce: wait for selection to stabilise
            if (this._selectionDebounceTimer) {
                window.clearTimeout(this._selectionDebounceTimer);
            }
            this._selectionDebounceTimer = window.setTimeout(() => {
                this._selectionDebounceTimer = null;
                this._doHandleSelection();
            }, 300);
        } else {
            this._doHandleSelection();
        }
    }

    /** Internal: actually process the current selection state. */
    _doHandleSelection() {
        let view: MarkdownView | View | null = this.app.workspace.getActiveViewOfType(MarkdownView);
        let isPdf = false;
        if (!view || (view as MarkdownView).getMode() !== "preview") {
            view = this.app.workspace.getActiveViewOfType(View);
            if (!view || view.getViewType() !== "pdf") {
                this.hide();
                return;
            }
            isPdf = true;
        }

        this.containerEl?.toggleClass("is-pdf-view", isPdf);

        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";

        if (snippet.trim() && sel && !sel.isCollapsed && sel.rangeCount > 0) {
            // Guard: Never show toolbar inside code blocks
            let node: Node | null = sel.anchorNode;
            while (node && node !== activeDocument.body) {
                if (node.nodeName === "PRE" || node.nodeName === "CODE") {
                    this.hide();
                    return;
                }
                node = node.parentNode;
            }

            const range = sel.getRangeAt(0);
            const rect = range.getBoundingClientRect();

            // Cache the selection snapshot so toolbar actions can use it later
            // (Android may clear the native selection when the user taps a button)
            this._selectionSnapshot = {
                text: snippet,
                range: range.cloneRange(),
            };

            this.show(rect);
        } else {
            this._selectionSnapshot = null;
            this.hide();
        }
    }

    show(rect: DOMRect) {
        if (!this.containerEl || !rect) return;

        // Show + reset dynamic styles & classes
        this.containerEl.setCssStyles({ display: "flex", top: "", bottom: "", left: "", right: "", transform: "" });
        this.containerEl.removeClass("reading-highlighter-vertical");

        const pos = this.plugin.settings.toolbarPosition || "text";

        if (pos === "text") {
            const containerHeight = 50;
            const containerWidth = this.plugin.settings.enableColorPalette ? 320 : 180;

            if (Platform.isAndroidApp) {
                // ── Android: place toolbar BELOW the selection ──
                // Android's native context menu (copy/paste/search) appears
                // directly above the selection, so we place our toolbar below
                // to avoid being hidden behind it.
                const gap = 12;
                let top = rect.bottom + gap;
                let left = rect.left + rect.width / 2 - containerWidth / 2;

                // If not enough room below, try above with extra clearance
                // for the native menu (~50px for the menu itself)
                if (top + containerHeight > window.innerHeight - 10) {
                    top = rect.top - containerHeight - 60;
                }
                if (top < 10) top = 10;
                if (left < 10) left = 10;
                if (left + containerWidth > window.innerWidth - 10) {
                    left = window.innerWidth - containerWidth - 10;
                }

                this.containerEl.setCssStyles({ top: `${top}px`, left: `${left}px` });
            } else {
                // ── iOS / Desktop: place toolbar ABOVE the selection (original) ──
                let top = rect.top - containerHeight - 10;
                let left = rect.left + rect.width / 2 - containerWidth / 2;

                if (top < 10) top = rect.bottom + 10;
                if (left < 10) left = 10;
                if (left + containerWidth > window.innerWidth - 10) left = window.innerWidth - containerWidth - 10;

                this.containerEl.setCssStyles({ top: `${top}px`, left: `${left}px` });
            }
        } else if (pos === "top") {
            this.containerEl.setCssStyles({ top: "80px", left: "50%", transform: "translateX(-50%)" });
        } else if (pos === "bottom") {
            this.containerEl.setCssStyles({ bottom: "100px", left: "50%", transform: "translateX(-50%)" });
        } else if (pos === "left") {
            this.containerEl.setCssStyles({ top: "50%", left: "10px", transform: "translateY(-50%)" });
            this.containerEl.addClass("reading-highlighter-vertical");
        } else if (pos === "right") {
            this.containerEl.setCssStyles({ top: "50%", right: "10px", transform: "translateY(-50%)" });
            this.containerEl.addClass("reading-highlighter-vertical");
        }
    }

    hide() {
        if (this.containerEl) {
            this.containerEl.setCssStyles({ display: "none" });
        }
    }
}
