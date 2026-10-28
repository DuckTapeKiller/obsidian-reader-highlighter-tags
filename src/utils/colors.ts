/**
 * Obsidian's native highlight colours.
 *
 * Since Obsidian 1.14 a highlight takes a colour from an emoji written straight
 * after its opening marker: `==🟡text==` renders as a yellow highlight and the
 * emoji itself is never shown. These are the only colours there are, so the
 * plugin writes them instead of HTML.
 */
export const HIGHLIGHT_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** The emoji Obsidian writes for each colour. */
export const COLOR_EMOJI: Record<HighlightColor, string> = {
    red: "🔴",
    orange: "🟠",
    yellow: "🟡",
    green: "🟢",
    blue: "🔵",
    purple: "🟣",
};

/** Every emoji Obsidian reads as a colour; the squares are accepted too. */
const EMOJI_COLOR: Record<string, HighlightColor> = {
    "🔴": "red",
    "🟥": "red",
    "🟠": "orange",
    "🟧": "orange",
    "🟡": "yellow",
    "🟨": "yellow",
    "🟢": "green",
    "🟩": "green",
    "🔵": "blue",
    "🟦": "blue",
    "🟣": "purple",
    "🟪": "purple",
};

export const COLOR_LABELS: Record<HighlightColor, string> = {
    red: "Red",
    orange: "Orange",
    yellow: "Yellow",
    green: "Green",
    blue: "Blue",
    purple: "Purple",
};

export function isHighlightColor(value: unknown): value is HighlightColor {
    return typeof value === "string" && (HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

/**
 * The colour emoji starting at `index` in `text`, if there is one. `length` is
 * in UTF-16 code units, so it can be added to an offset directly.
 */
export function colorAt(text: string, index = 0): { color: HighlightColor | null; length: number } {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) return { color: null, length: 0 };
    const char = String.fromCodePoint(codePoint);
    const color = EMOJI_COLOR[char] ?? null;
    return { color, length: color ? char.length : 0 };
}

/**
 * Wrap `content` in a highlight of `color` (none for the theme's default).
 *
 * Obsidian only renders a highlight whose markers touch text, so whitespace at
 * either end stays outside them.
 */
export function wrapHighlight(content: string, color: HighlightColor | null | undefined): string {
    const lead = content.match(/^\s*/)?.[0] ?? "";
    const inner = content.trim();
    if (!inner) return content;
    const trail = content.slice(lead.length + inner.length);
    return `${lead}==${color ? COLOR_EMOJI[color] : ""}${inner}==${trail}`;
}

export interface HighlightMarkers {
    /** Start of the opening `==`. */
    open: number;
    /** End of the opening marker, past its colour emoji if it has one. */
    openEnd: number;
    /** Start of the closing `==`. */
    close: number;
    color: HighlightColor | null;
}

/**
 * Characters of `text` that cannot be a highlight marker: those of code spans,
 * of backslash escapes, and inside wikilinks, whose text Obsidian shows as it
 * is.
 */
function codeAndEscapes(text: string): boolean[] {
    const masked = new Array<boolean>(text.length).fill(false);
    for (const m of text.matchAll(/!?\[\[(?:[^\]\n]|\](?!\]))*\]\]/g)) {
        for (let k = m.index; k < m.index + m[0].length; k++) masked[k] = true;
    }
    let i = 0;
    while (i < text.length) {
        if (text[i] === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
            masked[i] = masked[i + 1] = true;
            i += 2;
            continue;
        }
        if (text[i] === "`") {
            let runEnd = i;
            while (runEnd < text.length && text[runEnd] === "`") runEnd++;
            const fence = text.slice(i, runEnd);
            let close = text.indexOf(fence, runEnd);
            // A closing run must be exactly as long as the opening one.
            while (close !== -1 && text[close + fence.length] === "`") {
                let next = close;
                while (text[next] === "`") next++;
                close = text.indexOf(fence, next);
            }
            const end = close === -1 ? runEnd : close + fence.length;
            for (let k = i; k < end; k++) masked[k] = true;
            i = end;
            continue;
        }
        i++;
    }
    return masked;
}

