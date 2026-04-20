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

        // Auto-scan on open so all highlights display by default
        this.startScan();
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

        // Collect all highlights with file reference
        let allHighlights = [];
        for (const res of this.scanResults) {
            for (const h of res.highlights) {
                allHighlights.push({ ...h, file: res.file });
            }
        }

        const totalHighlights = allHighlights.length;

        // Apply search filter
        if (this.searchQuery) {
            allHighlights = allHighlights.filter(h =>
                h.text.toLowerCase().includes(this.searchQuery)
            );
        }

        // Stats summary
        const statsRow = this.contentEl.createDiv({ cls: "research-stats" });

        if (this.searchQuery) {
            // Group filtered results by file for the detailed view
            const fileMap = new Map();
            for (const h of allHighlights) {
                if (!fileMap.has(h.file.path)) {
                    fileMap.set(h.file.path, { file: h.file, highlights: [] });
                }
                fileMap.get(h.file.path).highlights.push(h);
            }
            const filteredGroups = [...fileMap.values()];
            const fileCount = filteredGroups.length;

            statsRow.textContent = `Found ${allHighlights.length} highlights in ${fileCount} files (filtered from ${totalHighlights}).`;

            // Render grouped/expanded view when searching
            for (const group of filteredGroups) {
                const groupEl = this.contentEl.createDiv({ cls: "research-group" });

                const headerEl = groupEl.createDiv({ cls: "research-group-header" });
                
                const expandIcon = headerEl.createSpan({ cls: "research-expand-icon" });
                expandIcon.innerHTML = "▼";
                
                headerEl.createSpan({ cls: "research-group-title", text: group.file.basename });
                headerEl.createSpan({ cls: "research-group-badge", text: `${group.highlights.length}` });

                const listEl = groupEl.createDiv({ cls: "research-highlight-list" });
                
                group.highlights.forEach((h) => {
                    const itemEl = listEl.createDiv({ cls: "research-highlight-item" });
                    
                    if (h.color) {
                        const dot = itemEl.createSpan({ cls: "research-color-dot" });
                        dot.style.backgroundColor = h.color;
                    }

                    itemEl.createSpan({ cls: "research-item-text", text: h.text });
                    
                    itemEl.onclick = (e) => {
                        e.stopPropagation();
                        this.jumpToHighlight(group.file, h.line);
                    };
                });
            }
        } else {
            // Default: simplified flat list of all highlights
            const totalFileCount = this.scanResults.length;
            statsRow.textContent = `${totalHighlights} highlights across ${totalFileCount} files.`;

            const listEl = this.contentEl.createDiv({ cls: "research-highlight-list research-flat-list" });

            for (const h of allHighlights) {
                const itemEl = listEl.createDiv({ cls: "research-highlight-item" });

                // Color dot
                if (h.color) {
                    const dot = itemEl.createSpan({ cls: "research-color-dot" });
                    dot.style.backgroundColor = h.color;
                }

                // Highlight text (truncated for readability)
                const displayText = h.text.length > 120
                    ? h.text.substring(0, 120) + "..."
                    : h.text;
                itemEl.createSpan({ cls: "research-item-text", text: displayText });

                // Source file badge
                itemEl.createSpan({ cls: "research-source-badge", text: h.file.basename });

                // Click to jump
                itemEl.onclick = (e) => {
                    e.stopPropagation();
                    this.jumpToHighlight(h.file, h.line);
                };
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
