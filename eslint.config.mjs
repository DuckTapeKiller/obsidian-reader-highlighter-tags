import globals from "globals";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

const sharedLanguageOptions = {
    globals: {
        ...globals.browser,
        ...globals.node,
        document: "readonly",
        window: "readonly",
        Node: "readonly",
    },
    ecmaVersion: 2022,
    sourceType: "module",
};

export default defineConfig(
    {
        // replacement for .eslintignore (keep lint runs fast/clean)
        ignores: ["main.js", "node_modules/**"],
    },
    {
        files: ["**/*.{js,mjs,cjs}"],
        languageOptions: sharedLanguageOptions,
        extends: [js.configs.recommended],
        rules: {
            "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "no-undef": "off",
        },
    },
    {
        files: ["**/*.{ts,tsx,cts,mts}"],
        languageOptions: sharedLanguageOptions,
        extends: [js.configs.recommended, tseslint.configs.recommended],
        rules: {
            // Use TS-aware version for TS files
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "no-unused-vars": "off",
            // Obsidian types and runtime globals can make this noisy
            "no-undef": "off",
            // Obsidian plugin code often needs these escape hatches
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-require-imports": "off",
            "prefer-const": "off",
        },
    },
    eslintConfigPrettier
);
