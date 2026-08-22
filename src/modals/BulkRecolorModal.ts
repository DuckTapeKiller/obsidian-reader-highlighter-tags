import { Modal, Setting, TFile } from "obsidian";
import type ReadingHighlighterPlugin from "../main";

interface BulkRecolorState {
    limitFrom: boolean;
    fromColor: string;
    toColor: string;
}

export class BulkRecolorModal extends Modal {
    plugin: ReadingHighlighterPlugin;
    file: TFile;
    onApplied: () => void;
    state: BulkRecolorState;
    fromSetting?: Setting;
    toSetting?: Setting;
    fromColorInput?: HTMLInputElement;
    toColorInput?: HTMLInputElement;

    constructor(plugin: ReadingHighlighterPlugin, file: TFile, onApplied: () => void = () => {}) {
        super(plugin.app);
        this.plugin = plugin;
        this.file = file;
        this.onApplied = onApplied;

        this.state = {
            limitFrom: false,
            fromColor: "#ffff00",
            toColor: "#ffff00",
        };
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();

        modalEl.addClass("reading-highlighter-bulk-recolor-modal");
        contentEl.addClass("reading-highlighter-bulk-recolor-modal");

        contentEl.createEl("h2", { text: "Recolor <mark> highlights" });

        contentEl.createDiv({
            cls: "setting-item-description",
            text: "This only affects colored highlights stored as <mark>…</mark> (not == == highlights).",
        });

        new Setting(contentEl)
            .setName("Limit by existing color")
            .setDesc("Optional: only recolor highlights that currently have this exact color.")
            .addToggle((toggle) => {
                toggle.setValue(this.state.limitFrom);
                toggle.onChange((value) => {
                    this.state.limitFrom = value;
                    this.updateEnabledState();
                });
            });

        this.fromSetting = new Setting(contentEl)
            .setName("From color")
            .setDesc("Only used when the limit toggle is enabled.")
            .addText((text) => {
                text.setPlaceholder("Hex color like #ff0000");
                text.setValue(this.state.fromColor);
                text.onChange((value) => {
                    this.state.fromColor = (value || "").trim();
                    if (this.fromColorInput && /^#[0-9a-fA-F]{6}$/.test(this.state.fromColor)) {
                        this.fromColorInput.value = this.state.fromColor;
                    }
                });
            });

        const fromControl = this.fromSetting.controlEl;
        this.fromColorInput = fromControl.createEl("input", { type: "color" });
        this.fromColorInput.value = this.state.fromColor;
        this.fromColorInput.oninput = (e) => {
            this.state.fromColor = (e.target as HTMLInputElement).value;
            const textInput = this.fromSetting?.controlEl.querySelector<HTMLInputElement>("input[type='text']");
            if (textInput) textInput.value = this.state.fromColor;
        };

        this.toSetting = new Setting(contentEl)
            .setName("To color")
            .setDesc("Target color to apply.")
            .addText((text) => {
                text.setPlaceholder("Hex color like #ff0000");
                text.setValue(this.state.toColor);
                text.onChange((value) => {
                    this.state.toColor = (value || "").trim();
                    if (this.toColorInput && /^#[0-9a-fA-F]{6}$/.test(this.state.toColor)) {
                        this.toColorInput.value = this.state.toColor;
                    }
                });
            });

        const toControl = this.toSetting.controlEl;
        this.toColorInput = toControl.createEl("input", { type: "color" });
        this.toColorInput.value = this.state.toColor;
        this.toColorInput.oninput = (e) => {
            this.state.toColor = (e.target as HTMLInputElement).value;
            const textInput = this.toSetting?.controlEl.querySelector<HTMLInputElement>("input[type='text']");
            if (textInput) textInput.value = this.state.toColor;
        };

        const footer = contentEl.createDiv({ cls: "modal-footer" });
        const cancelBtn = footer.createEl("button", { text: "Cancel" });
        cancelBtn.onclick = () => this.close();

        const applyBtn = footer.createEl("button", { text: "Apply", cls: "mod-cta" });
        applyBtn.onclick = () =>
            void (async () => {
                const from = this.state.limitFrom ? this.state.fromColor : "";
                await this.plugin.recolorMarkHighlightsInFile(this.file, from, this.state.toColor);
                this.onApplied();
                this.close();
            })();

        this.updateEnabledState();
    }

    updateEnabledState() {
        const enabled = !!this.state.limitFrom;
        const fromColor = this.fromColorInput;
        if (fromColor) fromColor.disabled = !enabled;

        // Disable the text input as well.
        if (this.fromSetting !== undefined) {
            const textInput = this.fromSetting.controlEl.querySelector<HTMLInputElement>("input[type='text']");
            if (textInput) textInput.disabled = !enabled;
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
