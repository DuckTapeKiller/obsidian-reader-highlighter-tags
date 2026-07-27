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
    while (expanded) {
        expanded = false;
        const preceding = raw.substring(0, expandedStart);
        const matchBack = preceding.match(/(<mark[^>]*>|\*\*|==|~~|\*|_|\[\[|\[\^[^\]]+\]:?\s?|[([{"'«“‘‹])$/);
        if (matchBack && expandedStart > bodyStart) {
            const hit = matchBack[0];
            // ponytail: if the hit is a paired inline delimiter AND the same
            // delimiter exists AFTER the selection but is NOT immediately
            // adjacent to it, the selection is in the middle of a formatted
            // span — the closing delimiter belongs to a pair that wraps the
            // selection. Don't absorb; leave the selection as-is so the wrap
            // step applies the highlight to just the selected text and the
            // surrounding `**…**` / `==…==` stays in the source line. If the
            // same delimiter IS immediately adjacent (i.e. the selection
            // ends right at the closing delimiter), the user selected the
            // whole span — absorb as before.
            //
            // ponytail: an UNRELATED `==` / `**` earlier in the document
            // (e.g. another highlight on a different line) must NOT trigger
            // the guard. The guard only fires when the same delimiter is
            // present on the other side AND is NOT immediately adjacent to
            // the selection — that pattern is unique to a span whose
            // opening is before the selection and whose closing is past the
            // selection (the substring case). When the closing is
            // immediately adjacent (e.g. the user selected the whole
            // `==x==` pair minus markers, or is removing an existing
            // highlight that sits flush against the selection), the guard
            // is skipped and the matchForward absorbs the closing too.
            const after = raw.substring(expandedEnd);
            const sameDelimOnOtherSide = PAIRED_DELIMS.has(hit) && after.includes(hit) && !after.startsWith(hit);
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
            // ponytail: same symmetric check on the forward side. If the hit
            // is a paired inline delimiter AND the same delimiter exists
            // BEFORE the selection but is NOT immediately adjacent to it,
            // the selection is in the middle of a formatted span. Don't
            // absorb the closing delimiter — the `:` (or whatever trailing
            // punct would have been absorbed next) stays in the source line
            // outside the highlight. If the same delimiter IS immediately
            // adjacent on the leading side, the user selected the whole
            // span — absorb as before.
            //
            // ponytail: the check must be scoped to the CURRENT formatted
            // span, not the whole document. If matchBack just absorbed the
            // opening of a pair (i.e. the chars at expandedStart are the
            // same delimiter), the closing seen by matchForward is the
            // closing of THAT pair — the wrap step will strip both. Without
            // this scope, an unrelated `==` highlight earlier in the
            // document (the cervical-cancer note has dozens) would falsely
            // satisfy `before.includes("==")` and block absorption of the
            // closing `==` of the highlight the user is actually removing.
            const matchBackAbsorbedSameDelim =
                raw.substring(expandedStart, expandedStart + hit.length) === hit;
            const before = raw.substring(bodyStart, expandedStart);
            const sameDelimOnOtherSide =
                !matchBackAbsorbedSameDelim &&
                PAIRED_DELIMS.has(hit) &&
                before.includes(hit) &&
                !before.endsWith(hit);
            if (!sameDelimOnOtherSide) {
                expandedEnd += hit.length;
                expanded = true;
            }
        }
    }
    return { start: expandedStart, end: expandedEnd };
}
