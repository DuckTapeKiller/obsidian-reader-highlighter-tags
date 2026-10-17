/**
 * DOM and Scroll Utilities
 */
import { MarkdownView } from "obsidian";

export interface ScrollPosition {
    x: number;
    y: number;
}

// Reading view's scroll, as Obsidian exposes it: a single number in its own
// unit, which only means anything when handed back to `applyScroll`. It was
// once read here as an `{x, y}` object, so `y` was always undefined and
// reading progress was never saved.
export function getScroll(view: MarkdownView): ScrollPosition {
    const preview = view.previewMode;
    if (typeof preview?.getScroll === "function") {
        const scroll = preview.getScroll();
        return { x: 0, y: typeof scroll === "number" && Number.isFinite(scroll) ? scroll : 0 };
    }
    return getFallbackScroll(view);
}

export function applyScroll(view: MarkdownView, pos: ScrollPosition): void {
    const preview = view.previewMode;
    if (typeof preview?.applyScroll === "function") {
        preview.applyScroll(pos.y);
    } else {
        setFallbackScroll(view, pos);
    }
}

// The element that actually scrolls is the preview view inside the reading
// view, not the reading view itself.
function scroller(view: MarkdownView): HTMLElement | null {
    return view.containerEl.querySelector<HTMLElement>(".markdown-reading-view .markdown-preview-view");
}

function getFallbackScroll(view: MarkdownView): ScrollPosition {
    return { x: 0, y: scroller(view)?.scrollTop ?? 0 };
}

function setFallbackScroll(view: MarkdownView, { y }: ScrollPosition): void {
    const el = scroller(view);
    if (el) el.scrollTop = y;
}
