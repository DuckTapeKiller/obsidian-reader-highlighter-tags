import { Modal, Setting, Notice } from "obsidian";

export class FailureRecoveryModal extends Modal {
    constructor(app, report, onSubmit) {
        super(app);
        this.report = report;
        this.onSubmit = onSubmit;
        this.correction = "";
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        
        contentEl.createEl("h2", { text: "Highlight failure" });

        if (this.report.type === "PHANTOM") {
            // ... (keep PHANTOM logic same)
            contentEl.createEl("p", { 
                text: "Text not found in the current file.",
                cls: "recovery-error-msg" 
            });
            contentEl.createEl("p", { 
                text: "This text appears to come from an embedded note. Open the source note directly and highlight it there.",
                cls: "recovery-hint-msg"
            });
            
            new Setting(contentEl)
                .addButton(btn => btn
                    .setButtonText("Close")
                    .onClick(() => this.close()));
            return;
        }

        // Standard Recovery Flow
        contentEl.createEl("p", { 
            text: "The plugin was unable to highlight this section. Please review the suggestion.",
            cls: "recovery-desc" 
        });

        contentEl.createEl("strong", { 
            text: "Highlight suggestion",
            cls: "recovery-instruction"
        });

        const previewContainer = contentEl.createDiv({ cls: "recovery-rule-preview", text: "" });

        this.correction = this.report.bestGuessContext ? `==${this.report.bestGuessContext}==` : "";

        new Setting(contentEl)
            .setClass("recovery-input-setting")
            .addTextArea(text => {
                text.setPlaceholder("Wrap text in ==highlight syntax==...")
                    .setValue(this.correction)
                    .onChange(value => {
                        this.correction = value;
                        this.updatePreview(previewContainer);
                    });
                
                // Auto-focus the field so user can paste/edit immediately
                setTimeout(() => text.inputEl.focus(), 10);
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText("Cancel")
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText("Apply Once")
                .onClick(() => {
                    if (!this.correction.trim()) {
                        new Notice("Please provide the corrected text.");
                        return;
                    }
                    let finalTarget = this.correction;
                    const markerMatch = this.correction.match(/==([\s\S]*?)==/);
                    if (markerMatch) {
                        finalTarget = markerMatch[1].trim();
                    }
                    this.onSubmit(finalTarget, null);
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText("Apply & Learn")
                .setCta()
                .onClick(() => {
                    if (!this.correction.trim()) {
                        new Notice("Please provide the corrected text.");
                        return;
                    }
                    
                    let finalTarget = this.correction;

                    // Manual Marker Recognition: Extract text between the first pair of ==
                    const markerMatch = this.correction.match(/==([\s\S]*?)==/);
                    if (markerMatch) {
                        finalTarget = markerMatch[1].trim();
                    }

                    const rule = this.deriveRule(this.report.rawSnippet, finalTarget);
                    // Pass the target even if rule.error exists (non-blocking)
                    this.onSubmit(finalTarget, rule.error ? null : rule);
                    this.close();
                }));
    }

    updatePreview(container) {
        if (!this.correction || this.correction.length < 10) {
            container.setText("");
            return;
        }
        const rule = this.deriveRule(this.report.rawSnippet, this.correction);
        if (rule.error) {
            container.setText(`📝 Note: Highlight will apply, but no rule learned (Reason: ${rule.error})`);
            container.style.color = "var(--text-muted)";
        } else {
            container.setText(`✨ Diagnostic: Will learn to ignore "${rule.stripPattern}"`);
            container.style.color = "var(--text-success)";
        }
    }

    deriveRule(rawSnippet, corrected) {
        // Find longest common prefix
        let prefixLen = 0;
        const a = rawSnippet, b = corrected;
        while (prefixLen < a.length && prefixLen < b.length && 
               a[prefixLen] === b[prefixLen]) prefixLen++;

        // Find longest common suffix
        let suffixLen = 0;
        while (suffixLen < a.length - prefixLen &&
               suffixLen < b.length - prefixLen &&
               a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]) suffixLen++;

        // The "junk" is whatever is in raw but absent in the differing middle
        const rawMiddle = a.substring(prefixLen, a.length - suffixLen);
        const correctedMiddle = b.substring(prefixLen, b.length - suffixLen);

        if (!rawMiddle && !correctedMiddle) return { error: "identical" };
        if (!rawMiddle) return { error: "corrected is longer than raw" };

        // Only learn if the junk is purely non-alphabetic
        if (/\p{L}/u.test(rawMiddle)) return { error: "contains letters without symbols" };
        if (rawMiddle.length < 2) return { error: "too minor" };
        if (correctedMiddle.length > 0) return { error: "substitution, not deletion" };

        return { stripPattern: rawMiddle };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
