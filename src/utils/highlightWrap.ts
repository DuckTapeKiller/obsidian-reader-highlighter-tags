/**
 * Peel a single inline-formatting delimiter off one end of `content` so
 * the highlight wrapper can sit *inside* the delimiter rather than
 * around it. Prevents the bug where the auto-expansion absorbs a lone
 * `**` (or other delimiter) at one boundary, the other delimiter stays
 * stranded in the line, and the wrap step splits the pair across the
 * `==` boundary (e.g. `**one two three**` + select `one` →
 * `==**one== two three**` instead of `**==one== two three**`).
 *
 * Priority order: `**` > `~~` > `` ` `` > `*` > `_` (longer first, so
 * a bold wrapper isn't mistaken for an italic one). The symmetric case
 * (same delimiter on both ends) returns empty boundaries — the current
 * `==**x**==` output renders correctly and is intentionally left alone.
 * Known limitation: nested spans like `***triple***` are not handled
 * specially; the first-priority match wins.
 */
export function extractInlineBoundaries(content: string): { leading: string; core: string; trailing: string } {
    const delimiters = ["**", "~~", "`", "*", "_"];
    const text = String(content ?? "");

    let leading = "";
    for (const d of delimiters) {
        if (text.startsWith(d) && text.length > d.length) {
            leading = d;
            break;
        }
    }
    let trailing = "";
    for (const d of delimiters) {
        if (text.endsWith(d) && text.length > d.length) {
            trailing = d;
            break;
        }
    }

    if (leading) {
        // Symmetric case: leading and trailing delimiters of the same pair
        // both sit at the string ends — leave the full span alone so the
        // wrap renders as `==**x**==` (the working case).
        if (text.endsWith(leading)) {
            return { leading: "", core: text, trailing: "" };
        }
        // Paired case: the leading delimiter's matching closing delimiter
        // is buried somewhere in the rest of the text (e.g. `**foo**,`).
        // Peel both, and let everything after the closing delimiter stay
        // in the trailing slot so trailing punctuation lands outside the
        // highlight wrapper.
        const afterLeading = text.slice(leading.length);
        const closeIdx = afterLeading.indexOf(leading);
        if (closeIdx !== -1) {
            const core = afterLeading.slice(0, closeIdx);
            const trailing = leading + afterLeading.slice(closeIdx + leading.length);
            return { leading, core, trailing };
        }
        // No matching closing delimiter found — peel only the leading one.
        return { leading, core: afterLeading, trailing: "" };
    }
    if (trailing) {
        return { leading: "", core: text.slice(0, text.length - trailing.length), trailing };
    }
    return { leading: "", core: text, trailing: "" };
}
