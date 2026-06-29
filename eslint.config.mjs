import globals from "globals";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintConfigPrettier from "eslint-config-prettier/flat";

// NOTE: This config intentionally does NOT enable type-aware linting (no
// `parserOptions.project` / no tsconfig). Type-aware linting surfaces hundreds
// of `no-unsafe-*` / `no-explicit-any` warnings on this plain-JS codebase, none
// of which block the Obsidian community store. We only enforce the AST-based
// Obsidian guideline rules that are reported as Errors by the official review.

const sharedLanguageOptions = {
    globals: {
        ...globals.browser,
        ...globals.node,
        document: "readonly",
        window: "readonly",
        Node: "readonly",
        activeDocument: "readonly",
        activeWindow: "readonly",
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
        // Parse TS syntax only — no `project`, so no type-aware rules run.
        languageOptions: { ...sharedLanguageOptions, parser: tsparser },
        extends: [js.configs.recommended, tseslint.configs.recommended],
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "no-unused-vars": "off",
            "no-undef": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-require-imports": "off",
            "prefer-const": "off",
        },
    },
    {
        // Obsidian guideline rules reported as Errors by the official review.
        // These are AST-based and need no type information.
        files: ["**/*.{js,mjs,cjs,ts,tsx,cts,mts}"],
        plugins: { obsidianmd },
        rules: {
            "obsidianmd/no-static-styles-assignment": "error",
            "obsidianmd/settings-tab/no-manual-html-headings": "error",
            "obsidianmd/detach-leaves": "error",
        },
    },
    eslintConfigPrettier
);
