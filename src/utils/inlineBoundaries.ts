// Selecting part of a bold, italic, struck-through or code span makes the
// auto-expansion step absorb a delimiter that sits next to the selection. When
// only one of the pair is absorbed, wrapping the content in `==` splits the
// pair across the highlight: `**one two**` with `one` selected would become
// `==**one== two**`, and neither the bold nor the highlight renders.
//
// An unpaired delimiter belongs outside the highlight, so the bold encloses it
// (`**==one== two**`). A pair that was absorbed whole, as in `**one**` with the
// whole word selected, stays inside: `==**one**==` renders correctly.

// Longest first, so `**` is read as one token rather than two `*`.
const DELIMITERS = ["**", "~~", "`", "*", "_"] as const;

const TOKEN = /\*\*|~~|`|\*|_/g;

export interface InlineBoundaries {
    leading: string;
    core: string;
    trailing: string;
}

function tokens(text: string): { value: string; start: number; end: number }[] {
    return [...text.matchAll(TOKEN)].map((m) => ({ value: m[0], start: m.index, end: m.index + m[0].length }));
}

/**
 * Split `content` into the delimiters at its edges that have no partner inside
 * it, and the rest. A delimiter is only peeled when it is unpaired, so a
 * balanced span is returned whole.
 */
export function extractInlineBoundaries(content: string): InlineBoundaries {
    let core = content;
    let leading = "";
    let trailing = "";

    let peeled = true;
    while (peeled) {
        peeled = false;
        const found = tokens(core);
        if (found.length === 0) break;
        const first = found[0];
        const last = found[found.length - 1];
        const atStart = first.start === 0 ? first.value : null;
        const atEnd = last.end === core.length ? last.value : null;
        // A delimiter is unpaired when it occurs an odd number of times. When
        // both edges carry it the count is even, so nothing is peeled.
        for (const delimiter of DELIMITERS) {
            if (found.filter((t) => t.value === delimiter).length % 2 === 0) continue;
            if (atStart === delimiter && core.length > delimiter.length) {
                leading += delimiter;
                core = core.slice(delimiter.length);
                peeled = true;
                break;
            }
            if (atEnd === delimiter && core.length > delimiter.length) {
                trailing = delimiter + trailing;
                core = core.slice(0, core.length - delimiter.length);
                peeled = true;
                break;
            }
        }
    }

    if (!core.trim()) return { leading: "", core: content, trailing: "" };
    return { leading, core, trailing };
}
