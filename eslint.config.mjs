import { defineConfig } from "eslint/config";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

// The obsidianmd recommended config, as its README sets it up, plus two
// additions. It already carries ESLint's and typescript-eslint's recommended
// rules, so they are not added here: registering typescript-eslint a second
// time crashes ESLint ("Cannot redefine plugin") whenever the two copies
// differ, which a newer obsidianmd release can bring about.
//
// eslint.review.config.mjs is the same config without the additions: the
// community review bot's view. The build and CI run both.

export default defineConfig(
    {
        // Real build output only: the committed bundle and the stale copy in
        // build/. Everything else the obsidianmd preset targets is linted.
        ignores: ["main.js", "build/**", "node_modules/**"],
    },
    // The full, current obsidianmd ruleset, spread as published: it carries
    // its own globs for TS, JS and package.json, so they are not narrowed.
    ...obsidianmd.configs.recommended,
    {
        // Several obsidianmd rules are type-aware, so they get the program.
        // tsconfig.json includes the tests and .mjs configs as well.
        files: ["**/*.{ts,tsx,cts,mts,js,mjs,cjs}"],
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
    }
);
