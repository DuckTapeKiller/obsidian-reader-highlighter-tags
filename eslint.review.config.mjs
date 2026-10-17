// The community review bot's view of the code: the obsidianmd README config
// and nothing of this project's own. It runs beside eslint.config.mjs (in the
// build and in CI) so a setting there can never hide something the bot flags.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    { ignores: ["main.js", "build/**", "node_modules/**"] },
    ...obsidianmd.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                // tsconfig.json already includes the .mjs configs.
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
]);
