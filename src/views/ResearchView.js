import { ItemView, MarkdownView } from "obsidian";
import { VaultScanner } from "../core/VaultScanner";
import { exportHighlightsToCanvas } from "../utils/canvas";

export const RESEARCH_VIEW = "reader-research-view";

export class ResearchView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.scanner = new VaultScanner(plugin.app);
        
        this.scanResults = [];
        this.searchQuery = "";
        this.filterKey = "All Properties"; // default
        this.filterValue = "";
        this.allPropertyKeys = new Set();
        this.activeColors = new Set();
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

        const canvasBtn = titleRow.createEl("button", { text: "Export Canvas" });
        canvasBtn.onclick = () => this.exportToCanvas();

        // Search Bar & Date Filter
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

        // Property Filtering Row
        const propertyFilterRow = header.createDiv({ cls: "research-view-property-filter" });
        
        this.propertySelect = propertyFilterRow.createEl("select", { 
            cls: "research-property-select" 
        });
        this.updatePropertySelector();

        this.propertySelect.onchange = (e) => {
            this.filterKey = e.target.value;
            this.renderContent();
        };

        const propertyInput = propertyFilterRow.createEl("input", {
            type: "text",
            placeholder: "Filter by value...",
            cls: "research-property-input"
        });

        propertyInput.oninput = (e) => {
            this.filterValue = e.target.value.toLowerCase();
            this.renderContent();
        };

        // Semantic Color Filters
        if (this.plugin.settings.enableColorPalette) {
            const filterContainer = header.createDiv({ cls: "research-view-color-filters" });
            this.plugin.settings.semanticColors.forEach((colorItem) => {
                if (!colorItem.meaning) return; // Only show colors that have a meaning defined

                const chip = filterContainer.createEl("button", { 
                    cls: "research-color-chip",
                });
                
                // Dot indicator
                const dot = chip.createSpan({ cls: "research-color-dot" });
                dot.style.backgroundColor = colorItem.color;
                
                chip.createSpan({ text: colorItem.meaning });

                chip.onclick = () => {
                    const lcColor = colorItem.color.toLowerCase();
                    if (this.activeColors.has(lcColor)) {
                        this.activeColors.delete(lcColor);
                        chip.removeClass("is-active");
                    } else {
                        this.activeColors.add(lcColor);
                        chip.addClass("is-active");
                    }
                    this.renderContent();
                };
            });
        }

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
            
            // Collect all property keys
            this.allPropertyKeys.clear();
            this.allPropertyKeys.add("All Properties");
            for (const res of this.scanResults) {
                if (res.frontmatter) {
                    Object.keys(res.frontmatter).forEach(key => this.allPropertyKeys.add(key));
                }
            }
            this.updatePropertySelector();

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

    updatePropertySelector() {
        if (!this.propertySelect) return;
        const currentVal = this.filterKey;
        this.propertySelect.empty();
        
        const sortedKeys = Array.from(this.allPropertyKeys).sort((a, b) => {
            if (a === "All Properties") return -1;
            if (b === "All Properties") return 1;
            return a.localeCompare(b);
        });

        sortedKeys.forEach(key => {
            const opt = this.propertySelect.createEl("option", { text: key, value: key });
            if (key === currentVal) opt.selected = true;
        });
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
                allHighlights.push({ ...h, file: res.file, frontmatter: res.frontmatter });
            }
        }

        const totalHighlights = allHighlights.length;

        // Apply property filter
        if (this.filterKey && this.filterKey !== "All Properties" && this.filterValue) {
            const filterVal = this.filterValue.toLowerCase().replace(/^#/, "");
            allHighlights = allHighlights.filter(h => {
                const val = h.frontmatter?.[this.filterKey];
                if (val === undefined || val === null) return false;

                // Handle Tags specifically
                if (this.filterKey === "tags" || this.filterKey === "tag") {
                    if (Array.isArray(val)) {
                        return val.some(t => String(t).toLowerCase().replace(/^#/, "").includes(filterVal));
                    }
                    return String(val).toLowerCase().replace(/^#/, "").includes(filterVal);
                }

                // Handle Arrays
                if (Array.isArray(val)) {
                    return val.some(v => String(v).toLowerCase().includes(filterVal));
                }

                // Default string match
                return String(val).toLowerCase().includes(filterVal);
            });
        }

        // Apply search filter
        if (this.searchQuery) {
            allHighlights = allHighlights.filter(h =>
                h.text.toLowerCase().includes(this.searchQuery)
            );
        }

        // Apply color filter
        if (this.activeColors.size > 0) {
            allHighlights = allHighlights.filter(h => {
                if (!h.color) return false;
                return this.activeColors.has(h.color.toLowerCase());
            });
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

    async exportToCanvas() {
        if (this.isScanning) return;
        
        let allHighlights = [];
        for (const res of this.scanResults) {
            for (const h of res.highlights) {
                allHighlights.push({ ...h, file: res.file, frontmatter: res.frontmatter });
            }
        }

        if (this.filterKey && this.filterKey !== "All Properties" && this.filterValue) {
            const filterVal = this.filterValue.toLowerCase().replace(/^#/, "");
            allHighlights = allHighlights.filter(h => {
                const val = h.frontmatter?.[this.filterKey];
                if (val === undefined || val === null) return false;

                if (this.filterKey === "tags" || this.filterKey === "tag") {
                    if (Array.isArray(val)) {
                        return val.some(t => String(t).toLowerCase().replace(/^#/, "").includes(filterVal));
                    }
                    return String(val).toLowerCase().replace(/^#/, "").includes(filterVal);
                }

                if (Array.isArray(val)) {
                    return val.some(v => String(v).toLowerCase().includes(filterVal));
                }

                return String(val).toLowerCase().includes(filterVal);
            });
        }

        if (this.searchQuery) {
            allHighlights = allHighlights.filter(h =>
                h.text.toLowerCase().includes(this.searchQuery)
            );
        }

        if (this.activeColors.size > 0) {
            allHighlights = allHighlights.filter(h => {
                if (!h.color) return false;
                return this.activeColors.has(h.color.toLowerCase());
            });
        }

        if (allHighlights.length === 0) {
            // Notice requires plugin context but we can just use native Obsidian Notice
            const { Notice } = require("obsidian");
            new Notice("No highlights to export to Canvas.");
            return;
        }

        try {
            const { Notice } = require("obsidian");
            new Notice("Generating Canvas...");
            const exportPath = await exportHighlightsToCanvas(this.app, allHighlights);
            const file = this.app.vault.getAbstractFileByPath(exportPath);
            if (file) {
                const leaf = this.app.workspace.getLeaf('tab');
                await leaf.openFile(file);
            }
        } catch (e) {
            console.error(e);
        }
    }
}
