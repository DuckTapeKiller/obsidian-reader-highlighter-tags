import { getHighlightsFromContent } from "../utils/export";

export class VaultScanner {
    constructor(app) {
        this.app = app;
        this.cache = new Map(); // path -> { mtime, highlights }
    }

    /**
     * Scans the entire vault for highlights asynchronously.
     * @param {function} onProgress - Callback with signatures (current, total, filename)
     * @returns {Promise<Array>} Array of { file: TFile, highlights: Array }
     */
    async scanVault(onProgress = () => {}) {
        const files = this.app.vault.getMarkdownFiles();
        const total = files.length;
        const results = [];
        
        // Batch configuration to avoid blocking UI
        const BATCH_SIZE = 20;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);
            
            const batchPromises = batch.map(async (file) => {
                const stat = file.stat;
                
                // Check cache
                const cached = this.cache.get(file.path);
                if (cached && cached.mtime === stat.mtime) {
                    return { file, highlights: cached.highlights };
                }

                // Read and parse
                const content = await this.app.vault.cachedRead(file);
                const highlights = getHighlightsFromContent(content);
                
                // Update cache
                this.cache.set(file.path, {
                    mtime: stat.mtime,
                    highlights: highlights
                });

                return { file, highlights };
            });

            const batchResults = await Promise.all(batchPromises);
            
            for (const res of batchResults) {
                if (res.highlights.length > 0) {
                    results.push(res);
                }
            }

            // Report progress
            const current = Math.min(i + BATCH_SIZE, total);
            const lastFileName = batch[batch.length - 1].basename;
            onProgress(current, total, lastFileName);

            // Yield to main thread
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Sort results by file name
        results.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
        
        return results;
    }

    /**
     * Clear the cache to force a full re-scan
     */
    clearCache() {
        this.cache.clear();
    }
}
