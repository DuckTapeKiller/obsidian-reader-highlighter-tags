import globals from "globals";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintConfigPrettier from "eslint-config-prettier/flat";

// NOTE: The general TypeScript rules below run without type information, since
// type-aware linting surfaces hundreds of `no-unsafe-*` / `no-explicit-any`
// warnings that do not block the Obsidian community store. The obsidianmd
// recommended set is a separate block that DOES enable the type-aware program,
// because several of its rules require it.

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
        // The full, current obsidianmd ruleset. Using the plugin's own
        // `recommended` preset rather than a hand-picked subset means new rules
        // arrive with the dependency instead of silently going unenforced.
        //
        // Scoped to the shipped plugin source: these are guidelines about plugin
        // code, and the preset pulls in type-aware rules, which need every linted
        // file to be part of the TypeScript program. `tests/` is not.
        files: ["src/**/*.ts"],
        extends: [obsidianmd.configs.recommended],
        languageOptions: {
            ...sharedLanguageOptions,
            parser: tsparser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    eslintConfigPrettier
);
