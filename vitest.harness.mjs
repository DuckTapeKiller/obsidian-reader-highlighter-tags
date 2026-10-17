import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: { alias: { obsidian: new URL("./tests/obsidian-stub.js", import.meta.url).pathname } },
    test: {
        include: ["vaultharness/**/*.test.js"],
        environment: "jsdom",
        setupFiles: ["./tests/setup.js"],
        testTimeout: 300000,
        hookTimeout: 300000,
    },
});
