/**
 * DOM and Scroll Utilities
 */

export function getScroll(view) {
    return typeof view.previewMode?.getScroll === "function"
        ? view.previewMode.getScroll()
        : getFallbackScroll(view);
}

export function applyScroll(view, pos) {
    if (typeof view.previewMode?.applyScroll === "function") {
        view.previewMode.applyScroll(pos);
    } else {
        setFallbackScroll(view, pos);
    }
}

function getFallbackScroll(view) {
    const el =
        view.containerEl.querySelector(".markdown-reading-view") ??
        view.containerEl.querySelector(".markdown-preview-view");
    return { x: 0, y: el?.scrollTop ?? 0 };
}

function setFallbackScroll(view, { y }) {
    const el =
        view.containerEl.querySelector(".markdown-reading-view") ??
        view.containerEl.querySelector(".markdown-preview-view");
    if (el) el.scrollTop = y;
}
