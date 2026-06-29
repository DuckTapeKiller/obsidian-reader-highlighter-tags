// The plugin runs in Obsidian's browser context, where `window` and
// `activeWindow` are defined. The unit tests run in Node, so expose the global
// scope as `window`/`activeWindow` (and `activeDocument`) for any code that
// uses window-scoped timers etc.
globalThis.window = globalThis.window || globalThis;
globalThis.activeWindow = globalThis.activeWindow || globalThis;
if (!globalThis.activeDocument && globalThis.document) {
    globalThis.activeDocument = globalThis.document;
}
