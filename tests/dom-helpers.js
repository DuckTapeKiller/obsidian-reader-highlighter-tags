// A jsdom window carrying the DOM surface Obsidian gives plugins, so UI code
// can be exercised in Node exactly as written.

import { JSDOM } from "jsdom";

/**
 * jsdom has no innerText. Reading view runs in Chromium, where innerText turns
 * <br> and block boundaries into newlines — and the plugin's context text is
 * derived from innerText, so the difference is load-bearing.
 */
export function polyfillInnerText(window) {
    const { Element, Node } = window;
    if (Object.getOwnPropertyDescriptor(Element.prototype, "innerText")) return;
    const BLOCKS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"]);
    Object.defineProperty(Element.prototype, "innerText", {
        get() {
            let out = "";
            const walk = (node) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    out += node.nodeValue || "";
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                const tag = node.tagName.toUpperCase();
                if (tag === "BR") {
                    out += "\n";
                    return;
                }
                const isBlock = BLOCKS.has(tag);
                if (isBlock && out && !out.endsWith("\n")) out += "\n";
                for (const child of node.childNodes) walk(child);
                if (isBlock && out && !out.endsWith("\n")) out += "\n";
            };
            for (const child of this.childNodes) walk(child);
            return out;
        },
        configurable: true,
    });
}

/**
 * Obsidian augments HTMLElement with helpers (addClass, setCssStyles, createDiv,
 * …) that jsdom does not have. Plugin UI code calls them directly, so the
 * harness must provide them to exercise that code at all.
 */
export function polyfillObsidianDom(window) {
    const { Element, HTMLElement } = window;
    if (Element.prototype.addClass) return;
    Element.prototype.addClass = function (...cls) {
        this.classList.add(...cls.filter(Boolean));
        return this;
    };
    Element.prototype.removeClass = function (...cls) {
        this.classList.remove(...cls.filter(Boolean));
        return this;
    };
    Element.prototype.toggleClass = function (cls, on) {
        this.classList.toggle(cls, on);
        return this;
    };
    Element.prototype.hasClass = function (cls) {
        return this.classList.contains(cls);
    };
    Element.prototype.setText = function (text) {
        this.textContent = text;
        return this;
    };
    Element.prototype.empty = function () {
        while (this.firstChild) this.removeChild(this.firstChild);
        return this;
    };
    Element.prototype.detach = function () {
        this.remove();
        return this;
    };
    HTMLElement.prototype.setCssStyles = function (styles) {
        for (const [key, value] of Object.entries(styles || {})) this.style[key] = value;
        return this;
    };
    const createEl = function (tag, opts = {}) {
        const el = this.ownerDocument.createElement(tag);
        if (opts.cls) el.classList.add(...String(opts.cls).split(/\s+/).filter(Boolean));
        if (opts.text) el.textContent = opts.text;
        if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
        this.appendChild(el);
        return el;
    };
    Element.prototype.createEl = createEl;
    Element.prototype.createDiv = function (opts) {
        return createEl.call(this, "div", opts);
    };
    Element.prototype.createSpan = function (opts) {
        return createEl.call(this, "span", opts);
    };
}

export function createObsidianWindow(html = "<!doctype html><html><body><div id='content'></div></body></html>") {
    const dom = new JSDOM(html, { pretendToBeVisual: true });
    polyfillInnerText(dom.window);
    polyfillObsidianDom(dom.window);
    const { window } = dom;
    globalThis.window = window;
    globalThis.activeWindow = window;
    globalThis.activeDocument = window.document;
    globalThis.Node = window.Node;
    globalThis.NodeFilter = window.NodeFilter;
    return window;
}
