import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultScanner } from "../src/core/VaultScanner.js";

describe("VaultScanner", () => {
    let mockApp;
    let scanner;

    beforeEach(() => {
        mockApp = {
            vault: {
                getMarkdownFiles: vi.fn(),
                cachedRead: vi.fn(),
            },
            metadataCache: {
                getFileCache: vi.fn().mockReturnValue({ frontmatter: {} })
            }
        };
        scanner = new VaultScanner(mockApp);
    });

    it("scans files and groups highlights by file", async () => {
        const mockFile1 = { path: "file1.md", basename: "File 1", stat: { mtime: 1 } };
        const mockFile2 = { path: "file2.md", basename: "File 2", stat: { mtime: 1 } };
        
        mockApp.vault.getMarkdownFiles.mockReturnValue([mockFile1, mockFile2]);
        
        mockApp.vault.cachedRead.mockImplementation((file) => {
            if (file.path === "file1.md") {
                return Promise.resolve("Testing ==one== and <mark>two</mark>");
            }
            return Promise.resolve("Nothing here");
        });

        const results = await scanner.scanVault();
        
        expect(results.length).toBe(1);
        expect(results[0].file.path).toBe("file1.md");
        expect(results[0].highlights.length).toBe(2);
        expect(results[0].highlights[0].text).toBe("one");
        expect(results[0].highlights[1].text).toBe("two");
    });

    it("uses cache on subsequent scans if mtime is unchanged", async () => {
        const mockFile = { path: "test.md", basename: "Test", stat: { mtime: 100 } };
        
        mockApp.vault.getMarkdownFiles.mockReturnValue([mockFile]);
        mockApp.vault.cachedRead.mockResolvedValue("A ==highlight== here");
        
        // First scan
        await scanner.scanVault();
        expect(mockApp.vault.cachedRead).toHaveBeenCalledTimes(1);
        
        // Second scan (mtime identical)
        const results2 = await scanner.scanVault();
        expect(mockApp.vault.cachedRead).toHaveBeenCalledTimes(1); // Should NOT be called again
        expect(results2[0].highlights.length).toBe(1);
        
        // Update mtime and scan again
        mockFile.stat.mtime = 200;
        await scanner.scanVault();
        expect(mockApp.vault.cachedRead).toHaveBeenCalledTimes(2); // Should be called now
    });
});
