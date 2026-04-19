import { ItemView, MarkdownView } from "obsidian";
import { VaultScanner } from "../core/VaultScanner";

export const RESEARCH_VIEW = "reader-research-view";

export class ResearchView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.scanner = new VaultScanner(plugin.app);
        
        this.scanResults = [];
        this.searchQuery = "";
        this.isScanning = false;
        this.expandedFiles = new Set(); // store file.path of expanded files
        
        this.progressEl = null;
        this.progressTextEl = null;
    }

    getViewType() {
        return RESEARCH_VIEW;
    }

    getDisplayText() {
        return "Global Research View";
    }

    getIcon() {
        return "search";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass("research-view-container");

        // Header
        const header = container.createDiv({ cls: "research-view-header" });
        
        const titleRow = header.createDiv({ cls: "research-view-title-row" });
        titleRow.createEl("h3", { text: "Research View" });
        
        const scanBtn = titleRow.createEl("button", { text: "Scan Vault", cls: "mod-cta" });
        scanBtn.onclick = () => this.startScan();

        // Search Bar
        const searchContainer = header.createDiv({ cls: "research-view-search" });
        const searchInput = searchContainer.createEl("input", { 
            type: "text", 
            placeholder: "Search all highlights...",
            cls: "research-search-input"
        });
        
        searchInput.oninput = (e) => {
            this.searchQuery = e.target.value.toLowerCase();
            this.renderContent();
        };

        // Progress bar container (hidden by default)
        this.progressContainer = header.createDiv({ cls: "research-progress-container", attr: { style: "display: none;" } });
        this.progressTextEl = this.progressContainer.createDiv({ cls: "research-progress-text" });
        const progressTrack = this.progressContainer.createDiv({ cls: "research-progress-track" });
        this.progressEl = progressTrack.createDiv({ cls: "research-progress-bar" });

        // Content Area
        this.contentEl = container.createDiv({ cls: "research-view-content" });

        // Initial render
        this.renderContent();
    }

    async startScan() {
        if (this.isScanning) return;
        
        this.isScanning = true;
        this.progressContainer.style.display = "block";
        this.contentEl.empty();
        
        try {
            this.scanResults = await this.scanner.scanVault((current, total, lastFile) => {
                const percent = Math.round((current / total) * 100);
                this.progressEl.style.width = `${percent}%`;
                this.progressTextEl.textContent = `Scanning: ${current}/${total} (${percent}%) - ${lastFile}...`;
            });
            
            // Expand first file automatically if any
            if (this.scanResults.length > 0) {
                this.expandedFiles.add(this.scanResults[0].file.path);
            }
        } catch (err) {
            console.error(err);
            this.contentEl.createDiv({ text: "Error during scan: " + err.message, cls: "research-error" });
        } finally {
            this.isScanning = false;
            this.progressContainer.style.display = "none";
            this.renderContent();
        }
    }

    renderContent() {
        if (this.isScanning) return;
        
        this.contentEl.empty();

        if (this.scanResults.length === 0) {
            this.contentEl.createDiv({ 
                cls: "research-empty", 
                text: "No highlights found. Click 'Scan Vault' to analyze." 
            });
            return;
        }

        // Apply global search filter
        const filteredResults = [];
        let totalHighlights = 0;
        let totalFiltered = 0;

        for (const res of this.scanResults) {
            const matches = res.highlights.filter(h => {
                if (!this.searchQuery) return true;
                return h.text.toLowerCase().includes(this.searchQuery);
            });
            
            totalHighlights += res.highlights.length;
            totalFiltered += matches.length;

            if (matches.length > 0) {
                filteredResults.push({ file: res.file, highlights: matches, totalInFile: res.highlights.length });
            }
        }

        // Stats summary
        const statsRow = this.contentEl.createDiv({ cls: "research-stats" });
        const fileCount = filteredResults.length;
        const totalFileCount = this.scanResults.length;
        
        if (this.searchQuery) {
            statsRow.textContent = `Found ${totalFiltered} highlights in ${fileCount} files (filtered from ${totalHighlights}).`;
        } else {
            statsRow.textContent = `Found ${totalHighlights} total highlights across ${totalFileCount} files.`;
        }

        // Render groups
        for (const group of filteredResults) {
            const groupEl = this.contentEl.createDiv({ cls: "research-group" });
            const isExpanded = this.expandedFiles.has(group.file.path) || this.searchQuery.length > 0;

            const headerEl = groupEl.createDiv({ cls: "research-group-header" });
            
            const expandIcon = headerEl.createSpan({ cls: "research-expand-icon" });
            expandIcon.innerHTML = isExpanded ? "▼" : "▶";
            
            const titleEl = headerEl.createSpan({ cls: "research-group-title", text: group.file.basename });
            const badgeEl = headerEl.createSpan({ cls: "research-group-badge", text: `${group.highlights.length}` });

            headerEl.onclick = () => {
                if (this.expandedFiles.has(group.file.path)) {
                    this.expandedFiles.delete(group.file.path);
                } else {
                    this.expandedFiles.add(group.file.path);
                }
                this.renderContent(); // Lazy re-render is fine for this
            };

            if (isExpanded) {
                const listEl = groupEl.createDiv({ cls: "research-highlight-list" });
                
                group.highlights.forEach((h, idx) => {
                    const itemEl = listEl.createDiv({ cls: "research-highlight-item" });
                    
                    if (h.type === "markdown") {
                        const dot = itemEl.createSpan({ cls: "research-color-dot" });
                        if (h.color) {
                            dot.style.backgroundColor = h.color;
                        }
                    }

                    const textEl = itemEl.createSpan({ cls: "research-item-text", text: h.text });
                    
                    itemEl.onclick = (e) => {
                        e.stopPropagation();
                        this.jumpToHighlight(group.file, h.line);
                    };
                });
            }
        }
    }

    async jumpToHighlight(file, line) {
        // Open file in new leaf/tab OR current active
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.openFile(file);
        
        if (leaf.view instanceof MarkdownView) {
            leaf.setEphemeralState({ 
                line: line, 
                focus: true 
            });
        }
    }
}
