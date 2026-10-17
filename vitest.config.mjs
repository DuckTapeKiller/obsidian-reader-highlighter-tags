import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        // `obsidian` ships type declarations only, so tests that import plugin
        // modules need a runtime stand-in for its exports.
        alias: { obsidian: new URL("./tests/obsidian-stub.js", import.meta.url).pathname },
    },
    test: {
        include: ["tests/**/*.test.js"],
        environment: "jsdom",
        setupFiles: ["./tests/setup.js"],
    },
});
