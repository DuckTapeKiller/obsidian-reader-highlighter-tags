// The plugin runs in Obsidian's browser context, where `window`, `activeWindow`
// and `activeDocument` are defined. Vitest runs every test in a jsdom window
// (see vitest.config.mjs); Obsidian's popout-aware aliases point at it.
import { vi } from "vitest";

vi.stubGlobal("activeWindow", window);
vi.stubGlobal("activeDocument", window.document);
