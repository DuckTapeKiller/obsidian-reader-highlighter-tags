import { App, Modal } from "obsidian";

export interface ConfirmOptions {
    title: string;
    message: string;
    /** Lines shown as a list under the message, such as what will be removed. */
    details?: string[];
    confirmText: string;
}

/**
 * Ask before a change that affects a whole note. Resolves true only when the
 * confirm button is pressed; closing the dialog any other way is a no.
 */
export function confirmAction(app: App, options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, options, resolve).open());
}

class ConfirmModal extends Modal {
    options: ConfirmOptions;
    resolve: (confirmed: boolean) => void;
    confirmed = false;

    constructor(app: App, options: ConfirmOptions, resolve: (confirmed: boolean) => void) {
        super(app);
        this.options = options;
        this.resolve = resolve;
    }

    onOpen() {
        const { contentEl } = this;
        this.modalEl.addClass("reading-highlighter-confirm-modal");
        contentEl.createEl("h2", { text: this.options.title });
        contentEl.createEl("p", { text: this.options.message });

        const details = this.options.details ?? [];
        if (details.length) {
            const list = contentEl.createEl("ul", { cls: "reading-highlighter-confirm-list" });
            for (const line of details) list.createEl("li", { text: line });
        }

        const footer = contentEl.createDiv({ cls: "modal-footer" });
        const cancelBtn = footer.createEl("button", { text: "Cancel" });
        cancelBtn.onclick = () => this.close();
        const confirmBtn = footer.createEl("button", { text: this.options.confirmText, cls: "mod-warning" });
        confirmBtn.onclick = () => {
            this.confirmed = true;
            this.close();
        };
    }

    onClose() {
        this.contentEl.empty();
        this.resolve(this.confirmed);
    }
}
