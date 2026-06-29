import { App, TFile } from "obsidian";
import { getHighlightsFromContent } from "../utils/export";
import type { Highlight } from "../utils/highlights";

export interface ScanResult {
    file: TFile;
    highlights: Highlight[];
    frontmatter: Record<string, unknown>;
}

interface CacheEntry {
    mtime: number;
    highlights: Highlight[];
    frontmatter: Record<string, unknown>;
}

type ProgressCallback = (current: number, total: number, filename: string) => void;

export class VaultScanner {
    app: App;
    cache: Map<string, CacheEntry>;

    constructor(app: App) {
        this.app = app;
        this.cache = new Map();
    }

    /**
     * Scans the entire vault for highlights asynchronously.
     */
    async scanVault(onProgress: ProgressCallback = () => {}): Promise<ScanResult[]> {
        const files = this.app.vault.getMarkdownFiles();
        const total = files.length;
        const results: ScanResult[] = [];

        // Batch configuration to avoid blocking UI
        const BATCH_SIZE = 20;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = files.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (file): Promise<ScanResult> => {
                const stat = file.stat;

                // Check cache
                const cached = this.cache.get(file.path);
                if (cached && cached.mtime === stat.mtime) {
                    return { file, highlights: cached.highlights, frontmatter: cached.frontmatter };
                }

                // Read and parse
                const content = await this.app.vault.cachedRead(file);
                const highlights = getHighlightsFromContent(content);
                const metadata = this.app.metadataCache.getFileCache(file);
                const frontmatter = (metadata?.frontmatter as Record<string, unknown>) || {};

                // Update cache
                this.cache.set(file.path, {
                    mtime: stat.mtime,
                    highlights: highlights,
                    frontmatter: frontmatter,
                });

                return { file, highlights, frontmatter };
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
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        }

        // Sort results by file name
        results.sort((a, b) => a.file.basename.localeCompare(b.file.basename));

        return results;
    }

    /**
     * Clear the cache to force a full re-scan
     */
    clearCache(): void {
        this.cache.clear();
    }
}
