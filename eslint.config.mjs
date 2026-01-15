import globals from "globals";
import pluginJs from "@eslint/js";

export default [
    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                document: "readonly",
                window: "readonly",
                Node: "readonly"
            },
            ecmaVersion: 2022,
            sourceType: "module"
        }
    },
    pluginJs.configs.recommended,
    {
        rules: {
            "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
            "no-undef": "off" // Obsidian types and requires might trigger this if not careful, but globals should handle standard stuff.
        }
    }
];
