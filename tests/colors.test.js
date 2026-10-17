// Obsidian's native highlight colours: reading and writing the `==🟡text==` form.
import { describe, it, expect } from "vitest";
import {
    colorAt,
    wrapHighlight,
    stripHighlightMarkers,
    nearestHighlightColor,
    COLOR_EMOJI,
    HIGHLIGHT_COLORS,
} from "../src/utils/colors";

describe("colorAt", () => {
    it("reads each colour Obsidian writes, and the square variants it also reads", () => {
        for (const color of HIGHLIGHT_COLORS) {
            expect(colorAt(COLOR_EMOJI[color] + "text")).toEqual({ color, length: 2 });
        }
        expect(colorAt("🟨text").color).toBe("yellow");
        expect(colorAt("🟪text").color).toBe("purple");
    });

    it("reports nothing for text or other emoji", () => {
        expect(colorAt("text")).toEqual({ color: null, length: 0 });
        expect(colorAt("⚪text")).toEqual({ color: null, length: 0 });
        expect(colorAt("")).toEqual({ color: null, length: 0 });
    });

    it("reads at an offset", () => {
        expect(colorAt("==🔵x", 2).color).toBe("blue");
    });
});

describe("wrapHighlight", () => {
    it("writes the colour emoji straight after the opening marker", () => {
        expect(wrapHighlight("texto", "yellow")).toBe("==🟡texto==");
        expect(wrapHighlight("texto", null)).toBe("==texto==");
    });

    it("keeps surrounding whitespace outside the markers", () => {
        expect(wrapHighlight("  texto ", "red")).toBe("  ==🔴texto== ");
    });

    it("leaves blank text alone", () => {
        expect(wrapHighlight("   ", "red")).toBe("   ");
    });
});

describe("stripHighlightMarkers", () => {
    it("is split-and-join for text without colours", () => {
        for (const text of ["==a== b ==c==", "a===b", "====", "x == y", "==sin cierre", ""]) {
            expect(stripHighlightMarkers(text)).toBe(text.split("==").join(""));
        }
    });

    it("drops the colour of each opening marker", () => {
        expect(stripHighlightMarkers("==🟡uno== y ==🔴dos==")).toBe("uno y dos");
    });

    it("keeps an emoji after a closing marker, which is visible text", () => {
        expect(stripHighlightMarkers("==uno==🔴 dos")).toBe("uno🔴 dos");
    });
});

describe("nearestHighlightColor", () => {
    it("maps the old fifteen-colour palette onto the six native colours", () => {
        const old = {
            "#FFCDD2": "red",
            "#BBDEFB": "blue",
            "#C8E6C9": "green",
            "#FFF9C4": "yellow",
            "#FFE0B2": "orange",
            "#E1BEE7": "purple",
            "#FFEE58": "yellow",
        };
        for (const [hex, color] of Object.entries(old)) expect(nearestHighlightColor(hex)).toBe(color);
    });

    it("reads short hex, rgb() and colour names", () => {
        expect(nearestHighlightColor("#f00")).toBe("red");
        expect(nearestHighlightColor("rgb(30, 120, 255)")).toBe("blue");
        expect(nearestHighlightColor("yellow")).toBe("yellow");
    });

    it("gives greys and nonsense no colour", () => {
        expect(nearestHighlightColor("#cccccc")).toBe(null);
        expect(nearestHighlightColor("var(--x)")).toBe(null);
        expect(nearestHighlightColor("")).toBe(null);
    });
});
