// Reading view gives us the block element a selection sits in, but not *which*
// occurrence of the selected text inside that block the user actually picked.
// When the same word appears twice in one block — most commonly a paragraph
// split by soft line breaks (Shift+Enter), which stays a single <p> — every
// occurrence produces an identical snippet and an identical block context, so
// the source matcher has no way to tell them apart and falls back to the first.
//
// These helpers recover the missing signal: they read the block's rendered text
// together with the caret offset inside it, then convert that into the ordinal
// of the selected occurrence ("the 2nd `apple` in this block"). The ordinal is
// what gets handed to the matcher, because an ordinal survives the trip from
// rendered text to Markdown source — character offsets do not, since the source
// carries markers (`**`, `==`, `[[ ]]`, footnote refs) that the rendered text
// does not.

// Minimal structural view of a DOM node, so this module can be unit-tested
// without a DOM implementation and still accept real nodes at runtime.
export interface NodeLike {
    nodeType: number;
    nodeValue?: string | null;
    tagName?: string;
    childNodes?: ArrayLike<NodeLike>;
}

export interface RangeLike {
    startContainer: NodeLike;
    startOffset: number;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// Elements that introduce a visual line break inside a block. Their boundary is
// whitespace in the rendered text even though they contribute no text node, so
// walking text nodes alone would silently join the words on either side.
const LINE_BREAK_TAGS = new Set(["BR", "HR"]);

export interface BlockTextAndCaret {
    text: string;
    caret: number;
}

/**
 * Collapse whitespace runs to single spaces and trim, mapping one index from
 * the raw string into the collapsed one. Mirrors the normalisation used for the
 * block context text elsewhere in the plugin, so both sides stay comparable.
 */
export function collapseWhitespace(raw: string, rawIndex: number): { text: string; index: number } {
    let out = "";
    let mapped = 0;
    let pendingGap = false;
    let seenNonSpace = false;

    for (let i = 0; i < raw.length; i++) {
        if (i === rawIndex) {
            // A caret that lands inside a whitespace run belongs at the start of
            // the next word, which is where the pending gap will be written.
            mapped = pendingGap && seenNonSpace ? out.length + 1 : out.length;
        }
        const char = raw[i];
        if (/\s/.test(char)) {
            pendingGap = true;
            continue;
        }
        if (pendingGap && seenNonSpace) {
            out += " ";
        }
        pendingGap = false;
        seenNonSpace = true;
        out += char;
    }
    if (rawIndex >= raw.length) {
        mapped = out.length;
    }
    return { text: out, index: Math.max(0, Math.min(out.length, mapped)) };
}

/**
 * Read a block element's rendered text along with the offset of `range`'s start
 * inside it. Returns null when the range does not start inside the block, which
 * is the caller's signal to fall back to the previous first-match behaviour.
 */
export function readBlockTextAndCaret(block: NodeLike | null, range: RangeLike | null): BlockTextAndCaret | null {
    if (!block || !range || !range.startContainer) return null;

    let raw = "";
    let rawCaret = -1;

    const visit = (node: NodeLike): void => {
        if (node.nodeType === TEXT_NODE) {
            if (node === range.startContainer) {
                rawCaret = raw.length + Math.max(0, range.startOffset);
            }
            raw += node.nodeValue || "";
            return;
        }
        if (node.nodeType !== ELEMENT_NODE) return;

        const children = node.childNodes;
        if (node === range.startContainer) {
            // An element container means the caret sits *between* child nodes;
            // `startOffset` counts children, not characters.
            let index = 0;
            const limit = Math.min(range.startOffset, children ? children.length : 0);
            while (index < limit) {
                visit(children[index]);
                index++;
            }
            if (rawCaret === -1) rawCaret = raw.length;
            while (children && index < children.length) {
                visit(children[index]);
                index++;
            }
            return;
        }

        if (node.tagName && LINE_BREAK_TAGS.has(node.tagName.toUpperCase())) {
            raw += "\n";
            return;
        }
        if (!children) return;
        for (let i = 0; i < children.length; i++) {
            visit(children[i]);
        }
    };

    visit(block);
    if (rawCaret === -1) return null;

    const collapsed = collapseWhitespace(raw, rawCaret);
    return { text: collapsed.text, caret: collapsed.index };
}

export interface SelectionHint {
    /** 0-based index of the selected occurrence among all of them in the block. */
    ordinal: number;
    /** How many times the snippet occurs in the block's rendered text. */
    total: number;
    /** Caret offset within the block's rendered text, for approximate fallback. */
    caret: number;
}

/**
 * Given a block's rendered text, the caret offset inside it, and the selected
 * snippet, work out which occurrence of the snippet the caret is sitting on.
 *
 * Matching is case-INsensitive and non-overlapping, to mirror the source-side
 * matcher: it treats `Foundry` as a hit for `foundry`, so counting
 * case-sensitively here would number the occurrences differently from the
 * candidate list and select the wrong one. The caret is resolved to the nearest
 * occurrence rather than an exact hit, so small drift still lands correctly.
 */
export function computeOccurrenceOrdinal(blockText: string, caret: number, snippet: string): SelectionHint | null {
    const needle = collapseWhitespace(snippet || "", 0).text.toLocaleLowerCase();
    if (!needle || !blockText) return null;
    const haystack = blockText.toLocaleLowerCase();

    const positions: number[] = [];
    let from = 0;
    for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        positions.push(at);
        from = at + needle.length;
    }
    if (positions.length === 0) return null;

    let best = 0;
    let bestDistance = Math.abs(positions[0] - caret);
    for (let i = 1; i < positions.length; i++) {
        const distance = Math.abs(positions[i] - caret);
        if (distance < bestDistance) {
            best = i;
            bestDistance = distance;
        }
    }
    return { ordinal: best, total: positions.length, caret };
}

/**
 * Convenience wrapper: block element + range + snippet → occurrence ordinal.
 * Returns null whenever the ordinal cannot be established, so callers keep the
 * previous behaviour instead of guessing.
 */
export function getSelectedOccurrence(
    block: NodeLike | null,
    range: RangeLike | null,
    snippet: string
): SelectionHint | null {
    const read = readBlockTextAndCaret(block, range);
    if (!read) return null;
    return computeOccurrenceOrdinal(read.text, read.caret, snippet);
}