/**
 * The highlights in one line of `text`, read as Obsidian reads them: an
 * opening `==` must be followed by a character that is not whitespace, a
 * closing `==` must follow one, and `==` inside a code span or escaped is
 * plain text. So `if x == 1 or y == 2` and `` `a == b` `` hold no highlight,
 * while `a==b==c` does. Markers pair left to right, each opener with the
 * first closer after it.
 */
export function highlightMarkerPairs(text: string): HighlightMarkers[] {
    const masked = codeAndEscapes(text);
    const isMarker = (k: number) => text[k] === "=" && text[k + 1] === "=" && !masked[k] && !masked[k + 1];
    const pairs: HighlightMarkers[] = [];
    let i = 0;
    while (i < text.length - 1) {
        if (!isMarker(i) || i + 2 >= text.length || /\s/.test(text[i + 2])) {
            i++;
            continue;
        }
        let close = -1;
        for (let j = i + 3; j < text.length - 1; j++) {
            if (text[j] === "\n") break;
            if (isMarker(j) && !/\s/.test(text[j - 1])) {
                close = j;
                break;
            }
        }
        if (close === -1) {
            i++;
            continue;
        }
        const colour = colorAt(text, i + 2);
        pairs.push({ open: i, openEnd: i + 2 + colour.length, close, color: colour.color });
        i = close + 2;
    }
    return pairs;
}

/**
 * Remove the highlight markers from `text`, with the colour emoji of each
 * opening one. Only markers Obsidian reads as a highlight go: the `==` of a
 * comparison or of code stays.
 */
export function stripHighlightMarkers(text: string): string {
    let out = "";
    let cursor = 0;
    for (const pair of highlightMarkerPairs(text)) {
        out += text.slice(cursor, pair.open) + text.slice(pair.openEnd, pair.close);
        cursor = pair.close + 2;
    }
    return out + text.slice(cursor);
}

const CSS_COLOR_NAMES: Record<string, HighlightColor> = {
    red: "red",
    crimson: "red",
    pink: "purple",
    hotpink: "purple",
    orange: "orange",
    darkorange: "orange",
    gold: "yellow",
    yellow: "yellow",
    lime: "green",
    green: "green",
    teal: "blue",
    cyan: "blue",
    aqua: "blue",
    blue: "blue",
    purple: "purple",
    violet: "purple",
    magenta: "purple",
    fuchsia: "purple",
};

function parseCssColor(value: string): [number, number, number] | null {
    const css = value.trim().toLowerCase();
    const hex = css.match(/^#([0-9a-f]{3,8})$/);
    if (hex) {
        let digits = hex[1];
        if (digits.length === 3 || digits.length === 4) {
            digits = digits
                .slice(0, 3)
                .split("")
                .map((d) => d + d)
                .join("");
        }
        if (digits.length !== 6 && digits.length !== 8) return null;
        return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number];
    }
    const rgb = css.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return null;
}

/**
 * The native colour nearest a CSS colour, for converting the HTML highlights
 * older versions wrote. Greys have no hue to go by and map to none.
 */
export function nearestHighlightColor(value: string | null | undefined): HighlightColor | null {
    if (!value) return null;
    const named = CSS_COLOR_NAMES[value.trim().toLowerCase()];
    if (named) return named;
    const rgb = parseCssColor(value);
    if (!rgb) return null;
    const [r, g, b] = rgb.map((c) => c / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const lightness = (max + min) / 2;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    if (saturation < 0.12) return null;
    let hue: number;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    if (hue < 15 || hue >= 345) return "red";
    if (hue < 40) return "orange";
    if (hue < 70) return "yellow";
    if (hue < 165) return "green";
    if (hue < 250) return "blue";
    return "purple";
}
