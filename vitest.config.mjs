import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        // `obsidian` ships type declarations only, so tests that import plugin
        // modules need a runtime stand-in for its exports.
        // Decoded: `URL.pathname` stays percent-encoded, and a checkout under a
        // folder with a space or an accent then fails to find the stub.
        alias: { obsidian: decodeURIComponent(new URL("./tests/obsidian-stub.js", import.meta.url).pathname) },
    },
    test: {
        include: ["tests/**/*.test.js"],
        environment: "jsdom",
        setupFiles: ["./tests/setup.js"],
    },
});
