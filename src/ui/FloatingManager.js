import { setIcon, MarkdownView } from "obsidian";

export class FloatingManager {
    constructor(plugin) {
        this.plugin = plugin;
        this.app = plugin.app;
        this.containerEl = null;
        this.highlightBtn = null;
        this.tagBtn = null;
        this.removeBtn = null;
        this._handlers = [];
    }

    load() {
        this.createElements();
        this.registerEvents();
    }

    unload() {
        this.containerEl?.remove();
        this.containerEl = null; // Detach ref
        this._handlers.forEach(cleanup => cleanup());
        this._handlers = [];
    }

    createElements() {
        if (this.containerEl) return;

        this.containerEl = document.createElement("div");
        this.containerEl.addClass("reading-highlighter-float-container");

        this.highlightBtn = this.createButton("highlighter", "Subrayar selección");
        this.tagBtn = this.createButton("tag", "Etiquetar selección"); // New Button
        this.removeBtn = this.createButton("minus", "Eliminar subrayado");
        this.removeBtn.addClass("reading-highlighter-remove-btn");

        this.containerEl.appendChild(this.highlightBtn);
        this.containerEl.appendChild(this.tagBtn);
        this.containerEl.appendChild(this.removeBtn);

        document.body.appendChild(this.containerEl);
    }

    createButton(iconName, label) {
        const btn = document.createElement("button");
        setIcon(btn, iconName);
        btn.setAttribute("aria-label", label);
        btn.addClass("reading-highlighter-btn");
        return btn;
    }

    registerEvents() {
        const preventFocus = (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
        };

        const attachAction = (btn, actionInfo) => {
            const handler = (evt) => {
                preventFocus(evt);
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && view.getMode() === "preview") {
                    this.plugin[actionInfo](view);
                }
                this.hide();
            };

            btn.addEventListener("mousedown", handler);
            btn.addEventListener("touchstart", handler, { passive: false });
        };

        if (this.highlightBtn) attachAction(this.highlightBtn, "highlightSelection");
        if (this.tagBtn) attachAction(this.tagBtn, "tagSelection"); // New Handler
        if (this.removeBtn) attachAction(this.removeBtn, "removeHighlightSelection");
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

        const containerHeight = 40;
        const containerWidth = 140; // Increased width for 3 buttons

        let top = rect.top - containerHeight - 10;
        let left = rect.left + (rect.width / 2) - (containerWidth / 2);

        if (top < 10) top = rect.bottom + 10;
        if (left < 10) left = 10;
        if (left + containerWidth > window.innerWidth - 10) left = window.innerWidth - containerWidth - 10;

        this.containerEl.style.top = `${top}px`;
        this.containerEl.style.left = `${left}px`;
    }

    hide() {
        if (this.containerEl) {
            this.containerEl.style.display = "none";
        }
    }
}
