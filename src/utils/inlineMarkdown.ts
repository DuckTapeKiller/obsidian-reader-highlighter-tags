// Where a highlight's `==` markers can go without changing how the rest of the
// line renders.
//
// Highlighting part of a bold, italic or struck-through span, or a selection
// that runs into or out of one, must keep each `**`, `*`, `_` or `~~` with its
// partner. `**one two**` with `one` selected becomes `**==one== two**`, and
// `novela *Pablo y Virginia*` with `novela Pablo` selected becomes
// `==novela== *==Pablo== y Virginia*`. A character that only looks like a
// delimiter — the `_` in `snake_case`, the `*` in `2 * 3` — is plain text and
// is left where it is.
//
// Telling the two apart needs the renderer's rules, so the pairing below
// follows CommonMark: delimiter runs, left- and right-flanking, the stricter
// rules for `_`, the rule of three, and strikethrough and highlight runs that
// pair only with a run of equal length. Obsidian departs from CommonMark when
// a delimiter is left without a partner, so a line holding one is written the
// way earlier versions wrote it rather than guessed at.
//
// Code spans, links, wikilinks, URLs, math, tags, comments, footnotes and
// escapes never delimit anything, and a highlight never starts or ends inside
// one: a marker there would show as text.

import { highlightMarkerPairs } from "./colors";

export interface DelimiterPair {
    char: string;
    /** Half-open character range of the opening delimiter. */
    open: [number, number];
    /** Half-open character range of the closing delimiter. */
    close: [number, number];
}

interface Run {
    char: string;
    start: number;
    end: number;
    length: number;
    originalLength: number;
    canOpen: boolean;
    canClose: boolean;
    active: boolean;
    scope: number;
}

