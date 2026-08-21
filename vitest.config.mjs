import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    resolve: {
        // `obsidian` ships type declarations only, so tests that import plugin
        // modules need a runtime stand-in for its exports.
        alias: { obsidian: path.resolve("./tests/obsidian-stub.js") },
    },
    test: {
        include: ["tests/**/*.test.js"],
        setupFiles: ["./tests/setup.js"],
    },
});
