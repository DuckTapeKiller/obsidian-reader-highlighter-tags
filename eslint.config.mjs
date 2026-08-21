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
        // The full, current obsidianmd ruleset. Its own config already targets
        // TS, JS and package.json in separate blocks, so `files` here is kept
        // wide enough not to intersect any of those away — but it must exclude
        // other JSON, since several blocks in the preset carry no file scope of
        // their own and would otherwise run JavaScript rules against
        // manifest.json. Several rules are type-aware; the program is enabled
        // in the block below.
        files: ["src/**/*.{ts,js}", "package.json"],
        extends: [obsidianmd.configs.recommended],
    },
    {
        files: ["**/*.{ts,tsx,cts,mts}"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
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
