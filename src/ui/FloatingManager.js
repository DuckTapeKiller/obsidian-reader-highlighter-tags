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

        // Color palette (only if enabled)
        if (this.plugin.settings.enableColorPalette) {
            this.paletteContainer = document.createElement("div");
            this.paletteContainer.addClass("reading-highlighter-palette");

            this.plugin.settings.colorPalette.forEach((item, index) => {
                const colorBtn = document.createElement("button");
                colorBtn.addClass("reading-highlighter-color-btn");
                colorBtn.style.backgroundColor = item.color;
                colorBtn.setAttribute("aria-label", item.name);
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
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && view.getMode() === "preview") {
                    this.plugin[actionName](view);
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
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && view.getMode() === "preview") {
                    this.plugin.applyColorByIndex(view, index);
                }
                this.hide();
            };

            btn.addEventListener("mousedown", handler);
            btn.addEventListener("touchstart", handler, { passive: false });
        });
    }

    setupMobileGestures() {
        // Long press to highlight without showing toolbar
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

    handleSelection() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== "preview") {
            this.hide();
            return;
        }

        const sel = window.getSelection();
        const snippet = sel?.toString() ?? "";

        if (snippet.trim() && sel && !sel.isCollapsed && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            this.show(rect);
        } else {
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
            const containerWidth = this.plugin.settings.enableColorPalette ? 280 : 180;

            let top = rect.top - containerHeight - 10;
            let left = rect.left + (rect.width / 2) - (containerWidth / 2);

            if (top < 10) top = rect.bottom + 10;
            if (left < 10) left = 10;
            if (left + containerWidth > window.innerWidth - 10) left = window.innerWidth - containerWidth - 10;

            this.containerEl.style.top = `${top}px`;
            this.containerEl.style.left = `${left}px`;

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
