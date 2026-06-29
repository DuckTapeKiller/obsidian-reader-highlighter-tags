import globals from "globals";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintConfigPrettier from "eslint-config-prettier/flat";

// The obsidianmd plugin applies several (type-aware) guideline rules with no
// file restriction. They target the plugin's TS entry, so switch every
// obsidianmd/* rule off for plain JS/test files to avoid type-info errors there.
const obsidianRulesOffForJs = Object.fromEntries(
    Object.keys(obsidianmd.rules ?? {}).map((name) => [`obsidianmd/${name}`, "off"])
);

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
    // Official Obsidian plugin guideline rules (obsidianmd/*) plus the
    // typescript-eslint recommended sets it extends.
    ...obsidianmd.configs.recommended,
    {
        // The recommended set enables type-checked rules; give TS files the
        // type information they require.
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: "./tsconfig.json",
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // This codebase is mostly hand-written JS (+ tests). Turn off the
        // type-checked rules there so lint runs without full type info.
        files: ["**/*.{js,mjs,cjs,jsx}"],
        rules: { ...tseslint.configs.disableTypeChecked.rules, ...obsidianRulesOffForJs },
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
    {
        // Project policy overrides for the TS plugin entry (main.ts).
        files: ["**/*.{ts,tsx,cts,mts}"],
        rules: {
            // The obsidianmd "recommended" set pulls in typescript-eslint's
            // *type-checked* rules (no-unsafe-*, no-floating-promises, …). This
            // codebase is loosely typed by design (heavy use of `any` against the
            // Obsidian API), so those are off — they are not Obsidian guidelines.
            ...tseslint.configs.disableTypeChecked.rules,

            // The following obsidianmd guideline rules are intentionally disabled
            // because the only way to satisfy them is to change visible UI text,
            // the rendered DOM, or runtime behavior — which must stay identical.
            // (Re-enable these if/when doing a dedicated community-store pass.)
            "obsidianmd/ui/sentence-case": "off", // would rewrite visible setting/command labels
            "obsidianmd/commands/no-default-hotkeys": "off", // removing them drops shipped hotkeys
            "obsidianmd/prefer-active-doc": "off", // document -> activeDocument alters popout behavior
            "obsidianmd/prefer-window-timers": "off", // requestAnimationFrame swap is behaviorally moot here
        },
    },
    {
        // The official Obsidian review flags these three as Errors and they are
        // now fixed in the code, so enforce them everywhere (incl. JS files,
        // which the JS override above otherwise silences). They are AST-based and
        // need no type information, so they run safely on plain JS too. This keeps
        // the local gate in sync with the official review.
        files: ["**/*.{js,mjs,cjs,jsx,ts,tsx,cts,mts}"],
        rules: {
            "obsidianmd/no-static-styles-assignment": "error",
            "obsidianmd/settings-tab/no-manual-html-headings": "error",
            "obsidianmd/detach-leaves": "error",
        },
    },
    eslintConfigPrettier
);
