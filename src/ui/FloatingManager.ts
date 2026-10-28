import { setIcon, MarkdownView, Platform, View, App } from "obsidian";
import type ReadingHighlighterPlugin from "../main";
import type { SemanticColor } from "../main";
import { COLOR_LABELS } from "../utils/colors";

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

        // Android selection debounce
        this._selectionDebounceTimer = null;

        // Selection snapshot — cached when toolbar is shown so actions can use it
        // even if Android clears the native selection on touchstart
        this._selectionSnapshot = null;
    }

    // Nothing is highlighted until a toolbar button or a command is used. The
    // iOS long press that highlighted a selection on its own is gone: a finger
    // held still while selecting a paragraph, or on a selection handle, set it
    // off.
    load() {
        this.createElements();
        this.registerEvents();
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
        // Deliberately not shown here. Visibility belongs to `selectionchange`,
        // and a settings change is made from the settings window — showing the
        // toolbar at that moment puts it on top of the settings, not in a note.
        // `createElements` has placed it in the reading view's document, so the
        // next selection there brings it up.
    }

    /**
     * The document the toolbar belongs in — the one holding the reading view,
     * not whichever window happens to be focused.
     *
     * `activeDocument` follows focus, and in Obsidian 1.13 the settings window
     * is a separate OS window. Building the toolbar against `activeDocument`
     * while settings are open puts it inside the settings window: it appears
     * floating over the preferences, and the note is left without one until the
     * app restarts.
     */
    targetDocument(): Document {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const fromView = view?.containerEl?.ownerDocument;
        if (fromView) return fromView;
        const fromWorkspace = (this.app.workspace as { containerEl?: HTMLElement }).containerEl?.ownerDocument;
        return fromWorkspace ?? activeDocument;
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

    /**
     * Build the toolbar as one of Obsidian's own menus.
     *
     * The container carries the `menu` class and every button is a
     * `clickable-icon`, so each theme and preset draws the toolbar the way it
     * draws its context menus and icon buttons: surface, border, radius,
     * shadow, icon and hover colours. styles.css only lays it out. Phones are
     * the exception: there a `.menu` is a bottom sheet, pinned to the screen's
     * foot by Obsidian's own rules, so the container takes the menu's look from
     * its variables instead.
     */
    createElements() {
        if (this.containerEl) return;

        const doc = this.targetDocument();
        // Created through the target document's own body, so the toolbar lands
        // in the window holding the note rather than whichever has focus.
        this.containerEl = doc.body.createDiv({ cls: "reading-highlighter-float-container" });
        if (!Platform.isPhone) this.containerEl.addClass("menu");
        this.hide();

        // Main highlight button
        this.highlightBtn = this.createButton("highlighter", "Highlight selection");

        // Obsidian's native highlight colours (only if enabled)
        if (this.plugin.settings.enableColorPalette) {
            this.paletteContainer = this.containerEl.createDiv({ cls: "reading-highlighter-palette" });

            for (const { item, index } of this.visiblePaletteColors()) {
                const colorBtn = this.paletteContainer.createEl("button", {
                    cls: "clickable-icon reading-highlighter-btn reading-highlighter-color-btn",
                });
                colorBtn.createSpan({
                    cls: "highlight-swatch reading-highlighter-swatch",
                    attr: { "data-highlight": item.color },
                });
                colorBtn.setAttribute("aria-label", item.meaning?.trim() || COLOR_LABELS[item.color]);
                colorBtn.setAttribute("data-color-index", index.toString());
                this.colorButtons.push(colorBtn);
            }
        }

        const showsMore =
            this.plugin.settings.showTagButton ||
            this.plugin.settings.showQuoteButton ||
            (this.plugin.settings.enableAnnotations && this.plugin.settings.showAnnotationButton) ||
            this.plugin.settings.showRemoveButton;
        if (this.paletteContainer && showsMore) {
            this.containerEl.createDiv({ cls: "reading-highlighter-separator" });
        }

        // Tag button
        // Tagging, annotating and erasing write into a note, so a PDF view
        // hides them (markdown-only-btn); its highlights go to a companion note.
        if (this.plugin.settings.showTagButton) {
            this.tagBtn = this.createButton("tag", "Tag selection");
            this.tagBtn.addClass("markdown-only-btn");
        }

        // Quote button
        if (this.plugin.settings.showQuoteButton) {
            this.quoteBtn = this.createButton("quote", "Copy as quote");
        }

        // Annotation button
        if (this.plugin.settings.enableAnnotations && this.plugin.settings.showAnnotationButton) {
            this.annotateBtn = this.createButton("message-square", "Add annotation");
            this.annotateBtn.addClass("markdown-only-btn");
        }

        // Remove button
        if (this.plugin.settings.showRemoveButton) {
            this.removeBtn = this.createButton("trash-2", "Remove highlights");
            this.removeBtn.addClass("reading-highlighter-remove-btn", "markdown-only-btn");
        }

        // PDF Extract All Button (Special)
        this.extractAllBtn = this.createButton("file-text", "Extract all PDF text");
        this.extractAllBtn.addClass("pdf-only-btn");
    }

    createButton(iconName: string, label: string): HTMLButtonElement {
        // Parented to the toolbar, so the element is created in the same
        // document the toolbar lives in.
        const btn = (this.containerEl ?? this.targetDocument().body).createEl("button");
        setIcon(btn, iconName);
        // Only add tooltip if enabled in settings
        if (this.plugin.settings.showTooltips) {
            btn.setAttribute("aria-label", label);
        }
        btn.addClass("clickable-icon", "reading-highlighter-btn");
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
                    this.plugin.runAction(
                        this.plugin.savePdfHighlight(view, this._selectionSnapshot, "action", actionName)
                    );
                } else {
                    this.plugin.runAction(this.plugin[actionName](view as MarkdownView, this._selectionSnapshot));
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
                    this.plugin.runAction(this.plugin.extractAllPdfText(view));
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
                    this.plugin.runAction(this.plugin.savePdfHighlight(view, this._selectionSnapshot, "color", index));
                } else {
                    this.plugin.runAction(
                        this.plugin.applyColorByIndex(view as MarkdownView, index, this._selectionSnapshot)
                    );
                }

                this.hide();
            };

            btn.addEventListener("mousedown", handler);
            btn.addEventListener("touchstart", handler, { passive: false });
        });
    }

    /**
     * Called on every `selectionchange` event.
     * On Android the event fires per-word during a drag, so we debounce it
     * to wait for the selection to settle before showing the toolbar.
     * On iOS/Desktop we keep the original instant behaviour.
     */
    handleSelection() {
        if (Platform.isAndroidApp) {
            // Debounce: wait for selection to stabilise. While it is still
            // moving the toolbar stays out of the way: shown mid-drag, it sat
            // under the finger, and dragging a selection handle onto it
            // stretched the selection to the end of the note.
            this.hide();
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

        // The selection of the window the note is in: a popout window has a
        // selection of its own, and `window` is always the main one.
        const sel = this.targetDocument().defaultView?.getSelection() ?? window.getSelection();
        const snippet = sel?.toString() ?? "";

        // Only a selection inside the note itself. Text selected in a hover
        // preview, the sidebar or a dialog belongs to something else, and
        // highlighting it would go looking for it in this note.
        const inView = !!sel?.anchorNode && view.containerEl.contains(sel.anchorNode);

        if (inView && snippet.trim() && sel && !sel.isCollapsed && sel.rangeCount > 0) {
            // Guard: never show the toolbar inside code blocks, and never while
            // a dialog is open — the note's selection stays live behind the
            // settings dialog, and the toolbar would float on top of it.
            if (activeDocument.querySelector(".modal-container, .modal-bg")) {
                this.hide();
                return;
            }
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
        // A note can be moved to a popout window after the toolbar was built.
        // Rebuild into the right document rather than showing it in the old one.
        if (this.containerEl.ownerDocument !== this.targetDocument()) {
            this.refresh();
            if (!this.containerEl) return;
        }

        const pos = this.plugin.settings.toolbarPosition || "text";
        const vertical = pos === "left" || pos === "right";

        // Show + reset dynamic styles & classes
        this.containerEl.setCssStyles({ display: "flex", top: "", bottom: "", left: "", right: "", transform: "" });
        this.containerEl.toggleClass("reading-highlighter-vertical", vertical);

        if (pos === "text") {
            // Measured rather than assumed: the width depends on the buttons
            // and swatches shown and on the theme's padding and borders.
            const containerHeight = this.containerEl.offsetHeight || 50;
            const containerWidth = this.containerEl.offsetWidth || 180;
            const win = this.containerEl.ownerDocument.defaultView ?? window;
            const margin = 10;
            const clampLeft = (left: number) =>
                Math.max(margin, Math.min(left, win.innerWidth - containerWidth - margin));

            if (Platform.isAndroidApp) {
                // ── Android: place toolbar BELOW the selection ──
                // Android's native context menu (copy/paste/search) appears
                // directly above the selection, so we place our toolbar below
                // to avoid being hidden behind it.
                const gap = 12;
                let top = rect.bottom + gap;

                // If not enough room below, try above with extra clearance
                // for the native menu (~50px for the menu itself)
                if (top + containerHeight > win.innerHeight - margin) {
                    top = rect.top - containerHeight - 60;
                }
                if (top < margin) top = margin;

                const left = clampLeft(rect.left + rect.width / 2 - containerWidth / 2);
                this.containerEl.setCssStyles({ top: `${top}px`, left: `${left}px` });
            } else {
                // ── iOS / Desktop: place toolbar ABOVE the selection (original) ──
                let top = rect.top - containerHeight - margin;
                if (top < margin) top = rect.bottom + margin;

                const left = clampLeft(rect.left + rect.width / 2 - containerWidth / 2);
                this.containerEl.setCssStyles({ top: `${top}px`, left: `${left}px` });
            }
        } else if (pos === "top") {
            this.containerEl.setCssStyles({ top: "80px", left: "50%", transform: "translateX(-50%)" });
        } else if (pos === "bottom") {
            this.containerEl.setCssStyles({ bottom: "100px", left: "50%", transform: "translateX(-50%)" });
        } else if (pos === "left") {
            this.containerEl.setCssStyles({ top: "50%", left: "10px", transform: "translateY(-50%)" });
        } else if (pos === "right") {
            this.containerEl.setCssStyles({ top: "50%", right: "10px", transform: "translateY(-50%)" });
        }
    }

    hide() {
        if (this.containerEl) {
            this.containerEl.setCssStyles({ display: "none" });
        }
    }
}
