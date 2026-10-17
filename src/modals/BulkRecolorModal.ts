import { Modal, Setting, TFile } from "obsidian";
import type ReadingHighlighterPlugin from "../main";
import { COLOR_LABELS, HIGHLIGHT_COLORS, isHighlightColor, type HighlightColor } from "../utils/colors";
import type { RecolorSource } from "../utils/highlights";

interface BulkRecolorState {
    from: RecolorSource;
    to: HighlightColor | null;
}

/** Recolour a note's highlights at once, in Obsidian's native colours. */
export class BulkRecolorModal extends Modal {
    plugin: ReadingHighlighterPlugin;
    file: TFile;
    onApplied: () => void;
    state: BulkRecolorState;

    constructor(plugin: ReadingHighlighterPlugin, file: TFile, onApplied: () => void = () => {}) {
        super(plugin.app);
        this.plugin = plugin;
        this.file = file;
        this.onApplied = onApplied;
        this.state = { from: "any", to: "yellow" };
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();

        modalEl.addClass("reading-highlighter-bulk-recolor-modal");
        contentEl.addClass("reading-highlighter-bulk-recolor-modal");

        contentEl.createEl("h2", { text: "Recolour highlights" });

        contentEl.createDiv({
            cls: "setting-item-description",
            text: "Applies to every highlight in this note with the chosen colour. HTML highlights from older versions become native highlights.",
        });

        new Setting(contentEl)
            .setName("From")
            .setDesc("Which highlights to recolour.")
            .addDropdown((drop) => {
                drop.addOption("any", "Any colour");
                drop.addOption("default", "Theme default");
                for (const color of HIGHLIGHT_COLORS) drop.addOption(color, COLOR_LABELS[color]);
                drop.setValue(this.state.from);
                drop.onChange((value) => {
                    this.state.from = value === "default" || isHighlightColor(value) ? value : "any";
                });
            });

        new Setting(contentEl)
            .setName("To")
            .setDesc("The colour they get.")
            .addDropdown((drop) => {
                drop.addOption("", "Theme default");
                for (const color of HIGHLIGHT_COLORS) drop.addOption(color, COLOR_LABELS[color]);
                drop.setValue(this.state.to ?? "");
                drop.onChange((value) => {
                    this.state.to = isHighlightColor(value) ? value : null;
                });
            });

        const footer = contentEl.createDiv({ cls: "modal-footer" });
        const cancelBtn = footer.createEl("button", { text: "Cancel" });
        cancelBtn.onclick = () => this.close();

        const applyBtn = footer.createEl("button", { text: "Apply", cls: "mod-cta" });
        applyBtn.onclick = () =>
            void (async () => {
                await this.plugin.recolorHighlightsInFile(this.file, this.state.from, this.state.to);
                this.onApplied();
                this.close();
            })();
    }

    onClose() {
        this.contentEl.empty();
    }
}