interface Scan {
    /** Characters that cannot be delimiters. */
    opaque: boolean[];
    /** The text of each Markdown link is a scope of its own. */
    scope: number[];
    /** Constructs a highlight must cover whole or not at all. */
    atoms: [number, number][];
    /** The syntax of each Markdown link: its `[` and its `](destination)`. */
    links: { start: number; textStart: number; textEnd: number; end: number }[];
    /** Square brackets that are not a link, as pairs of positions. */
    brackets: [number, number][];
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const DELIMITER_CHARS = new Set(["*", "_", "~", "="]);

const isSpace = (ch: string | undefined) => ch === undefined || WHITESPACE.test(ch);
const isPunct = (ch: string | undefined) => ch !== undefined && PUNCTUATION.test(ch);

function scan(text: string, paired: Iterable<number> = []): Scan {
    const n = text.length;
    const opaque: boolean[] = new Array<boolean>(n).fill(false);
    // Delimiters already paired with a partner on another line of the
    // paragraph are not looked at again here.
    for (const k of paired) if (k >= 0 && k < n) opaque[k] = true;
    const scope: number[] = new Array<number>(n).fill(0);
    const atoms: [number, number][] = [];
    const atom = (from: number, to: number) => {
        for (let k = from; k < to && k < n; k++) opaque[k] = true;
        atoms.push([from, Math.min(to, n)]);
    };

    // Escapes and code spans, left to right: a backslash stops a backtick from
    // opening a code span, and nothing inside a code span is an escape.
    let i = 0;
    while (i < n) {
        const ch = text[i];
        if (ch === "\\" && i + 1 < n && ESCAPABLE.test(text[i + 1])) {
            atom(i, i + 2);
            i += 2;
            continue;
        }
        if (ch === "`") {
            let runEnd = i;
            while (runEnd < n && text[runEnd] === "`") runEnd++;
            const length = runEnd - i;
            let close = -1;
            let j = runEnd;
            while (j < n) {
                if (text[j] === "`") {
                    let k = j;
                    while (k < n && text[k] === "`") k++;
                    if (k - j === length) {
                        close = j;
                        break;
                    }
                    j = k;
                } else {
                    j++;
                }
            }
            if (close >= 0) {
                atom(i, close + length);
                i = close + length;
            } else {
                // An unmatched run of backticks is plain text.
                for (let k = i; k < runEnd; k++) opaque[k] = true;
                i = runEnd;
            }
            continue;
        }
        i++;
    }

    const mark = (pattern: RegExp, group = 0) => {
        for (const m of text.matchAll(pattern)) {
            const start = m.index + (group ? m[0].indexOf(m[group]) : 0);
            const length = group ? m[group].length : m[0].length;
            if (opaque[start]) continue;
            atom(start, start + length);
        }
    };
    mark(/!?\[\[(?:[^\]\n]|\](?!\]))*\]\]/g); // wikilinks and embeds, up to the first ]]
    mark(/%%[\s\S]*?%%/g); // comments
    mark(/!\[[^\]\n]*\]\([^)\n]*\)/g); // images
    mark(/<[A-Za-z/!][^<>\n]*>/g); // HTML tags and autolinks
    mark(/\bhttps?:\/\/[^\s<>()]+/g); // bare URLs
    mark(/\[\^[^\]\n]+\]/g); // footnote references
    mark(/\$\$[^$]+\$\$/g); // display math on one line
    // Inline math. As in Obsidian, a closing `$` followed by a digit closes
    // nothing: `US$624,000 or US$6.75` is plain text.
    mark(/\$(?=\S)[^$\n]*\S\$(?!\d)|\$\S\$(?!\d)/g);
    mark(/(?:^|\s)(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, 1); // tags
    mark(/\s\^[A-Za-z0-9-]+$/g); // block ID

    // Markdown links: the destination is opaque and the text is a scope of its
    // own.
    const links: Scan["links"] = [];
    let scopeId = 0;
    for (const m of text.matchAll(/\[([^\]\n]*)\]\(([^)\n]*)\)/g)) {
        if (opaque[m.index]) continue;
        scopeId++;
        const textStart = m.index + 1;
        const textEnd = textStart + m[1].length;
        const end = m.index + m[0].length;
        for (let k = textStart; k < textEnd; k++) scope[k] = scopeId;
        opaque[m.index] = true;
        for (let k = textEnd; k < end; k++) opaque[k] = true;
        atoms.push([textEnd, end]);
        links.push({ start: m.index, textStart, textEnd, end });
    }

    // Other square brackets, paired innermost first. The renderer reads
    // `[...]` as a possible link before it reads emphasis or highlights, so
    // a marker cannot pair across one.
    const brackets: [number, number][] = [];
    const stack: number[] = [];
    for (let k = 0; k < n; k++) {
        if (opaque[k]) continue;
        if (text[k] === "[") stack.push(k);
        else if (text[k] === "]") {
            const open = stack.pop();
            if (open !== undefined) brackets.push([open, k]);
        }
    }

    return { opaque, scope, atoms, links, brackets };
}

function delimiterRuns(text: string, opaque: boolean[], scope: number[]): Run[] {
    const runs: Run[] = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (opaque[i] || !DELIMITER_CHARS.has(ch)) {
            i++;
            continue;
        }
        let end = i;
        while (end < text.length && text[end] === ch && !opaque[end] && scope[end] === scope[i]) end++;
        const before = text[i - 1];
        const after = text[end];
        const leftFlanking = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
        const rightFlanking = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
        let canOpen = leftFlanking;
        let canClose = rightFlanking;
        if (ch === "_") {
            canOpen = leftFlanking && (!rightFlanking || isPunct(before));
            canClose = rightFlanking && (!leftFlanking || isPunct(after));
        }
        const length = end - i;
        // `~~` strikes through and `==` highlights; a run of any other length
        // of those characters is plain text.
        if ((ch === "~" || ch === "=") && length !== 2) {
            canOpen = false;
            canClose = false;
        }
        runs.push({
            char: ch,
            start: i,
            end,
            length,
            originalLength: length,
            canOpen,
            canClose,
            active: true,
            scope: scope[i],
        });
        i = end;
    }
    return runs;
}

