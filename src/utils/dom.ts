/**
 * DOM and Scroll Utilities
 */
import { MarkdownView } from "obsidian";

export interface ScrollPosition {
    x: number;
    y: number;
}

// The preview's scroll helpers are not part of the public typings in a way that
// matches how this plugin uses them, so describe the shape we rely on.
interface PreviewScroll {
    getScroll?: () => ScrollPosition;
    applyScroll?: (pos: ScrollPosition) => void;
}

function getPreview(view: MarkdownView): PreviewScroll {
    return view.previewMode as PreviewScroll;
}

export function getScroll(view: MarkdownView): ScrollPosition {
    const preview = getPreview(view);
    return typeof preview?.getScroll === "function" ? preview.getScroll() : getFallbackScroll(view);
}

export function applyScroll(view: MarkdownView, pos: ScrollPosition): void {
    const preview = getPreview(view);
    if (typeof preview?.applyScroll === "function") {
        preview.applyScroll(pos);
    } else {
        setFallbackScroll(view, pos);
    }
}

function getFallbackScroll(view: MarkdownView): ScrollPosition {
    const el =
        view.containerEl.querySelector<HTMLElement>(".markdown-reading-view") ??
        view.containerEl.querySelector<HTMLElement>(".markdown-preview-view");
    return { x: 0, y: el?.scrollTop ?? 0 };
}

function setFallbackScroll(view: MarkdownView, { y }: ScrollPosition): void {
    const el =
        view.containerEl.querySelector<HTMLElement>(".markdown-reading-view") ??
        view.containerEl.querySelector<HTMLElement>(".markdown-preview-view");
    if (el) el.scrollTop = y;
}
