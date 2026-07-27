/**
 * Walk the selection outward and absorb adjacent inline-formatting
 * delimiters, markdown markers, brackets, quotes, footnote markers,
 * and trailing punctuation. Used by `applyMarkdownModification` to
 * expand the selection to the surrounding "interesting" characters
 * so the wrap pass doesn't leave stranded delimiters.
 *
 * Pure function — no `obsidian` runtime dependencies, so it can be
 * unit-tested directly from Node.
 */
const PAIRED_DELIMS = new Set(["**", "==", "~~", "`", "*", "_"]);

export function autoExpandSelection(
    raw: string,
    start: number,
    end: number,
    bodyStart: number
): { start: number; end: number } {
    let expandedStart = start;
    let expandedEnd = end;
    let expanded = true;
    // ponytail: scope the "same delim on other side" guards to the CURRENT
    // LINE, not the whole document. The previous implementation used
    // `raw.substring(expandedEnd)` which spans the rest of the file — a
    // `**` on a later line (e.g. the next bullet's lead-in) would falsely
    // satisfy the guard and block the matchBack absorption of THIS line's
    // leading `**`. Bug: triple-tap on `- **Bold lead-in**: rest...` when
    // the next line also starts with `- **...` — the guard saw `**` in
    // `after` and thought the selection was in the middle of a formatted
    // span, so it never absorbed the leading `**`, and the wrap step
    // produced a broken shape. The guard must only fire when the same
    // delimiter is on the SAME line as the selection.
    const lineEndFor = (offset: number): number => {
        const nl = raw.indexOf("\n", offset);
        return nl === -1 ? raw.length : nl;
    };
    const lineStartFor = (offset: number): number => {
        // search backward for the previous newline, starting at offset-1
        // so an offset sitting on a newline returns the line AFTER it
        const start = Math.max(bodyStart, offset - 1);
        const prevNl = raw.lastIndexOf("\n", start);
        return prevNl === -1 ? bodyStart : prevNl + 1;
    };
    while (expanded) {
        expanded = false;
        const preceding = raw.substring(0, expandedStart);
        const matchBack = preceding.match(/(<mark[^>]*>|\*\*|==|~~|\*|_|\[\[|\[\^[^\]]+\]:?\s?|[([{"'«“‘‹])$/);
        if (matchBack && expandedStart > bodyStart) {
            const hit = matchBack[0];
            // ponytail: if the hit is a paired inline delimiter AND the same
            // delimiter exists AFTER the selection on the SAME LINE but is
            // NOT immediately adjacent to it, the selection is in the
            // middle of a formatted span — the closing delimiter belongs
            // to a pair that wraps the selection. Don't absorb; leave the
            // selection as-is. If the same delimiter IS immediately
            // adjacent (i.e. the selection ends right at the closing
            // delimiter), the user selected the whole span — absorb as
            // before.
            const afterOnLine = raw.substring(expandedEnd, lineEndFor(expandedEnd));
            const sameDelimOnOtherSide =
                PAIRED_DELIMS.has(hit) && afterOnLine.includes(hit) && !afterOnLine.startsWith(hit);
            if (!sameDelimOnOtherSide) {
                const newStart = expandedStart - hit.length;
                if (newStart >= bodyStart) {
                    expandedStart = newStart;
                    expanded = true;
                }
            }
        }
        const following = raw.substring(expandedEnd);
        // Expanded to include balanced punctuation, quotes (including « »), and footnotes
        const matchForward = following.match(
            /^(<\/mark>|\*\*|==|~~|\*|_|\]\]|\]\([^)]+\)|\[\^[^\]]+\]|[.?!,;:]["']?|[)\]}"'»”’›.?!,;:](\s|$)?)/
        );
        if (matchForward) {
            const hit = matchForward[0];
            // ponytail: same symmetric check on the forward side, scoped to
            // the SAME LINE. If the hit is a paired inline delimiter AND
            // the same delimiter exists BEFORE the selection on the same
            // line but is NOT immediately adjacent to it, the selection is
            // in the middle of a formatted span. Don't absorb. If the same
            // delimiter IS immediately adjacent on the leading side, the
            // user selected the whole span — absorb as before.
            //
            // ponytail: if matchBack just absorbed the opening of a pair
            // (i.e. the chars at expandedStart are the same delimiter),
            // the closing seen by matchForward is the closing of THAT pair
            // — the wrap step will strip both. Skip the guard so the
            // matchForward absorbs the closing too.
            const matchBackAbsorbedSameDelim =
                raw.substring(expandedStart, expandedStart + hit.length) === hit;
            const beforeOnLine = raw.substring(lineStartFor(expandedStart), expandedStart);
            const sameDelimOnOtherSide =
                !matchBackAbsorbedSameDelim &&
                PAIRED_DELIMS.has(hit) &&
                beforeOnLine.includes(hit) &&
                !beforeOnLine.endsWith(hit);
            if (!sameDelimOnOtherSide) {
                expandedEnd += hit.length;
                expanded = true;
            }
        }
    }
    return { start: expandedStart, end: expandedEnd };
}