function analyse(text: string, scanned: Scan = scan(text)): { pairs: DelimiterPair[]; unpaired: boolean } {
    const runs = delimiterRuns(text, scanned.opaque, scanned.scope);
    const pairs: DelimiterPair[] = [];

    for (let ci = 0; ci < runs.length; ci++) {
        const closer = runs[ci];
        if (!closer.canClose) continue;
        while (closer.length > 0) {
            let found = -1;
            for (let oi = ci - 1; oi >= 0; oi--) {
                const opener = runs[oi];
                if (!opener.active || opener.length === 0 || !opener.canOpen) continue;
                if (opener.char !== closer.char || opener.scope !== closer.scope) continue;
                if (closer.char === "*" || closer.char === "_") {
                    const both = opener.canClose || closer.canOpen;
                    const sum = opener.originalLength + closer.originalLength;
                    if (
                        both &&
                        sum % 3 === 0 &&
                        !(opener.originalLength % 3 === 0 && closer.originalLength % 3 === 0)
                    ) {
                        continue;
                    }
                } else if (opener.length !== closer.length) {
                    continue;
                }
                found = oi;
                break;
            }
            if (found < 0) break;
            const opener = runs[found];
            const use =
                closer.char === "*" || closer.char === "_"
                    ? opener.length >= 2 && closer.length >= 2
                        ? 2
                        : 1
                    : closer.length;
            pairs.push({
                char: closer.char,
                open: [opener.end - use, opener.end],
                close: [closer.start, closer.start + use],
            });
            opener.end -= use;
            opener.length -= use;
            closer.start += use;
            closer.length -= use;
            for (let k = found + 1; k < ci; k++) runs[k].active = false;
        }
    }
    const unpaired = runs.some((run) => run.length > 0 && (run.canOpen || run.canClose));
    return { pairs, unpaired };
}

/**
 * The delimiter pairs rendered as bold, italic, strikethrough or highlight in
 * `text`, in the order they close.
 */
export function emphasisPairs(text: string): DelimiterPair[] {
    return analyse(text).pairs;
}

/**
 * Whether `text` has a delimiter that could open or close but found no
 * partner. Obsidian resolves those differently from CommonMark — it reads
 * `**Note. The *Times*, the *Guardian*` as one italic span starting at the
 * second `*` — so where one is present, which delimiters pair cannot be known
 * here.
 */
export function hasUnpairedDelimiter(text: string, paired: Iterable<number> = []): boolean {
    return analyse(text, scan(text, paired)).unpaired;
}

/**
 * The stretches of `[start, end)` in `line` to wrap in `==`.
 *
 * Anything that pairs with a partner outside the selection — a delimiter, a
 * square bracket, a link's syntax — is left out, splitting the highlight
 * around it, so every pair stays wholly inside one highlight or wholly
 * outside. A stretch never starts or ends inside a code span, escape, URL or
 * the like: it takes the construct whole, or leaves it out where it reaches
 * past the selection. Whitespace at either end of a stretch stays outside its
 * markers. When the selection holds words, stretches left with only
 * punctuation — a `),` taken in after a closing `*` — are dropped.
 */
