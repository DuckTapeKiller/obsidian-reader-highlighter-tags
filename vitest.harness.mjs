import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    resolve: { alias: { obsidian: path.resolve("./tests/obsidian-stub.js") } },
    test: {
        include: ["vaultharness/**/*.test.js"],
        setupFiles: ["./tests/setup.js"],
        testTimeout: 300000,
        hookTimeout: 300000,
    },
});
