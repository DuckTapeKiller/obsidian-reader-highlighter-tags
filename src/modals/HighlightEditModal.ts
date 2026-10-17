import { Modal, Setting, Notice, TFile } from "obsidian";
import type ReadingHighlighterPlugin from "../main";
import { TagSuggestModal } from "./TagSuggestModal";
import {
    parseHighlights,
    findHighlightById,
    removeHighlightFromRaw,
    updateHighlightAnnotationInRaw,
    updateHighlightColorInRaw,
    updateHighlightTagsInRaw,
} from "../utils/highlights";
import { COLOR_LABELS, HIGHLIGHT_COLORS, isHighlightColor, type HighlightColor } from "../utils/colors";

interface EditState {
    color: HighlightColor | null;
    tags: string;
    annotation: string;
}

export class HighlightEditModal extends Modal {
    plugin: ReadingHighlighterPlugin;
    file: TFile;
    highlightId: string;
    onApplied: (raw: string) => void;
    state: EditState;
    tagsInput!: HTMLInputElement;
    annotationInput!: HTMLTextAreaElement;

    constructor(
        plugin: ReadingHighlighterPlugin,
        file: TFile,
        highlightId: string,
        onApplied: (raw: string) => void = () => {}
    ) {
        super(plugin.app);
        this.plugin = plugin;
        this.file = file;
        this.highlightId = highlightId;
        this.onApplied = onApplied;

        this.state = {
            color: null,
            tags: "",
            annotation: "",
        };
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();

        contentEl.addClass("reading-highlighter-highlight-edit-modal");
        modalEl.addClass("reading-highlighter-highlight-edit-modal");

        contentEl.createEl("h2", { text: "Edit highlight" });

        let raw: string;
        try {
            raw = await this.app.vault.read(this.file);
        } catch (err) {
            console.error(err);
            contentEl.createDiv({ cls: "highlight-edit-error", text: "Could not read file." });
            return;
        }

        const parsed = parseHighlights(raw);
        const highlight = findHighlightById(parsed, this.highlightId);
        if (!highlight) {
            contentEl.createDiv({ cls: "highlight-edit-error", text: "Highlight not found (it may have moved)." });
            return;
        }

        this.state.color = highlight.color;
        this.state.tags = highlight.tagsText || "";
        this.state.annotation = highlight.annotation || "";

        const preview = contentEl.createDiv({ cls: "highlight-edit-preview" });
        preview.createDiv({ cls: "highlight-edit-preview-label", text: "Preview" });
        preview.createDiv({ cls: "highlight-edit-preview-text", text: highlight.text || "" });

        const meaningOf = (color: HighlightColor) =>
            this.plugin.settings.semanticColors.find((item) => item.color === color)?.meaning?.trim() ?? "";
        new Setting(contentEl)
            .setName("Colour")
            .setDesc(
                highlight.type === "html"
                    ? "This is an HTML highlight from an older version. Applying turns it into a native highlight."
                    : "Written as an Obsidian highlight colour, e.g. ==🟡text==."
            )
            .addDropdown((drop) => {
                drop.addOption("", "Theme default");
                for (const color of HIGHLIGHT_COLORS) {
                    const meaning = meaningOf(color);
                    drop.addOption(color, meaning ? `${COLOR_LABELS[color]} — ${meaning}` : COLOR_LABELS[color]);
                }
                drop.setValue(this.state.color ?? "");
                drop.onChange((value) => {
                    this.state.color = isHighlightColor(value) ? value : null;
                });
            });

        const tagsSetting = new Setting(contentEl)
            .setName("Tags")
            .setDesc("Tags applied immediately before the highlight.");
        this.tagsInput = tagsSetting.controlEl.createEl("input", {
            type: "text",
            cls: "highlight-edit-tags-input",
        });
        this.tagsInput.value = this.state.tags;
        this.tagsInput.oninput = (e) => {
            this.state.tags = (e.target as HTMLInputElement).value;
        };
        tagsSetting.addButton((btn) =>
            btn.setButtonText("Pick").onClick(() => {
                new TagSuggestModal(this.plugin, (tagText) => {
                    this.state.tags = tagText;
                    this.tagsInput.value = tagText;
                }).open();
            })
        );

        const annotationSetting = new Setting(contentEl)
            .setName("Annotation")
            .setDesc("Stored as a standard footnote definition in the note.");

        this.annotationInput = annotationSetting.controlEl.createEl("textarea", {
            cls: "highlight-edit-annotation-input",
        });
        this.annotationInput.rows = 3;
        this.annotationInput.value = this.state.annotation;
        this.annotationInput.oninput = (e) => {
            this.state.annotation = (e.target as HTMLTextAreaElement).value;
        };

        const footer = contentEl.createDiv({ cls: "modal-footer highlight-edit-footer" });

        const cancelBtn = footer.createEl("button", { text: "Cancel" });
        cancelBtn.onclick = () => this.close();

        const removeBtn = footer.createEl("button", { text: "Remove highlight" });
        removeBtn.onclick = () => void this.applyEdits({ remove: true });

        const applyBtn = footer.createEl("button", { text: "Apply", cls: "mod-cta" });
        applyBtn.onclick = () => void this.applyEdits({ remove: false });
    }

    async applyEdits({ remove }: { remove: boolean }) {
        try {
            await this.plugin.saveUndoState(this.file);

            const finalRaw = await this.app.vault.process(this.file, (data) => {
                let raw = data;
                const parsed = parseHighlights(raw);
                const highlight = findHighlightById(parsed, this.highlightId);
                if (!highlight) {
                    throw new Error("Highlight not found (it may have moved).");
                }

                if (remove) {
                    raw = removeHighlightFromRaw(raw, highlight);
                    return raw;
                }

                raw = updateHighlightTagsInRaw(raw, highlight, this.state.tags);

                // Re-parse after potential length changes
                let updatedParsed = parseHighlights(raw);
                let updatedHighlight = findHighlightById(updatedParsed, this.highlightId);
                if (!updatedHighlight) {
                    throw new Error("Highlight not found after tag update.");
                }

                // Only rewrite the markers when something changes, so a plain
                // edit of tags or annotation leaves the highlight byte for byte.
                if (updatedHighlight.type === "html" || updatedHighlight.color !== this.state.color) {
                    raw = updateHighlightColorInRaw(raw, updatedHighlight, this.state.color);
                }

                updatedParsed = parseHighlights(raw);
                updatedHighlight = findHighlightById(updatedParsed, this.highlightId);
                if (!updatedHighlight) {
                    throw new Error("Highlight not found after style update.");
                }

                raw = updateHighlightAnnotationInRaw(raw, updatedHighlight, this.state.annotation);
                return raw;
            });

            await this.plugin.recordUndoResult(this.file, finalRaw);
            this.onApplied(finalRaw);
            this.close();
            new Notice(remove ? "Highlight removed." : "Highlight updated.");
        } catch (err) {
            console.error(err);
            new Notice(err instanceof Error ? err.message : "Failed to update highlight.");
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