export function highlightSegments(line: string, start: number, end: number, paired: number[] = []): [number, number][] {
    const scanned = scan(line, paired);
    const { pairs } = analyse(line, scanned);
    const cut = new Set<number>(paired.filter((k) => k >= start && k < end));
    const cutPartial = (from: number, to: number, parts: [number, number][]) => {
        const overlaps = from < end && to > start;
        const contains = start <= from && to <= end;
        if (!overlaps || contains) return;
        for (const [a, b] of parts) {
            for (let k = a; k < b; k++) if (k >= start && k < end) cut.add(k);
        }
    };
    for (const pair of pairs) cutPartial(pair.open[0], pair.close[1], [pair.open, pair.close]);
    for (const [open, close] of scanned.brackets) {
        cutPartial(open, close + 1, [
            [open, open + 1],
            [close, close + 1],
        ]);
    }
    for (const link of scanned.links) {
        // A selection inside the link's text is fine as it is.
        if (start >= link.textStart && end <= link.textEnd) continue;
        cutPartial(link.start, link.end, [
            [link.start, link.textStart],
            [link.textEnd, link.end],
        ]);
    }

    let segments: [number, number][] = [];
    let i = start;
    while (i < end) {
        if (cut.has(i)) {
            i++;
            continue;
        }
        let j = i;
        while (j < end && !cut.has(j)) j++;
        let a = i;
        let b = j;
        // Never start or end inside a construct that has to stay whole: take
        // it in when it lies within the selection, leave it out when it
        // reaches past it.
        for (const [x, y] of scanned.atoms) {
            if (x < a && a < y) a = x >= start ? x : y;
            if (x < b && b < y) b = y <= end ? y : x;
        }
        while (a < b && WHITESPACE.test(line[a])) a++;
        while (b > a && WHITESPACE.test(line[b - 1])) b--;
        if (a < b) segments.push([a, b]);
        i = j;
    }

    // Widening can make neighbours touch; join them.
    segments.sort((x, y) => x[0] - y[0]);
    const joined: [number, number][] = [];
    for (const s of segments) {
        const last = joined[joined.length - 1];
        if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
        else joined.push([s[0], s[1]]);
    }
    segments = joined;

    const hasWord = (s: [number, number]) => WORD.test(line.slice(s[0], s[1]));
    if (segments.some(hasWord)) return segments.filter(hasWord);
    return segments;
}

/**
 * Write `line` with each of `segments` wrapped in `open` and `close`, and
 * `insert`, if any, written at its position. `valid` says whether every pair
 * of the original still pairs with the same partner, and each new pair of
 * markers with its own, read by the rules above.
 */
export function applySegments(
    line: string,
    segments: [number, number][],
    open: string,
    close: string,
    insert: { at: number; text: string } | null = null
): { text: string; valid: boolean; inserted: number[]; origin: number[] } {
    // Build the output with a map from each output character to the original
    // character it came from, or to the marker it belongs to. Text inserted at
    // a position goes before a marker opening there.
    const events: { at: number; text: string; marker: number }[] = [];
    if (insert?.text) events.push({ at: insert.at, text: insert.text, marker: -1 });
    segments.forEach(([a, b], index) => {
        events.push({ at: a, text: open, marker: index * 2 });
        events.push({ at: b, text: close, marker: index * 2 + 1 });
    });
    events.sort((x, y) => x.at - y.at || (x.marker === -1 ? -1 : y.marker === -1 ? 1 : 0));

    let out = "";
    const origin: number[] = [];
    const markerOf: number[] = [];
    const push = (text: string, from: number, marker: number) => {
        for (let k = 0; k < text.length; k++) {
            out += text[k];
            origin.push(from >= 0 ? from + k : -1);
            markerOf.push(marker);
        }
    };
    let cursor = 0;
    for (const event of events) {
        push(line.slice(cursor, event.at), cursor, -1);
        push(event.text, -1, event.marker);
        cursor = event.at;
    }
    push(line.slice(cursor), cursor, -1);
    // Where each marker written here starts in the output.
    const inserted: number[] = [];
    for (let k = 0; k < out.length; k++) {
        if (markerOf[k] >= 0 && markerOf[k] !== markerOf[k - 1] && out.startsWith("==", k)) inserted.push(k);
    }
    return {
        text: out,
        valid: pairsPreserved(line, out, origin, markerOf, segments.length),
        inserted,
        origin,
    };
}

