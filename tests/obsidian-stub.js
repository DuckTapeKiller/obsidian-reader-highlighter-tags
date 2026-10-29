// Runtime stub for the `obsidian` module, which ships types only. Enough
// surface for plugin classes to be constructed and their methods called from
// Node, so UI and selection code can be tested as written.

export class Events {
    on() {}
    off() {}
    trigger() {}
}
export class Component extends Events {
    load() {}
    unload() {}
    addChild(c) {
        return c;
    }
    registerDomEvent(el, type, handler, options) {
        el.addEventListener(type, handler, options);
        return handler;
    }
    registerEvent() {}
    registerInterval() {}
}
export class Plugin extends Component {
    constructor(app, manifest) {
        super();
        this.app = app;
        this.manifest = manifest;
    }
    addCommand() {}
    addRibbonIcon() {
        return { addClass() {} };
    }
    addSettingTab() {}
    registerView() {}
    registerMarkdownPostProcessor() {}
    async loadData() {
        return {};
    }
    async saveData() {}
}
export class View extends Component {}
export class AbstractInputSuggest {
    constructor(app, inputEl) {
        this.app = app;
        this.inputEl = inputEl;
    }
    setValue(value) {
        this.inputEl.value = value;
    }
    getValue() {
        return this.inputEl.value;
    }
    open() {}
    close() {}
    onSelect() {
        return this;
    }
}
export class ItemView extends View {}
export class MarkdownView extends View {}
export class Modal extends Component {}
export class PluginSettingTab extends Component {}
export class Setting {
    setName() {
        return this;
    }
    setDesc() {
        return this;
    }
    addText() {
        return this;
    }
    addToggle() {
        return this;
    }
    addButton() {
        return this;
    }
    addDropdown() {
        return this;
    }
}
export class TextAreaComponent {}
export class WorkspaceLeaf {}
export class TFile {
    constructor(path = "note.md") {
        this.path = path;
        this.basename = path.replace(/\.md$/, "");
        this.extension = "md";
    }
}
export class Notice {
    constructor(message, duration) {
        Notice.messages.push(typeof message === "string" ? message : message.textContent);
        this.message = message;
        this.duration = duration;
        this.hidden = false;
        Notice.instances.push(this);
    }
    hide() {
        this.hidden = true;
    }
}
Notice.messages = [];
Notice.instances = [];

export const Platform = { isMobile: false, isPhone: false, isDesktop: true, isIosApp: false };
export function normalizePath(path) {
    return String(path)
        .replace(/[\\/]+/g, "/")
        .replace(/^\/|\/$/g, "");
}
export function setIcon() {}
export async function loadPdfJs() {
    return {};
}
