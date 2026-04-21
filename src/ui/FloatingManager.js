import { setIcon, MarkdownView, Platform } from "obsidian";

export class FloatingManager {
    constructor(plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.containerEl = null;
        this.highlightBtn = null;
        this.tagBtn = null;
        this.removeBtn = null;
        this.quoteBtn = null;
        this.annotateBtn = null;
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
        this._handlers.forEach(cleanup => cleanup());
        this._handlers = [];
        if (this._selectionDebounceTimer) {
            clearTimeout(this._selectionDebounceTimer);
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
    }

    createElements() {
        if (this.containerEl) return;

        this.containerEl = document.createElement("div");
        this.containerEl.addClass("reading-highlighter-float-container");

        // Main highlight button
        this.highlightBtn = this.createButton("highlighter", "Highlight selection");
        this.containerEl.appendChild(this.highlightBtn);

        // Semantic Color palette (only if enabled)
        if (this.plugin.settings.enableColorPalette) {
            this.paletteContainer = document.createElement("div");
            this.paletteContainer.addClass("reading-highlighter-palette");

            this.plugin.settings.semanticColors.forEach((item, index) => {
                const colorBtn = document.createElement("button");
                colorBtn.addClass("reading-highlighter-color-btn");
                colorBtn.style.backgroundColor = item.color;
                colorBtn.setAttribute("aria-label", item.meaning || "Color " + (index + 1));
                colorBtn.setAttribute("data-color-index", index.toString());
                this.colorButtons.push(colorBtn);
                this.paletteContainer.appendChild(colorBtn);
            });

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
            this.removeBtn = this.createButton("eraser", "Remove highlight");
            this.removeBtn.addClass("reading-highlighter-remove-btn");
            this.containerEl.appendChild(this.removeBtn);
        }

        document.body.appendChild(this.containerEl);
    }

    createButton(iconName, label) {
        const btn = document.createElement("button");
        setIcon(btn, iconName);
        // Only add tooltip if enabled in settings
        if (this.plugin.settings.showTooltips) {
            btn.setAttribute("aria-label", label);
        }
        btn.addClass("reading-highlighter-btn");
        return btn;
    }

    registerEvents() {
        const preventFocus = (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
        };

        const attachAction = (btn, actionName) => {
            if (!btn) return;

            const handler = (evt) => {
                preventFocus(evt);
                const { View } = require('obsidian');
                let view = this.app.workspace.getActiveViewOfType(MarkdownView);
                let isPdf = false;
                
                if (!view || view.getMode() !== "preview") {
                    view = this.app.workspace.getActiveViewOfType(View);
                    if (view && view.getViewType() === "pdf") {
                        isPdf = true;
                    } else {
                        this.hide();
                        return;
                    }
                }

                if (isPdf) {
                    this.plugin.savePdfHighlight(view, this._selectionSnapshot, "action", actionName);
                } else {
                    this.plugin[actionName](view, this._selectionSnapshot);
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

        // Color palette buttons
        this.colorButtons.forEach((btn, index) => {
            const handler = (evt) => {
                preventFocus(evt);
                const { View } = require('obsidian');
                let view = this.app.workspace.getActiveViewOfType(MarkdownView);
                let isPdf = false;
                
                if (!view || view.getMode() !== "preview") {
                    view = this.app.workspace.getActiveViewOfType(View);
                    if (view && view.getViewType() === "pdf") {
                        isPdf = true;
                    } else {
                        this.hide();
                        return;
                    }
                }

                if (isPdf) {
                    this.plugin.savePdfHighlight(view, this._selectionSnapshot, "color", index);
                } else {
                    this.plugin.applyColorByIndex(view, index, this._selectionSnapshot);
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

        document.addEventListener("touchstart", (e) => {
            this.longPressTimer = setTimeout(() => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                const sel = window.getSelection();

                if (view && view.getMode() === "preview" && sel?.toString().trim()) {
                    this.plugin.highlightSelection(view);
                    this.hide();
                }
            }, 600);
        }, { passive: true });

        document.addEventListener("touchmove", () => {
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
        }, { passive: true });

        document.addEventListener("touchend", () => {
            if (this.longPressTimer) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
        }, { passive: true });
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
                clearTimeout(this._selectionDebounceTimer);
            }
            this._selectionDebounceTimer = setTimeout(() => {
                this._selectionDebounceTimer = null;
                this._doHandleSelection();
            }, 300);
        } else {
            this._doHandleSelection();
        }
    }

    /** Internal: actually process the current selection state. */
    _doHandleSelection() {
        const { View } = require('obsidian');
        let view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== "preview") {
            view = this.app.workspace.getActiveViewOfType(View);
            if (!view || view.getViewType() !== "pdf") {
                this.hide();
                return;
            }
        }

        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";

        if (snippet.trim() && sel && !sel.isCollapsed && sel.rangeCount > 0) {
            // Guard: Never show toolbar inside code blocks
            let node = sel.anchorNode;
            while (node && node !== document.body) {
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

    show(rect) {
        if (!this.containerEl || !rect) return;

        this.containerEl.style.display = "flex";

        // Reset dynamic styles & classes
        this.containerEl.style.top = "";
        this.containerEl.style.bottom = "";
        this.containerEl.style.left = "";
        this.containerEl.style.right = "";
        this.containerEl.style.transform = "";
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
                let left = rect.left + (rect.width / 2) - (containerWidth / 2);

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

                this.containerEl.style.top = `${top}px`;
                this.containerEl.style.left = `${left}px`;
            } else {
                // ── iOS / Desktop: place toolbar ABOVE the selection (original) ──
                let top = rect.top - containerHeight - 10;
                let left = rect.left + (rect.width / 2) - (containerWidth / 2);

                if (top < 10) top = rect.bottom + 10;
                if (left < 10) left = 10;
                if (left + containerWidth > window.innerWidth - 10) left = window.innerWidth - containerWidth - 10;

                this.containerEl.style.top = `${top}px`;
                this.containerEl.style.left = `${left}px`;
            }

        } else if (pos === "top") {
            this.containerEl.style.top = "80px";
            this.containerEl.style.left = "50%";
            this.containerEl.style.transform = "translateX(-50%)";

        } else if (pos === "bottom") {
            this.containerEl.style.bottom = "100px";
            this.containerEl.style.left = "50%";
            this.containerEl.style.transform = "translateX(-50%)";

        } else if (pos === "left") {
            this.containerEl.style.top = "50%";
            this.containerEl.style.left = "10px";
            this.containerEl.style.transform = "translateY(-50%)";
            this.containerEl.addClass("reading-highlighter-vertical");

        } else if (pos === "right") {
            this.containerEl.style.top = "50%";
            this.containerEl.style.right = "10px";
            this.containerEl.style.transform = "translateY(-50%)";
            this.containerEl.addClass("reading-highlighter-vertical");
        }
    }

    hide() {
        if (this.containerEl) {
            this.containerEl.style.display = "none";
        }
    }
}