function pairsPreserved(line: string, out: string, origin: number[], markerOf: number[], count: number): boolean {
    const before = emphasisPairs(line);
    const after = emphasisPairs(out);
    if (after.length !== before.length + count) return false;

    const key = (p: DelimiterPair) => `${p.char}:${p.open[0]}:${p.open[1]}:${p.close[0]}:${p.close[1]}`;
    const expected = new Set(before.map(key));
    let markers = 0;
    for (const pair of after) {
        const o = [origin[pair.open[0]], origin[pair.open[1] - 1], origin[pair.close[0]], origin[pair.close[1] - 1]];
        if (o.every((x) => x >= 0)) {
            const mapped = key({ char: pair.char, open: [o[0], o[1] + 1], close: [o[2], o[3] + 1] });
            if (!expected.delete(mapped)) return false;
            continue;
        }
        // A new pair must be one of the markers written here, opener with its
        // own closer.
        const m = markerOf[pair.open[0]];
        if (pair.char !== "=" || m < 0 || m % 2 !== 0 || markerOf[pair.open[1] - 1] !== m) return false;
        if (markerOf[pair.close[0]] !== m + 1 || markerOf[pair.close[1] - 1] !== m + 1) return false;
        markers++;
    }
    return expected.size === 0 && markers === count;
}

/**
 * Escape any `==` already in the line that would pair with a marker written
 * here. A `==` with no partner is plain text, but Obsidian pairs it with the
 * next marker it can: `a ==b == c and ==more==` highlights from `b` to
 * `more`. `\==` reads the same and cannot pair. A highlight that was already
 * in the line is never touched.
 */
function protectMarkers(line: string, result: { text: string; inserted: number[]; origin: number[] }): string {
    const real = new Set(highlightMarkerPairs(line).flatMap((pair) => [pair.open, pair.close]));
    let text = result.text;
    let inserted = new Set(result.inserted);
    const origin = [...result.origin];
    for (let guard = 0; guard < 20; guard++) {
        const mixed = highlightMarkerPairs(text).find((pair) => inserted.has(pair.open) !== inserted.has(pair.close));
        if (!mixed) break;
        const stray = inserted.has(mixed.open) ? mixed.close : mixed.open;
        if (origin[stray] < 0 || real.has(origin[stray])) break;
        text = `${text.slice(0, stray)}\\${text.slice(stray)}`;
        origin.splice(stray, 0, -1);
        inserted = new Set([...inserted].map((k) => (k >= stray ? k + 1 : k)));
    }
    return text;
}

/**
 * Highlight `[start, end)` of `line`, with `insert` (a tag) written at
 * `start`. Returns the whole line rewritten.
 *
 * The highlight is split around anything that pairs outside the selection.
 * The whole stretch is wrapped instead, as earlier versions did, where the
 * split would still change how the line renders, where the line holds a
 * delimiter without a partner, or where `whole` is set: an edge of the
 * selection is an existing highlight's marker, just removed, and a new one has
 * to go back exactly there or the text on either side would run together.
 *
 * `crossLine` holds the delimiters of the line whose partner is on another
 * line of the same paragraph — an italic poem spanning its lines. They stay
 * outside the highlight, so the span still pairs.
 */
export function highlightInLine(
    line: string,
    start: number,
    end: number,
    open: string,
    insert: string,
    whole = false,
    crossLine: number[] = []
): string {
    const outside = new Set(crossLine);
    while (start < end && (outside.has(start) || WHITESPACE.test(line[start]))) start++;
    while (end > start && (outside.has(end - 1) || WHITESPACE.test(line[end - 1]))) end--;
    if (start >= end) return line;
    // The tag goes where the selection starts, but never inside an escape or
    // a code span, where it would be read as part of it.
    let at = start;
    for (const [x, y] of scan(line).atoms) if (x < at && at < y && y <= end) at = y;
    const tag = insert ? { at, text: insert } : null;
    const wrapAll = () => applySegments(line, [[start, end]], open, "==", tag);
    const chosen = (() => {
        // Where Obsidian's pairing cannot be known, write what earlier
        // versions wrote rather than guess.
        if (whole || hasUnpairedDelimiter(line, crossLine)) return wrapAll();
        const segments = highlightSegments(line, start, end, crossLine);
        if (segments.length === 0) return wrapAll();
        const split = applySegments(line, segments, open, "==", tag);
        if (split.valid) return split;
        const fallback = wrapAll();
        return fallback.valid ? fallback : split;
    })();
    return protectMarkers(line, chosen);
}
