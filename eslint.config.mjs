import globals from "globals";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintConfigPrettier from "eslint-config-prettier/flat";

// The general rules below run without type information. The obsidianmd
// recommended set, spread after them, is type-aware for TypeScript.

const sharedLanguageOptions = {
    globals: {
        // Browser globals only, as the review bot sees the code: a Node
        // global must be declared where a build script uses it.
        ...globals.browser,
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
        // Real build output only: the committed bundle and the stale copy in
        // build/. Everything else the obsidianmd preset targets is linted.
        ignores: ["main.js", "build/**", "node_modules/**"],
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
    // The full, current obsidianmd ruleset, spread as published: it carries
    // its own globs for TS, JS and package.json, so they are not narrowed.
    ...obsidianmd.configs.recommended,
    {
        // Several obsidianmd rules are type-aware, so TypeScript gets the
        // program.
        files: ["**/*.{ts,tsx,cts,mts}"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // The plain .mjs configs are not part of the TypeScript program.
        files: ["**/*.mjs"],
        extends: [tseslint.configs.disableTypeChecked],
    },
    {
        // `recommended` ships this one switched off. The code already uses
        // `activeDocument` throughout, so turning it on costs nothing today and
        // keeps a plain `document` from creeping in later — popout windows have
        // their own document, and a plugin reaching for the wrong one silently
        // stops working there.
        files: ["src/**/*.ts"],
        rules: { "obsidianmd/prefer-active-doc": "error" },
    },
    {
        // `validate-manifest` reads the manifest as a JS object expression
        // (Program > ExpressionStatement > ObjectExpression), so it needs the
        // TypeScript parser rather than a JSON language — under `json/json` the
        // AST shape differs and the rule silently never fires. Without any block
        // at all ESLint skips the file outright ("no matching configuration").
        //
        // Its sibling `validate-license` is not wired up: it expects LICENSE to
        // parse as JavaScript, which a real MIT licence does not, so it can only
        // ever produce a parsing error.
        files: ["manifest.json"],
        languageOptions: { parser: tsparser, parserOptions: { ecmaFeatures: {} } },
        plugins: { obsidianmd },
        rules: {
            "obsidianmd/validate-manifest": "error",
        },
    },
    eslintConfigPrettier
);
