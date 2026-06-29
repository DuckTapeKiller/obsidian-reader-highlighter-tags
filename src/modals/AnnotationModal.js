import { Modal, TextAreaComponent } from "obsidian";

/**
 * Modal for adding annotations/comments to highlighted text.
 * Comments are added as footnotes at the bottom of the activeDocument.
 */
export class AnnotationModal extends Modal {
    constructor(app, onSubmit) {
        super(app);
        this.onSubmit = onSubmit;
        this.comment = "";
    }

    onOpen() {
        const { contentEl } = this;
        this.modalEl.addClass("reading-highlighter-annotation-modal");

        // Add class to container to manage animations
        const modalContainer = this.containerEl ?? this.modalEl?.closest?.(".modal-container");
        if (modalContainer) {
            modalContainer.classList.add("reading-highlighter-modal-container");
        }

        contentEl.createEl("h2", { text: "Add Annotation" });

        contentEl.createEl("p", {
            text: "Your comment will be added as a footnote at the bottom of the activeDocument.",
            cls: "annotation-description",
        });

        const textArea = new TextAreaComponent(contentEl);
        textArea.inputEl.addClass("annotation-textarea");
        textArea.setPlaceholder("Enter your annotation...");
        textArea.onChange((value) => {
            this.comment = value;
        });

        // Focus the textarea
        window.setTimeout(() => textArea.inputEl.focus(), 50);

        // Handle Enter to submit (Shift+Enter for newline)
        textArea.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                this.submit();
            }
        });

        // Footer with buttons
        const footer = contentEl.createDiv({ cls: "modal-footer" });

        const cancelBtn = footer.createEl("button", { text: "Cancel" });
        cancelBtn.onclick = () => this.close();

        const submitBtn = footer.createEl("button", { text: "Add Annotation", cls: "mod-cta" });
        submitBtn.onclick = () => this.submit();
    }

    submit() {
        if (this.comment.trim()) {
            this.onSubmit(this.comment.trim());
        }
        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
