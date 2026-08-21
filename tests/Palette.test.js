// The toolbar palette: which colours appear, and — the part that can silently
// corrupt notes — which colour a button actually applies once the list is
// filtered.
import { describe, it, expect, beforeEach } from "vitest";
import { FloatingManager } from "../src/ui/FloatingManager";
import { createObsidianWindow } from "./dom-helpers.js";

function makeManager(colors, showOnlyAssignedColors) {
    const window = createObsidianWindow();
    const applied = [];
    const view = { getMode: () => "preview" };
    const plugin = {
        app: { workspace: { getActiveViewOfType: () => view, on: () => {}, off: () => {} } },
        settings: {
            enableColorPalette: true,
            showOnlyAssignedColors,
            semanticColors: colors,
            showTagButton: false,
            showQuoteButton: false,
            showRemoveButton: false,
            enableAnnotations: false,
            showAnnotationButton: false,
            enableReadingProgress: false,
            toolbarPosition: "right",
        },
        applyColorByIndex: (_v, index) => applied.push(index),
        savePdfHighlight: () => {},
    };
    return { manager: new FloatingManager(plugin), applied, window };
}

const palette = (meanings) => meanings.map((meaning, i) => ({ color: `#00000${i}`, meaning }));

describe("toolbar palette filtering", () => {
    let full;
    beforeEach(() => {
        full = palette(["Disagreement", "", "Key point", "", "", "Definition", "", ""]);
    });

    it("shows only colours that have a meaning", () => {
        const { manager } = makeManager(full, true);
        expect(manager.visiblePaletteColors().map((e) => e.index)).toEqual([0, 2, 5]);
    });

    it("shows every colour when the option is off", () => {
        const { manager } = makeManager(full, false);
        expect(manager.visiblePaletteColors()).toHaveLength(8);
    });

    it("shows every colour when nothing has been named yet", () => {
        const { manager } = makeManager(palette(["", "", ""]), true);
        expect(manager.visiblePaletteColors()).toHaveLength(3);
    });

    it("ignores whitespace-only meanings", () => {
        const { manager } = makeManager(palette(["  ", "Real", "\t"]), true);
        expect(manager.visiblePaletteColors().map((e) => e.index)).toEqual([1]);
    });

    it("renders one button per visible colour, tagged with its real index", () => {
        const { manager } = makeManager(full, true);
        manager.createElements();
        const buttons = [...manager.paletteContainer.querySelectorAll("button")];
        expect(buttons).toHaveLength(3);
        expect(buttons.map((b) => b.getAttribute("data-color-index"))).toEqual(["0", "2", "5"]);
        expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Disagreement", "Key point", "Definition"]);
    });

    it("applies the colour the button represents, not its position", () => {
        const { manager, applied, window } = makeManager(full, true);
        manager.load();
        const buttons = [...manager.paletteContainer.querySelectorAll("button")];
        // Third visible button is semanticColors[5], not semanticColors[2].
        buttons[2].dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true }));
        expect(applied).toEqual([5]);
    });

    it("still applies the right colour with filtering off", () => {
        const { manager, applied, window } = makeManager(full, false);
        manager.load();
        const buttons = [...manager.paletteContainer.querySelectorAll("button")];
        buttons[5].dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true }));
        expect(applied).toEqual([5]);
    });
});
