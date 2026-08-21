import { App, TFile, MarkdownView } from "obsidian";
import { BlockKind, SourceBlock, splitSourceBlocks, findBlockAt } from "../utils/sourceBlocks";
import type { SelectionHint } from "../utils/blockOccurrence";

interface LearnedRule {
    stripPattern?: string;
}

interface Segment {
    vStart: number;
    vEnd: number;
    file: TFile;
    pOffset: number;
}

interface Virtual {
    text: string;
    segments: Segment[];
}

interface OpContext {
    cache: Map<string, Virtual>;
    visited: Set<string>;
}

interface Candidate {
    start: number;
    end: number;
    text?: string;
    score?: number;
}

interface RegexResult {
    index: number;
    length: number;
    text: string;
}

interface OffsetRange {
    start: number;
    end: number;
}

interface LineRecord {
    raw: string;
    start: number;
    end: number;
    compare: string;
    skippable: boolean;
}

interface MarkdownLineParts {
    indent: string;
    prefix: string;
    content: string;
}

interface FuzzyMap {
    normalized: string;
    map: number[];
}

interface StrategyInfo {
    tried: boolean;
    found?: number;
    reason?: string;
    results?: Candidate[];
}

interface Diagnostics {
    strategies: Record<string, StrategyInfo>;
}

interface FailureReport {
    type: string;
    reason: string;
    hint: string;
    rawSnippet: string;
    cleanedSnippet: string;
    diagnostics: Diagnostics;
    bestGuessContext: string;
}

interface PhysicalResult {
    file: TFile;
    start: number;
    end: number;
    raw: string;
}

const BLOCK_LEVEL_TAGS_FOR_SPLIT = new Set([
    "P",
    "LI",
    "BLOCKQUOTE",
    "PRE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "TD",
    "TH",
]);

// Inline "noise" tokens that may exist in source Markdown but not in Reading view selections.
// Keep this list conservative to avoid over-matching visible content (e.g., inside code blocks).
const INLINE_DECORATION_PATTERN =
    "<mark[^>]*>|<\\/mark>|==|\\*\\*|~~|\\*|_|`|\\[\\[|\\]\\]|\\[|\\]|\\$|\\^\\[[^\\]]+\\]|\\^[a-zA-Z0-9-]+|%%[^%]*%%|\\^|\\\\|\\{|\\}|\\||\\d|<sub>|<sup>|<\\/sub>|<\\/sup>";
const GAP_PATTERN = "[\\s\\u00a0\\u1680\\u2000-\\u200b\\u202f\\u205f\\u3000\\u21a9\\u21b5\\ufe0e\\ufe0f]";
// Additional single-character gaps that can exist in Markdown source but are often invisible in Reading view.
// Keep this as a character class (not a long alternation) for performance.
const EXTRA_GAP_CHARS_PATTERN = "[-\\u2010-\\u2015\"'“”‘’«»\\\\|>#*_~=$^{}()\\[\\]`]";
const FLEX_GAP_ATOMIC_PATTERN = `(?:${GAP_PATTERN}|${EXTRA_GAP_CHARS_PATTERN})`;
// Allow skipping footnote reference tokens when the browser selection omits them.
const FOOTNOTE_REF_TOKEN_PATTERN = "\\[\\^[^\\]]+\\]";
const INLINE_FOOTNOTE_TOKEN_PATTERN = "\\^\\[[^\\]]+\\]";
const FLEX_WORD_GAP_PATTERN = `(?:${FOOTNOTE_REF_TOKEN_PATTERN}|${INLINE_FOOTNOTE_TOKEN_PATTERN}|${FLEX_GAP_ATOMIC_PATTERN}){1,40}`;
// Inline formatting markers that may appear between adjacent visible characters (e.g., *d*a...).
// Intentionally excludes whitespace to reduce backtracking and accidental cross-word matching.
// Include math delimiters like `$` because they can appear adjacent to punctuation in source.
const FLEX_INTER_CHAR_GAP_PATTERN = "(?:[\\*_|~=`\\\\$]){0,3}";
const OPTIONAL_MARKDOWN_LINE_PREFIX = `[ \\t]{0,3}(?:(?:>\\s*)*)(?:#{1,6}[ \\t]+|-\\s\\[[ xX]\\][ \\t]+|[-*+][ \\t]+|\\d{1,3}[.)][ \\t]+|\\[\\^[^\\]]+\\]:[ \\t]*|>\\[![^\\]]+\\][ \\t]*)?(?:(?:${INLINE_DECORATION_PATTERN})){0,3}[ \\t]*`;
const MARKDOWN_PREFIX_ONLY_RE =
    /^[ \t]*(?:(?:>\s*)+|#{1,6}[ \t]*|-\s\[[ xX]\][ \t]*|[-*+][ \t]*|\d{1,3}[.)][ \t]*|\[\^[^\]]+\]:[ \t]*|>\s*\[![^\]]+\][ \t]*)+$/;
// NOTE: Avoid stripping named footnote references and caret-exponents here.
// Those are handled by the Structural Filter (for source) and should be literal-matchable when present.
const INLINE_DECORATION_RE =
    /<mark[^>]*>|<\/mark>|%%[^%]*%%|==|\*\*|~~|\*|_|`|\[\[|\]\]|\\\$|\\\^|\\\\|\\\{|\\\}|\\\|/g;

export class SelectionLogic {
    app: App;
    blockLevelTagsForSplit: Set<string>;
    getRules: () => LearnedRule[];
    lastFailureReport: FailureReport | null;

    constructor(app: App, getRules: () => LearnedRule[] = () => []) {
        this.app = app;
        this.blockLevelTagsForSplit = BLOCK_LEVEL_TAGS_FOR_SPLIT;
        this.getRules = getRules;
        this.lastFailureReport = null;
    }

    // Timeout-safe regex execution to prevent catastrophic backtracking
    safeRegexExec(regex: RegExp, text: string, timeoutMs = 3000): RegexResult[] {
        const startTime = Date.now();
        const results: RegexResult[] = [];
        let match: RegExpExecArray | null;
        try {
            while ((match = regex.exec(text)) !== null) {
                results.push({
                    index: match.index,
                    length: match[0].length,
                    text: match[0],
                });
                if (Date.now() - startTime > timeoutMs) {
                    console.warn(
                        `[Highlighter] Regex timed out after ${timeoutMs}ms, returning ${results.length} partial results`
                    );
                    break;
                }
            }
        } catch (e) {
            console.warn("[Highlighter] Regex execution error:", e instanceof Error ? e.message : String(e));
        }
        return results;
    }

    async locateSelection(
        processedFile: TFile,
        view: MarkdownView,
        selectionSnippet: string,
        context: string | null = null,
        occurrenceIndex = 0,
        withinBlock: SelectionHint | null = null,
        contextKind: BlockKind | null = null
    ): Promise<PhysicalResult | null> {
        this.lastFailureReport = null; // Note 2: Reset at top of call

        let snippet = this.stripBrowserJunk(selectionSnippet);
        if (!snippet) {
            return null;
        }

        // Apply Learned Rules (Adaptation Layer)
        const rules = this.getRules();
        if (rules && rules.length > 0) {
            for (const rule of rules) {
                if (rule.stripPattern) {
                    try {
                        const regex = new RegExp(this.escapeRegex(rule.stripPattern), "g");
                        snippet = snippet.replace(regex, "");
                    } catch (e) {
                        console.warn("[Highlighter] Failed to apply learned rule:", rule, e);
                    }
                }
            }
            snippet = snippet.trim();
        }

        const activeFile = view.file;
        const opContext = { cache: /* @__PURE__ */ new Map(), visited: /* @__PURE__ */ new Set() };
        const virtual = await this.resolveVirtualContent(activeFile, 0, opContext);
        const fullRaw = virtual.text;

        let firstSegmentBodyStart = 0;
        if (fullRaw.startsWith("---")) {
            const secondDash = fullRaw.indexOf("---", 3);
            if (secondDash !== -1) {
                firstSegmentBodyStart = secondDash + 3;
                while (
                    firstSegmentBodyStart < fullRaw.length &&
                    (fullRaw[firstSegmentBodyStart] === "\n" || fullRaw[firstSegmentBodyStart] === "\r")
                ) {
                    firstSegmentBodyStart++;
                }
            }
        }

        const bodyContent = fullRaw.substring(firstSegmentBodyStart);
        const selectionBlocks = this.splitSelectionBlocks(snippet);

        // Track which strategies were attempted for diagnostics
        const diagnostics: Diagnostics = { strategies: {} };

        let candidates: Candidate[] = [];
        if (selectionBlocks.length > 1) {
            candidates = this.findBlockSequenceCandidates(bodyContent, selectionBlocks, 0);
            diagnostics.strategies.blockSequence = { tried: true, found: candidates.length };
        } else {
            diagnostics.strategies.blockSequence = { tried: false, reason: "single block" };
        }

        if (candidates.length === 0) {
            candidates = this.findHybridCandidates(bodyContent, snippet, 0);
            diagnostics.strategies.hybridMatch = { tried: true, found: candidates.length };
        }

        if (candidates.length === 0) {
            candidates = this.findAllCandidates(bodyContent, snippet, 0);
            diagnostics.strategies.flexiblePattern = { tried: true, found: candidates.length };
        }

        if (candidates.length === 0) {
            candidates = this.findCandidatesStripped(bodyContent, snippet, 0);
            diagnostics.strategies.strippedMatch = { tried: true, found: candidates.length };
        }

        if (candidates.length === 0) {
            candidates = this.findFuzzyCandidates(bodyContent, snippet, 0);
            diagnostics.strategies.fuzzyMatch = { tried: true, found: candidates.length };
        }

        // Note 1: findProximityCandidates is last resort (Position 6)
        if (candidates.length === 0) {
            candidates = this.findProximityCandidates(bodyContent, snippet, 0);
            diagnostics.strategies.proximityMatch = { tried: true, found: candidates.length };
        }

        if (candidates.length === 0) {
            // Classification & failure recording (Bug 1: return null)
            this.lastFailureReport = this.classifyFailure(selectionSnippet, snippet, bodyContent, diagnostics);
            this.logSelectionDiagnostics(selectionSnippet, snippet, bodyContent, selectionBlocks, diagnostics);
            return null;
        }

        candidates = this.offsetCandidates(candidates, firstSegmentBodyStart);

        // Apply Structural Snapping to all final candidates to protect footnotes/prefixes
        candidates = candidates.map((cand) => this.snapToStructuralBoundaries(fullRaw, cand));

        const result = this.resolveCandidates(
            candidates,
            fullRaw,
            snippet,
            context,
            occurrenceIndex,
            withinBlock,
            splitSourceBlocks(bodyContent, firstSegmentBodyStart),
            contextKind
        );
        if (!result) {
            return null;
        }

        return this.mapVirtualToPhysical(result.start, result.end, virtual.segments);
    }

    // R1: Diagnostic logging for failed selection matching
    logSelectionDiagnostics(
        rawSnippet: string,
        cleanedSnippet: string,
        bodyContent: string,
        selectionBlocks: string[],
        diagnostics: Diagnostics
    ) {
        const truncate = (str: string, len = 120): string => (str.length > len ? str.substring(0, len) + "…" : str);
        const hasSupplementary = (str: string) => [...str].some((ch) => ch.length > 1);

        console.group("%c[Highlighter] Selection Match Failed", "color: #e74c3c; font-weight: bold");

        console.log("📋 Raw snippet:", truncate(rawSnippet, 200));
        console.log("🧹 Cleaned snippet:", truncate(cleanedSnippet, 200));
        console.log("📐 Snippet length:", cleanedSnippet.length, "chars,", [...cleanedSnippet].length, "code points");
        console.log("🔤 Contains supplementary-plane chars:", hasSupplementary(cleanedSnippet));
        console.log("📄 Selection blocks:", selectionBlocks.length);

        console.log("\n🔍 Strategy Results:");
        for (const [name, result] of Object.entries(diagnostics.strategies)) {
            if (result.tried) {
                console.log(`  ${(result.found ?? 0) > 0 ? "✅" : "❌"} ${name}: ${result.found} candidates`);
            } else {
                console.log(`  ⏭️ ${name}: skipped (${result.reason})`);
            }
        }

        // Show what the flexible pattern looks like for the first 80 chars
        try {
            const sampleSnippet = cleanedSnippet.substring(0, 80);
            const samplePattern = this.createFlexiblePattern(sampleSnippet);
            if (samplePattern) {
                console.log("\n🔧 Sample regex (first 80 chars):", truncate(samplePattern, 300));
                try {
                    const testRegex = new RegExp(samplePattern, "gmu");
                    const testMatch = testRegex.exec(bodyContent);
                    console.log("  Test match:", testMatch ? `✅ at offset ${testMatch.index}` : "❌ no match");
                } catch (e) {
                    console.log("  Test match: ⚠️ regex error:", e instanceof Error ? e.message : String(e));
                }
            }
        } catch (e) {
            console.log("  Pattern build error:", e instanceof Error ? e.message : String(e));
        }

        // Show nearby source context
        const normalizedSnippet = this.normalizeComparableText(cleanedSnippet);
        const firstWord = normalizedSnippet.split(/\s+/)[0];
        if (firstWord && firstWord.length > 2) {
            const idx = bodyContent.indexOf(firstWord);
            if (idx !== -1) {
                console.log("\n📍 First word '" + firstWord + "' found at offset", idx);
                console.log("  Source context:", truncate(bodyContent.substring(idx, idx + 200), 200));
            } else {
                console.log("\n📍 First word '" + firstWord + "' NOT found in body content");
            }
        }

        console.groupEnd();
    }

    async resolveVirtualContent(
        file: TFile,
        depth = 0,
        opContext: OpContext = { cache: new Map(), visited: new Set() },
        fragment: string | null = null
    ): Promise<Virtual> {
        if (depth > 5) {
            return { text: "", segments: [] };
        }
        const fragmentKey = fragment ? String(fragment) : "";
        const cacheKey = fragmentKey ? `${file.path}#${fragmentKey}` : file.path;
        if (opContext.cache.has(cacheKey)) {
            return opContext.cache.get(cacheKey);
        }
        if (opContext.visited.has(file.path)) {
            return { text: "", segments: [] };
        }
        opContext.visited.add(file.path);
        let raw = await this.app.vault.read(file);
        let fmOffset = 0;
        if (depth > 0 && raw.startsWith("---")) {
            const originalLength = raw.length;
            const secondDash = raw.indexOf("---", 3);
            if (secondDash !== -1) {
                raw = raw.substring(secondDash + 3);
                while (raw.startsWith("\n") || raw.startsWith("\r")) {
                    raw = raw.substring(1);
                }
                fmOffset = originalLength - raw.length;
            }
        }
        const cache = this.app.metadataCache.getFileCache(file);
        const embeds = (cache == null ? void 0 : cache.embeds) || [];
        const sortedEmbeds = [...embeds].sort((a, b) => a.position.start.offset - b.position.start.offset);

        let sliceStart = 0;
        let sliceEnd = raw.length;
        if (fragmentKey) {
            const range = this.findEmbedFragmentRange(raw, fragmentKey);
            if (range) {
                sliceStart = Math.max(0, Math.min(raw.length, range.start));
                sliceEnd = Math.max(sliceStart, Math.min(raw.length, range.end));
            }
        }

        let virtualText = "";
        const segments: Segment[] = [];
        let lastOffset = sliceStart;
        for (const embed of sortedEmbeds) {
            const adjustedStart = embed.position.start.offset - fmOffset;
            const adjustedEnd = embed.position.end.offset - fmOffset;
            if (adjustedStart < 0) continue;
            if (adjustedEnd <= sliceStart) continue;
            if (adjustedStart >= sliceEnd) break;
            // If an embed overlaps the slice boundaries, do not expand it (treat as literal source text).
            // This avoids including content outside the requested fragment and prevents substring index swapping.
            if (adjustedStart < sliceStart) continue;
            if (adjustedEnd > sliceEnd) break;
            if (adjustedStart < lastOffset) continue;
            const preText = raw.slice(lastOffset, adjustedStart);
            const segStart = virtualText.length;
            virtualText += preText;
            segments.push({
                vStart: segStart,
                vEnd: virtualText.length,
                file,
                pOffset: lastOffset + fmOffset,
            });

            const rawLink = String(embed.link || "");
            const hashIdx = rawLink.indexOf("#");
            const linkPathWithAlias = hashIdx === -1 ? rawLink : rawLink.slice(0, hashIdx);
            const embedFragment = hashIdx === -1 ? null : rawLink.slice(hashIdx + 1);
            const pipeIdx = linkPathWithAlias.indexOf("|");
            const linkPath = pipeIdx === -1 ? linkPathWithAlias : linkPathWithAlias.slice(0, pipeIdx);

            const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
            if (targetFile) {
                const subContext = { ...opContext, visited: new Set(opContext.visited) };
                const subVirtual = await this.resolveVirtualContent(targetFile, depth + 1, subContext, embedFragment);
                const embedStart = virtualText.length;
                virtualText += subVirtual.text;
                for (const subSeg of subVirtual.segments) {
                    segments.push({
                        vStart: subSeg.vStart + embedStart,
                        vEnd: subSeg.vEnd + embedStart,
                        file: subSeg.file,
                        pOffset: subSeg.pOffset,
                    });
                }
            } else {
                const embedText = raw.slice(adjustedStart, adjustedEnd);
                const segStart2 = virtualText.length;
                virtualText += embedText;
                segments.push({
                    vStart: segStart2,
                    vEnd: virtualText.length,
                    file,
                    pOffset: adjustedStart + fmOffset,
                });
            }
            lastOffset = adjustedEnd;
        }
        const tailText = raw.slice(lastOffset, sliceEnd);
        const tailStart = virtualText.length;
        virtualText += tailText;
        segments.push({
            vStart: tailStart,
            vEnd: virtualText.length,
            file,
            pOffset: lastOffset + fmOffset,
        });
        const result = this.applyStructuralFilter({ text: virtualText, segments });
        opContext.cache.set(cacheKey, result);
        return result;
    }

    decodeEmbedFragment(fragment: string | null): string {
        const rawFragment = String(fragment || "").trim();
        if (!rawFragment) return "";
        try {
            return decodeURIComponent(rawFragment).trim();
        } catch {
            return rawFragment;
        }
    }

    normalizeHeadingForMatch(text: string): string {
        return String(text || "")
            .replace(/<[^>]+>/g, "")
            .replace(/[*_~`]+/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }

    findHeadingRange(raw: string, heading: string): OffsetRange | null {
        const needle = this.normalizeHeadingForMatch(heading);
        if (!needle) return null;

        const headingRe = /^(#{1,6})[ \t]+(.+?)\s*$/gm;
        const headings: { index: number; level: number; normalized: string }[] = [];
        let match: RegExpExecArray | null;
        while ((match = headingRe.exec(raw)) !== null) {
            const level = match[1].length;
            const title = match[2] || "";
            headings.push({
                index: match.index,
                level,
                normalized: this.normalizeHeadingForMatch(title),
            });
        }

        const idx = headings.findIndex(
            (h) => h.normalized === needle || h.normalized.includes(needle) || needle.includes(h.normalized)
        );
        if (idx === -1) return null;

        const start = headings[idx].index;
        const level = headings[idx].level;
        let end = raw.length;
        for (let i = idx + 1; i < headings.length; i++) {
            if (headings[i].level <= level) {
                end = headings[i].index;
                break;
            }
        }

        return { start, end };
    }

    findBlockRange(raw: string, blockId: string): OffsetRange | null {
        const id = String(blockId || "").trim();
        if (!id) return null;

        const blockRe = new RegExp(`(^|[ \\t])\\^${this.escapeRegex(id)}(?=\\s|$)`, "m");
        const match = blockRe.exec(raw);
        if (!match) return null;

        const caretIndex = match.index + (match[1] ? match[1].length : 0);
        const lineStart = Math.max(0, raw.lastIndexOf("\n", caretIndex) + 1);

        const newline = raw.includes("\r\n") ? "\r\n" : "\n";
        let end = raw.indexOf(newline + newline, caretIndex);
        if (end === -1) {
            end = raw.indexOf(newline, caretIndex);
        }
        if (end === -1) end = raw.length;

        return { start: lineStart, end };
    }

    findEmbedFragmentRange(raw: string, fragment: string): OffsetRange | null {
        const decoded = this.decodeEmbedFragment(fragment);
        if (!decoded) return null;

        // Block references: #^blockid
        if (decoded.startsWith("^")) {
            return this.findBlockRange(raw, decoded.slice(1));
        }

        // Headings: #Heading. If nested headings are passed as "H1#H2", try the last segment too.
        const candidates: string[] = [];
        candidates.push(decoded);
        if (decoded.includes("#")) {
            const parts = decoded
                .split("#")
                .map((p) => p.trim())
                .filter(Boolean);
            if (parts.length) candidates.push(parts[parts.length - 1]);
        }

        for (const cand of candidates) {
            const range = this.findHeadingRange(raw, cand);
            if (range) return range;
        }

        return null;
    }

    // Structural Filtering Engine (Noise Shield)
    // Computationally strips invisible markdown syntax while keeping offsets perfectly mapped
    applyStructuralFilter({ text, segments }: Virtual): Virtual {
        const patterns = [
            // Footnotes: [^123]
            /\[\^[^\]]+\]/g,
            // Inline footnotes: ^[note]
            /\^\[[^\]]+\]/g,
            // Comments: %% ... %% (can span multiple lines)
            /%%[\s\S]*?%%/g,
            // Task checkmarks: - [x] or - [ ]
            /-\s\[[ xX]\]/g,
            // Callout prefixes: > [!WARNING]
            />\s*\[![^\]]+\]/g,
            // Block IDs: ^abc123 (hidden in reading view)
            /[ \t]\^[a-zA-Z0-9-]+(?=\s|$)/g,
            // Plugin-injected highlighting
            /==|<mark[^>]*>|<\/mark>/g,
            // Table alignment rows
            /(?:^|\n)[ \t]*\|?[ \t:|-]+\|[ \t:|-]*(?=\n|$)/g,
            // Link URL portion: ](https://...)
            // NOTE: this runs before the image rule below, so `![caption](url)`
            // is reduced to `![caption` and the image rule never fires. The
            // caption therefore survives into the text the matcher searches.
            // Reordering these two fixes the leak but changes every downstream
            // offset, which cost more selections than it saved; block scoring
            // compensates for the leak instead (see resolveCandidates).
            /\]\([^)]+\)/g,
            // Markdown Images: ![caption](url)
            /!\[[^\]]*\]\([^)]+\)/g,
            // Global HTML Tags (Reading view strips these)
            /<[^>]+>/g,
        ];

        let currentText: string = text;
        let currentSegments: Segment[] = [...segments];

        for (const regex of patterns) {
            let match: RegExpExecArray | null;
            regex.lastIndex = 0;
            const matches: { start: number; end: number; length: number }[] = [];

            // Special handling for footnotes
            if (regex.source === "\\[\\^[^\\]]+\\]") {
                while ((match = regex.exec(currentText)) !== null) {
                    const content = match[0].substring(2, match[0].length - 1);
                    // ONLY strip citations (numbers, separators, syms, NO letters)
                    // These are usually rendered as superscripts [1] or [6-1]
                    if (!/[a-zA-Z]/.test(content)) {
                        matches.push({
                            start: match.index,
                            end: match.index + match[0].length,
                            length: match[0].length,
                        });
                    }
                    // Named or inline content footnotes (containing letters) are left intact
                    // as they are likely literal visible text in the browser.
                }
            } else {
                while ((match = regex.exec(currentText)) !== null) {
                    matches.push({ start: match.index, end: match.index + match[0].length, length: match[0].length });
                }
            }

            // Process backwards
            for (let i = matches.length - 1; i >= 0; i--) {
                const { start, end, length } = matches[i];

                currentText = currentText.substring(0, start) + currentText.substring(end);

                const newSegments: Segment[] = [];
                for (const seg of currentSegments) {
                    if (seg.vEnd <= start) {
                        newSegments.push(seg);
                    } else if (seg.vStart >= end) {
                        newSegments.push({
                            ...seg,
                            vStart: seg.vStart - length,
                            vEnd: seg.vEnd - length,
                        });
                    } else {
                        if (seg.vStart < start) {
                            newSegments.push({
                                ...seg,
                                vEnd: start,
                            });
                        }
                        if (seg.vEnd > end) {
                            newSegments.push({
                                ...seg,
                                vStart: start,
                                vEnd: seg.vEnd - length,
                                pOffset: seg.pOffset + (end - seg.vStart),
                            });
                        }
                    }
                }
                currentSegments = newSegments;
            }
        }

        return { text: currentText, segments: currentSegments };
    }

    mapVirtualToPhysical(vStart: number, vEnd: number, segments: Segment[]): PhysicalResult | null {
        const startSeg = segments.find((s) => vStart >= s.vStart && vStart < s.vEnd);
        const endSeg = segments.find((s) => vEnd > s.vStart && vEnd <= s.vEnd);
        if (!startSeg || !endSeg) return null;
        const pStart = startSeg.pOffset + (vStart - startSeg.vStart);
        const pEnd = endSeg.pOffset + (vEnd - endSeg.vStart);
        return {
            file: startSeg.file,
            start: pStart,
            end: pEnd,
            raw: "",
        };
    }

    /**
     * Candidates whose source text really is the snippet once inline markers are
     * stripped — i.e. the ones that correspond to a visible occurrence in
     * Reading view. Compared case-insensitively, matching how the candidate
     * strategies search.
     */
    literalCandidates(candidates: Candidate[], raw: string, snippet: string): Candidate[] {
        const target = this.normalizeComparableText(snippet || "").toLocaleLowerCase();
        if (!target) return [];
        return candidates.filter((cand) => {
            const text = cand.text ?? raw.substring(cand.start, cand.end);
            return this.normalizeComparableText(text).toLocaleLowerCase() === target;
        });
    }

    /**
     * Reduce link syntax to the text Reading view actually shows, so a block's
     * source text can be compared against the rendered context. Without this a
     * table-of-contents entry like `[[Note#Prologue|Prologue]]` compares as its
     * target rather than its alias, and scores worse against the context than an
     * unrelated `# Prologue` heading elsewhere in the note.
     */
    stripLinkSyntax(line: string): string {
        return (
            line
                .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
                .replace(/!\[\[[^\]]+\]\]/g, "")
                .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1")
                .replace(/\[\[([^\]]+)\]\]/g, "$1")
                .replace(/\[\^[^\]]+\]/g, "")
                .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
                // `applyStructuralFilter` has already removed the `](url)` half of
                // every inline link by this point, leaving the opening bracket
                // stranded (`[Ejemplos de palabras compuestas`). Reading view shows
                // no bracket there, so leaving it in makes a table-of-contents entry
                // score worse against its own rendered text than an unrelated
                // heading with the same words.
                .replace(/[[\]]/g, "")
        );
    }

    /**
     * Normalised source text of a block, for comparison against the rendered
     * block text the caller captured from Reading view.
     */
    blockCompareText(raw: string, block: SourceBlock): string {
        return raw
            .substring(block.start, block.end)
            .split(/\r?\n/)
            .map((line) => this.normalizeLineForCompare(this.stripLinkSyntax(line)))
            .filter((line) => line.length > 0)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Choose which candidate the user actually selected.
     *
     * Three signals, each answering a different question:
     *  - `context` (the rendered block's text) narrows to the right block, which
     *    is what separates two paragraphs that both contain the snippet;
     *  - `occurrenceIndex` picks between blocks whose rendered text is
     *    *identical*, since those score the same and nothing else tells them
     *    apart;
     *  - `withinBlock` picks between repeats *inside* one block — the case a
     *    paragraph with soft line breaks produces, where every occurrence shares
     *    one block element and one context string.
     *
     * Each falls back to the previous behaviour when its signal is unavailable,
     * so a selection captured without a live Range still resolves as before.
     */
    resolveCandidates(
        candidates: Candidate[],
        raw: string,
        snippet: string,
        context: string | null,
        occurrenceIndex: number,
        withinBlock: SelectionHint | null = null,
        blocks: SourceBlock[] = [],
        contextKind: BlockKind | null = null
    ): { raw: string; start: number; end: number } | null {
        if (candidates.length === 0) return null;

        // One candidate per start offset, so an ordinal counted in the rendered
        // text lines up with position in this list.
        const seenStarts = new Set<number>();
        const unique = candidates
            .slice()
            .sort((a, b) => a.start - b.start)
            .filter((cand) => {
                if (seenStarts.has(cand.start)) return false;
                seenStarts.add(cand.start);
                return true;
            });

        const pickWithinBlock = (inBlock: Candidate[], blockStart: number): Candidate => {
            if (!withinBlock || inBlock.length <= 1) return inBlock[0];

            // The matcher's candidates are not all literal occurrences: it
            // matches case-insensitively and tolerates gaps, so a block can yield
            // `Foundry` for `foundry` and `in to` for `into`. Counting those as
            // occurrences would shift the ordinal. Keep the candidates whose text
            // really is the snippet, and number those.
            const literal = this.literalCandidates(inBlock, raw, snippet);
            const pool = literal.length > 0 ? literal : inBlock;

            if (withinBlock.total === pool.length) {
                const index = Math.max(0, Math.min(pool.length - 1, withinBlock.ordinal));
                return pool[index];
            }

            // Counts disagree, so the ordinal cannot be trusted. Fall back to the
            // candidate nearest the caret. Rendered and source offsets differ by
            // the markup between them, which is normally far smaller than the
            // distance between two occurrences.
            const expected = blockStart + Math.max(0, withinBlock.caret);
            let best = pool[0];
            let bestDistance = Math.abs(pool[0].start - expected);
            for (let i = 1; i < pool.length; i++) {
                const distance = Math.abs(pool[i].start - expected);
                if (distance < bestDistance) {
                    best = pool[i];
                    bestDistance = distance;
                }
            }
            return best;
        };

        if (context && blocks.length > 0) {
            // Normalise the rendered context exactly as the source side is
            // normalised. `blockCompareText` folds smart quotes and dashes to
            // ASCII, so comparing against raw rendered text would never match a
            // paragraph containing typographic punctuation.
            const cleanContext = this.normalizeComparableText(context);

            // Group candidates by the source block they land in. Candidates that
            // fall between blocks keep their own group so they stay selectable.
            const groups = new Map<
                string,
                { text: string; start: number; kind: BlockKind | null; candidates: Candidate[] }
            >();
            for (const cand of unique) {
                const block = findBlockAt(blocks, cand.start);
                const key = block ? `b${block.start}` : `x${cand.start}`;
                const existing = groups.get(key);
                if (existing) {
                    existing.candidates.push(cand);
                    continue;
                }
                groups.set(key, {
                    text: block
                        ? this.blockCompareText(raw, block)
                        : this.normalizeLineForCompare(cand.text || raw.substring(cand.start, cand.end)),
                    start: block ? block.start : cand.start,
                    kind: block ? block.kind : null,
                    candidates: [cand],
                });
            }

            const scored = [...groups.values()]
                .map((group) => ({ ...group, score: this.calculateSimilarity(group.text, cleanContext) }))
                .sort((a, b) => b.score - a.score || a.start - b.start);

            if (scored.length > 0) {
                // A block's source text can carry words Reading view never shows
                // — most often an image caption, since the structural filter
                // strips `](url)` before its image rule can match and the caption
                // survives. Such a block reads as `!Photograph of a hall Scroll
                // through the whole page…`, scoring far below a bare paragraph
                // with the same visible words, so a note repeating that paragraph
                // after every image would collapse onto the one clean copy.
                // Treat any block *containing* the rendered context as an equal
                // match, so the repeats are all seen and can be indexed.
                const containing = scored
                    .filter((group) => group.text === cleanContext || group.text.includes(cleanContext))
                    .sort((a, b) => a.start - b.start);
                const best = scored[0];
                let identical =
                    containing.length > 0
                        ? containing
                        : scored.filter((group) => group.text === best.text).sort((a, b) => a.start - b.start);

                // `occurrenceIndex` counts DOM elements sharing one tag, so only
                // blocks rendering as that same kind belong in the sequence it
                // indexes: a list item and a heading reading alike are two
                // sequences, not one.
                if (contextKind && identical.length > 1) {
                    const sameKind = identical.filter((group) => group.kind === contextKind);
                    if (sameKind.length > 0) identical = sameKind;
                }

                const chosenGroup =
                    occurrenceIndex >= 0 && occurrenceIndex < identical.length
                        ? identical[occurrenceIndex]
                        : identical[0] || best;

                const chosen = pickWithinBlock(chosenGroup.candidates, chosenGroup.start);
                return { raw, start: chosen.start, end: chosen.end };
            }
        }

        if (context) {
            // No block map available: keep the original snippet-similarity path,
            // but still honour the within-block ordinal among the survivors.
            const cleanContext = context.replace(/\s+/g, " ").trim();
            const rescored = unique.map((cand) => {
                const sourceBlock = (cand.text || raw.substring(cand.start, cand.end)).replace(/\s+/g, " ").trim();
                return { ...cand, score: this.calculateSimilarity(sourceBlock, cleanContext) };
            });
            const bestScore = Math.max(...rescored.map((candidate) => candidate.score ?? 0));
            const threshold = bestScore * 0.85;
            const validCandidates = rescored.filter((candidate) => (candidate.score ?? 0) >= threshold);

            if (validCandidates.length > 0) {
                const chosen =
                    occurrenceIndex >= 0 && occurrenceIndex < validCandidates.length
                        ? validCandidates[occurrenceIndex]
                        : pickWithinBlock(validCandidates, validCandidates[0].start);
                return { raw, start: chosen.start, end: chosen.end };
            }
        }

        const fallback = pickWithinBlock(unique, unique[0].start);
        return { raw, start: fallback.start, end: fallback.end };
    }

    createFlexiblePattern(snippet: string): string {
        const lines = this.splitSelectionBlocks(this.stripUrlsForPatternMatch(snippet), false);
        if (lines.length === 0) {
            return "";
        }

        const contentPatterns = lines.map((line) => this.createFlexibleLinePattern(line));
        const lineBridge = `(?:[ \\t]*(?:(?:${INLINE_DECORATION_PATTERN})){0,3}[ \\t]*\\r?\\n(?:[ \\t>]*\\r?\\n){0,3})`;
        const joined = contentPatterns
            .map((pattern, index) => {
                const linePattern = `${OPTIONAL_MARKDOWN_LINE_PREFIX}${pattern}`;
                return index === 0 ? linePattern : `${lineBridge}${linePattern}`;
            })
            .join("");

        return joined;
    }

    createFlexibleLinePattern(line: string): string {
        const normalizedLine = this.normalizeComparableText(line);
        const parts: string[] = [];
        let pendingGap = false;

        const codePoints = [...normalizedLine];
        for (let i = 0; i < codePoints.length; i++) {
            const char = codePoints[i];
            if (/\s/.test(char)) {
                pendingGap = true;
                continue;
            }

            if (pendingGap && parts.length > 0) {
                parts.push(FLEX_WORD_GAP_PATTERN);
                pendingGap = false;
            }

            parts.push(this.getFlexibleCharPattern(char));
            if (i < codePoints.length - 1) {
                parts.push(FLEX_INTER_CHAR_GAP_PATTERN);
            }
        }

        if (parts.length === 0) {
            return "";
        }

        const pattern = parts.join("");
        // Add optional trailing decoration
        return `${pattern}(?:(?:${INLINE_DECORATION_PATTERN})){0,3}`;
    }

    getFlexibleCharPattern(char: string): string {
        if (char === "-") {
            return "[-\u2010-\u2015]";
        }
        if (char === '"') {
            return '["“”«»]';
        }
        if (char === "'") {
            return "['‘’`]";
        }
        return this.escapeRegex(char);
    }

    stripBrowserJunk(text: string): string {
        if (!text) {
            return text;
        }

        // Only strip citation-like markers [1] [^1] [6-1] [1,2]
        // These should not contain letters or we risk stripping actual visible words/inline footnotes.
        return text
            .normalize("NFC")
            .replace(/#:~:text=[^&\s]+(?:&|$)?/g, "")
            .replace(/[\u200b-\u200d\ufeff]/g, "")
            .replace(/(?:\u21a9|\u21b5|\ufe0e|\ufe0f)+/g, " ")
            .replace(/[\u00a0\u202f]/g, " ")
            .replace(/[‐‑‒–—―]/g, "-")
            .replace(/[“”«»]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/\[\^?[0-9,.:; \-|#§]+\]/g, "")
            .replace(/[ \t]+/g, " ")
            .trim();
    }

    stripUrlsForPatternMatch(snippet: string): string {
        // Moved to the virtual structural filter
        return snippet;
    }

    findAllCandidates(text: string, snippet: string, bodyStart = 0): Candidate[] {
        const cleanSnippet = snippet.trim();
        if (!cleanSnippet) {
            return [];
        }

        const patternSnippet = this.stripUrlsForPatternMatch(cleanSnippet);
        if (!patternSnippet) {
            return [];
        }

        const lineCount = (patternSnippet.match(/\n/g) || []).length;
        if (patternSnippet.length > 800 || lineCount >= 2) {
            const startAnchorLen = Math.min(patternSnippet.length / 2, 150);
            const endAnchorLen = Math.min(patternSnippet.length / 2, 150);
            const startAnchor = patternSnippet.substring(0, startAnchorLen);
            const endAnchor = patternSnippet.substring(patternSnippet.length - endAnchorLen);
            const startP = this.createFlexiblePattern(startAnchor);
            const endP = this.createFlexiblePattern(endAnchor);
            let startRegex: RegExp;
            let endRegex: RegExp;
            try {
                startRegex = new RegExp(startP, "gmu");
                endRegex = new RegExp(endP, "gmu");
            } catch (e) {
                console.error("INVALID REGEX PATTERN (anchor):", e);
                return [];
            }
            const startMatches: RegExpExecArray[] = [];
            const endMatches: RegExpExecArray[] = [];
            let match: RegExpExecArray | null;
            try {
                while ((match = startRegex.exec(text)) !== null) {
                    if (match.index >= bodyStart) {
                        startMatches.push(match);
                    }
                }
            } catch (e) {
                console.warn("Regex execution failed on startRegex (mobile backtracking limit):", e);
                return [];
            }
            try {
                while ((match = endRegex.exec(text)) !== null) {
                    if (match.index >= bodyStart) {
                        endMatches.push(match);
                    }
                }
            } catch (e) {
                console.warn("Regex execution failed on endRegex (mobile backtracking limit):", e);
                return [];
            }
            if (startMatches.length > 0 && endMatches.length > 0) {
                for (const startMatch of startMatches) {
                    const bestEnd = endMatches.find(
                        (endMatch) =>
                            endMatch.index > startMatch.index &&
                            endMatch.index - startMatch.index < cleanSnippet.length * 2
                    );
                    if (bestEnd) {
                        return [
                            {
                                start: startMatch.index,
                                end: bestEnd.index + bestEnd[0].length,
                                text: text.substring(startMatch.index, bestEnd.index + bestEnd[0].length),
                            },
                        ];
                    }
                }
            }
        }

        const pattern = this.createFlexiblePattern(patternSnippet);
        if (!pattern) {
            return [];
        }

        let regex: RegExp;
        try {
            regex = new RegExp(pattern, "gmu");
        } catch (_error) {
            void _error;
            console.error("INVALID REGEX PATTERN:", pattern);
            return [];
        }

        const candidates: Candidate[] = [];
        const results = this.safeRegexExec(regex, text, 3000);
        for (const match of results) {
            candidates.push({
                start: match.index,
                end: match.index + match.length,
                text: match.text,
            });
        }

        return candidates;
    }

    escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    findCandidatesStripped(text: string, snippet: string, bodyStart = 0): Candidate[] {
        const map: number[] = [];
        let strippedRaw = "";
        const isFormattingMarker = (str: string, pos: number): number => {
            const char = str[pos];
            const next1 = str[pos + 1];
            const next2 = str[pos + 2];
            if (char === "*" && next1 === "*" && next2 === "*") {
                return 3;
            }
            if ((char === "*" && next1 === "*") || (char === "~" && next1 === "~") || (char === "=" && next1 === "=")) {
                return 2;
            }
            if (char === "*" || char === "_") {
                return 1;
            }
            return 0;
        };
        const extractVisibleText = (startPos: number, endPos: number): void => {
            for (let i = startPos; i < endPos; i++) {
                const skip = isFormattingMarker(text, i);
                if (skip > 0) {
                    i += skip - 1;
                    continue;
                }
                map.push(i);
                strippedRaw += text[i];
            }
        };
        const addRawText = (startPos: number, endPos: number): void => {
            for (let i = startPos; i < endPos; i++) {
                map.push(i);
                strippedRaw += text[i];
            }
        };
        const tokenRegex = new RegExp(
            [
                /(`{3}[^\n]*\n[\s\S]*?`{3})/.source,
                /(!\[\[(?:[^\]]+)\]\])/.source,
                /(!\[(?:[^\]]*)\]\[(?:[^\]]*)\])/.source,
                /(!\[(?:[^\]]*)\]\((?:[^()"]*(?:\([^)]*\))?[^()"]*(?:"[^"]*")?)\))/.source,
                /(\[(?!\^)(?:[^\]]+)\]\[(?:[^\]]*)\])/.source,
                /(\[(?!\^)(?:[^\]]+)\]\((?:[^()"]*(?:\([^)]*\))?[^()"]*(?:"[^"]*")?)\))/.source,
                /(\[\[(?:[^\]]+)\]\])/.source,
                /(\[\^[^\]]+\]:?[ \t]?)/.source,
                /(\$\$[^$]+\$\$)/.source,
                /(\$(?:[^$\s]|[^$\s][^$]*[^$\s])\$)/.source,
                /(%%[^%]*%%)/.source,
                /(`[^`]+`)/.source,
                /(<(?:https?:\/\/[^>]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>)/.source,
                /(<\/?[a-zA-Z][^>]*>)/.source,
                /(\\(?:[*_[\](){}#>+\-.!`~=|\\]))/.source,
                /(\*\*\*)/.source,
                /(\*\*|~~|==)/.source,
                /(\*|_)/.source,
                /(^[ \t]*>[ \t]?(?:\[![^\]]+\][ \t]?)?)/.source,
                /([ \t]\^[a-zA-Z0-9-]+(?=\s|$))/.source,
                /(\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|)/.source,
                /(\|)/.source,
                /([\u2013\u2014\u201c\u201d\u2018\u2019\u00ab\u00bb])/.source,
                /(&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.source,
            ].join("|"),
            "gm"
        );
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        try {
            while ((match = tokenRegex.exec(text)) !== null) {
                for (let i = lastIndex; i < match.index; i++) {
                    map.push(i);
                    strippedRaw += text[i];
                }
                const fullMatch = match[0];
                const matchStart = match.index;
                if (match[1]) {
                    const firstNewline = fullMatch.indexOf("\n");
                    if (firstNewline !== -1) {
                        const codeStart = matchStart + firstNewline + 1;
                        const closingFence = fullMatch.lastIndexOf("```");
                        const codeEnd = closingFence !== -1 ? matchStart + closingFence : matchStart + fullMatch.length;
                        addRawText(codeStart, codeEnd);
                    }
                } else if (match[2]) {
                    const inner = fullMatch.substring(3, fullMatch.length - 2);
                    const pipeIndex = inner.indexOf("|");
                    const visibleStart = matchStart + 3 + (pipeIndex !== -1 ? pipeIndex + 1 : 0);
                    const visibleEnd = matchStart + fullMatch.length - 2;
                    extractVisibleText(visibleStart, visibleEnd);
                } else if (match[3] || match[4] || match[5] || match[6]) {
                    const closingBracket = fullMatch.indexOf(match[3] || match[5] ? "][" : "](");
                    const textStart = matchStart + (match[3] || match[4] ? 2 : 1);
                    const textEnd = matchStart + (closingBracket !== -1 ? closingBracket : fullMatch.indexOf("]"));
                    extractVisibleText(textStart, textEnd);
                } else if (match[7]) {
                    const inner = fullMatch.substring(2, fullMatch.length - 2);
                    const pipeIndex = inner.indexOf("|");
                    const visibleStart = matchStart + 2 + (pipeIndex !== -1 ? pipeIndex + 1 : 0);
                    const visibleEnd = matchStart + fullMatch.length - 2;
                    extractVisibleText(visibleStart, visibleEnd);
                } else if (match[8]) {
                    void 0;
                } else if (match[9] || match[10]) {
                    const mathStart = matchStart + (match[9] ? 2 : 1);
                    const mathEnd = matchStart + fullMatch.length - (match[9] ? 2 : 1);
                    addRawText(mathStart, mathEnd);
                } else if (match[12] || match[13]) {
                    const codeStart = matchStart + 1;
                    const codeEnd = matchStart + fullMatch.length - 1;
                    addRawText(codeStart, codeEnd);
                } else if (match[15]) {
                    const charPos = matchStart + 1;
                    map.push(charPos);
                    strippedRaw += text[charPos];
                } else if (match[24]) {
                    const entity = fullMatch.toLowerCase();
                    let decoded = "";
                    if (entity === "&nbsp;") decoded = " ";
                    else if (entity === "&amp;") decoded = "&";
                    else if (entity === "&lt;") decoded = "<";
                    else if (entity === "&gt;") decoded = ">";
                    else if (entity === "&quot;") decoded = '"';
                    else if (entity === "&apos;") decoded = "'";
                    else if (entity.startsWith("&#x")) {
                        const codePoint = parseInt(entity.slice(3, -1), 16);
                        if (Number.isFinite(codePoint)) {
                            try {
                                decoded = String.fromCodePoint(codePoint);
                            } catch (_error) {
                                void _error;
                                decoded = "";
                            }
                        }
                    } else if (entity.startsWith("&#")) {
                        const codePoint = parseInt(entity.slice(2, -1), 10);
                        if (Number.isFinite(codePoint)) {
                            try {
                                decoded = String.fromCodePoint(codePoint);
                            } catch (_error) {
                                void _error;
                                decoded = "";
                            }
                        }
                    }
                    if (decoded) {
                        for (let i = 0; i < decoded.length; i++) {
                            map.push(matchStart);
                            strippedRaw += decoded[i];
                        }
                    }
                }
                lastIndex = tokenRegex.lastIndex;
            }
        } catch (e) {
            console.warn("tokenRegex execution failed in findCandidatesStripped (mobile backtracking limit):", e);
            return [];
        }
        for (let i = lastIndex; i < text.length; i++) {
            map.push(i);
            strippedRaw += text[i];
        }
        const patternSnippet = this.stripUrlsForPatternMatch(snippet.trim());
        const pattern = this.createFlexiblePattern(patternSnippet);
        if (!pattern) {
            return [];
        }
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, "gmu");
        } catch (e) {
            console.error("INVALID REGEX PATTERN in findCandidatesStripped:", e);
            return [];
        }
        const candidates: Candidate[] = [];
        let strippedMatch: RegExpExecArray | null;
        try {
            while ((strippedMatch = regex.exec(strippedRaw)) !== null) {
                const strippedStart = strippedMatch.index;
                const strippedEnd = strippedMatch.index + strippedMatch[0].length;
                const rawStart = map[strippedStart];
                const rawEnd = strippedEnd < map.length ? map[strippedEnd] : map[strippedEnd - 1] + 1;
                if (rawStart >= bodyStart) {
                    candidates.push({
                        start: rawStart,
                        end: rawEnd,
                        text: text.substring(rawStart, rawEnd),
                    });
                }
            }
        } catch (e) {
            console.warn("Regex execution failed in findCandidatesStripped (mobile backtracking limit):", e);
            return [];
        }
        return candidates;
    }

    findBlockSequenceCandidates(text: string, selectionBlocks: string[], bodyStart = 0): Candidate[] {
        if (selectionBlocks.length === 0) {
            return [];
        }

        const documentLines = this.createDocumentLineRecords(text);
        const candidates: Candidate[] = [];

        for (let startIndex = 0; startIndex < documentLines.length; startIndex++) {
            const firstLine = documentLines[startIndex];
            if (firstLine.start < bodyStart || !this.lineMatches(firstLine.compare, selectionBlocks[0])) {
                continue;
            }

            let selectionIndex = 1;
            let docIndex = startIndex + 1;
            let lastMatch = startIndex;

            while (selectionIndex < selectionBlocks.length && docIndex < documentLines.length) {
                const candidateLine = documentLines[docIndex];
                if (this.lineMatches(candidateLine.compare, selectionBlocks[selectionIndex])) {
                    lastMatch = docIndex;
                    selectionIndex++;
                    docIndex++;
                    continue;
                }

                if (candidateLine.skippable) {
                    docIndex++;
                    continue;
                }

                break;
            }

            if (selectionIndex === selectionBlocks.length) {
                candidates.push({
                    start: firstLine.start,
                    end: documentLines[lastMatch].end,
                    text: text.substring(firstLine.start, documentLines[lastMatch].end),
                });
            }
        }

        return this.dedupeCandidates(candidates);
    }

    createDocumentLineRecords(text: string): LineRecord[] {
        const lines: LineRecord[] = [];
        let offset = 0;

        while (offset <= text.length) {
            const nextBreak = text.indexOf("\n", offset);
            const end = nextBreak === -1 ? text.length : nextBreak;
            const rawLine = text.substring(offset, end);
            const compare = this.normalizeLineForCompare(rawLine);
            lines.push({
                raw: rawLine,
                start: offset,
                end,
                compare,
                skippable: compare.length === 0 || MARKDOWN_PREFIX_ONLY_RE.test(rawLine.trimEnd()),
            });

            if (nextBreak === -1) {
                break;
            }
            offset = nextBreak + 1;
        }

        return lines;
    }

    splitSelectionBlocks(snippet: string, filterEmpty = true): string[] {
        const normalized = snippet.replace(/\r\n?/g, "\n");
        const blocks = normalized.split("\n").map((line) => this.normalizeComparableText(line));
        return filterEmpty ? blocks.filter((line) => line.length > 0) : blocks;
    }

    normalizeLineForCompare(line: string): string {
        const strippedLine = line.replace(INLINE_DECORATION_RE, "");
        const parts = this.splitMarkdownLine(strippedLine);
        return this.normalizeComparableText(parts.content);
    }

    normalizeComparableText(text: string): string {
        let normalized = this.stripBrowserJunk(text).replace(INLINE_DECORATION_RE, "");

        // Strip Obsidian block IDs only when they appear as standalone tokens (usually at end of blocks),
        // but preserve math exponents like a^2 and literal footnote references like [^s].
        normalized = normalized.replace(/(^|[ \t])\^[a-zA-Z0-9-]+(?=\s|$)/g, "$1");

        return normalized.replace(/\s+/g, " ").trim();
    }

    splitMarkdownLine(line: string): MarkdownLineParts {
        const indentMatch = line.match(/^\s*/);
        const indent = indentMatch ? indentMatch[0] : "";
        let remainder = line.substring(indent.length);
        let prefix = "";
        const prefixPatterns = [
            /^>\s*/,
            /^#{1,6}\s+/,
            /^-\s\[[ xX]\]\s+/,
            /^[-*+]\s+/,
            /^\d{1,3}[.)]\s+/,
            /^\[\^[^\]]+\]:\s*/,
        ];

        let matched = true;
        while (matched && remainder) {
            matched = false;
            for (const pattern of prefixPatterns) {
                const match = remainder.match(pattern);
                if (match) {
                    prefix += match[0];
                    remainder = remainder.substring(match[0].length);
                    matched = true;
                    break;
                }
            }
        }

        return { indent, prefix, content: remainder };
    }

    lineMatches(source: string, target: string): boolean {
        if (!source || !target) {
            return false;
        }
        if (source === target) {
            return true;
        }
        if (source.includes(target) || target.includes(source)) {
            return true;
        }

        const fuzzySource = this.normalizeForFuzzySearch(source);
        const fuzzyTarget = this.normalizeForFuzzySearch(target);
        if (!fuzzySource || !fuzzyTarget) {
            return false;
        }

        return fuzzySource === fuzzyTarget || fuzzySource.includes(fuzzyTarget) || fuzzyTarget.includes(fuzzySource);
    }

    findFuzzyCandidates(text: string, snippet: string, bodyStart = 0): Candidate[] {
        const needle = this.normalizeForFuzzySearch(snippet);
        if (!needle) {
            return [];
        }

        const { normalized, map } = this.buildFuzzyMap(text);
        if (!normalized) {
            return [];
        }

        const candidates: Candidate[] = [];
        let fromIndex = 0;
        while (fromIndex < normalized.length) {
            const matchIndex = normalized.indexOf(needle, fromIndex);
            if (matchIndex === -1) {
                break;
            }

            const rawStart = map[matchIndex];
            const rawEnd = map[matchIndex + needle.length - 1] + 1;
            if (rawStart >= bodyStart) {
                candidates.push({
                    start: rawStart,
                    end: rawEnd,
                    text: text.substring(rawStart, rawEnd),
                });
            }
            fromIndex = matchIndex + 1;
        }

        return this.dedupeCandidates(candidates);
    }

    /**
     * Hybrid Mapping Engine: Find candidates by word-only normalization
     * This is extremely resilient to inline scholarly markers.
     */
    findHybridCandidates(text: string, snippet: string, bodyStart = 0): Candidate[] {
        const needle = this.normalizeForFuzzySearch(snippet);
        if (!needle) return [];

        const { normalized, map } = this.buildHybridMap(text);
        const candidates: Candidate[] = [];
        let fromIndex = 0;

        // Direct search in normalized space
        while (fromIndex < normalized.length) {
            const matchIdx = normalized.indexOf(needle, fromIndex);
            if (matchIdx === -1) break;

            const rawStart = map[matchIdx];
            const rawEnd = map[matchIdx + needle.length - 1] + 1;

            if (rawStart >= bodyStart) {
                candidates.push({
                    start: rawStart,
                    end: rawEnd,
                    text: text.substring(rawStart, rawEnd),
                });
            }
            fromIndex = matchIdx + 1;
        }

        return this.dedupeCandidates(candidates);
    }

    /**
     * Builds a map of "Content Only" (alphanumeric) characters to original offsets.
     * Strips all formatting and punctuation but preserves word positions.
     * Case-insensitive for maximum resilience.
     */
    buildHybridMap(text: string): FuzzyMap {
        let normalized = "";
        const map: number[] = [];
        let offset = 0;

        // Character by character mapping
        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            // Lookahead/Backbehind for [x] or [X] task markers to skip them
            // as they are not visible in browser selection snippets.
            if ((char === "x" || char === "X" || char === " ") && text[i - 1] === "[" && text[i + 1] === "]") {
                offset++;
                continue;
            }

            if (/[\p{L}\p{N}]/u.test(char)) {
                normalized += char.toLocaleLowerCase();
                map.push(offset);
            }
            offset += char.length;
        }

        return { normalized, map };
    }

    /**
     * Structural Guardrail: "Snaps" highlight boundaries to avoid breaking
     * footnotes, list markers, and callout headers.
     */
    snapToStructuralBoundaries(fullRaw: string, candidate: Candidate): Candidate {
        const prefixPatterns = [
            /^\[\^[^\]]+\]:\s*/, // Footnote entry
            /^>\s*\[![^\]]+\]\s*/, // Callout header
            /^#{1,6}\s+/, // Headings
            /^-\s\[[ xX]\]\s+/, // Task list
            /^[-*+]\s+/, // Unordered list
            /^\d{1,3}[.)]\s+/, // Ordered list
        ];

        // Find the start of the line containing the match
        const lineStart = fullRaw.lastIndexOf("\n", candidate.start) + 1;
        const lineContent = fullRaw.substring(lineStart, candidate.end);

        for (const pattern of prefixPatterns) {
            const match = lineContent.match(pattern);
            if (match) {
                const prefixEndInRaw = lineStart + match[0].length;
                // If our highlight selection spans into the prefix, push it forward
                if (candidate.start < prefixEndInRaw) {
                    return {
                        ...candidate,
                        start: prefixEndInRaw,
                        text: fullRaw.substring(prefixEndInRaw, candidate.end),
                    };
                }
            }
        }

        return candidate;
    }

    buildFuzzyMap(text: string): FuzzyMap {
        let normalized = "";
        const map: number[] = [];

        let offset = 0;
        for (const char of text) {
            if (/[\p{L}\p{N}]/u.test(char)) {
                normalized += char.toLocaleLowerCase();
                map.push(offset);
            }
            offset += char.length;
        }

        return { normalized, map };
    }

    normalizeForFuzzySearch(text: string): string {
        return [...this.normalizeComparableText(text)]
            .filter((char) => /[\p{L}\p{N}]/u.test(char))
            .join("")
            .toLocaleLowerCase();
    }

    dedupeCandidates(candidates: Candidate[]): Candidate[] {
        const seen = new Set();
        return candidates.filter((candidate) => {
            const key = `${candidate.start}:${candidate.end}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    offsetCandidates(candidates: Candidate[], offset: number): Candidate[] {
        return candidates.map((candidate) => ({
            ...candidate,
            start: candidate.start + offset,
            end: candidate.end + offset,
        }));
    }

    calculateSimilarity(source: string, target: string): number {
        if (source === target) return 1e3;
        const sSet = new Set(source.split(" "));
        const tSet = new Set(target.split(" "));
        let intersection = 0;
        for (const token of tSet) {
            if (sSet.has(token)) intersection++;
        }
        const union = new Set([...sSet, ...tSet]).size;
        const jaccard = union === 0 ? 0 : intersection / union;
        const lenMultiplier = 1 / (1 + Math.abs(source.length - target.length) * 0.1);
        return jaccard * 0.7 + lenMultiplier * 0.3;
    }

    /**
     * Word-Proximity Matching Strategy (Defined)
     * Finds the densest cluster of words from the snippet within the activeDocument.
     */
    findProximityCandidates(text: string, snippet: string, bodyStart = 0): Candidate[] {
        const words = snippet
            .split(/\s+/)
            .filter((w) => w.length > 2)
            .map((w) => w.toLocaleLowerCase());
        if (words.length < 3) return []; // Too few words for reliable proximity

        const lowerText = text.toLocaleLowerCase();
        const hits: { word: string; offset: number }[] = [];
        for (const word of words) {
            let idx = lowerText.indexOf(word, bodyStart);
            while (idx !== -1) {
                hits.push({ word, offset: idx });
                idx = lowerText.indexOf(word, idx + 1);
            }
        }
        if (hits.length === 0) return [];
        hits.sort((a, b) => a.offset - b.offset);

        const candidates: Candidate[] = [];
        const windowSize = snippet.length * 2.5;

        for (let i = 0; i < hits.length; i++) {
            const startHit = hits[i];
            const cluster = [startHit];
            let j = i + 1;
            while (j < hits.length && hits[j].offset - startHit.offset < windowSize) {
                cluster.push(hits[j]);
                j++;
            }

            const uniqueWords = new Set(cluster.map((h) => h.word)).size;
            const coverage = uniqueWords / words.length;

            if (coverage >= 0.8) {
                const clusterStart = cluster[0].offset;
                const lastHit = cluster[cluster.length - 1];
                const clusterEnd = lastHit.offset + lastHit.word.length;

                candidates.push({
                    start: clusterStart,
                    end: clusterEnd,
                    text: text.substring(clusterStart, clusterEnd),
                    score: coverage,
                });
            }
        }

        return candidates
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, 3)
            .map((c) => ({ start: c.start, end: c.end, text: c.text }));
    }

    classifyFailure(
        rawSnippet: string,
        cleanedSnippet: string,
        bodyContent: string,
        diagnostics: Diagnostics
    ): FailureReport {
        const report: FailureReport = {
            type: "UNKNOWN",
            reason: "The engine could not locate this text in the Markdown source.",
            hint: "This usually happens when the browser's view of the text differs significantly from the raw file.",
            rawSnippet,
            cleanedSnippet,
            diagnostics,
            bestGuessContext: "",
        };

        const firstWord = cleanedSnippet.split(/\s+/)[0].toLocaleLowerCase();
        if (firstWord && !bodyContent.toLocaleLowerCase().includes(firstWord)) {
            report.type = "PHANTOM";
            report.reason = "Text not found in the current file.";
            report.hint =
                "This text appears to come from an embedded note. Open the source note directly and highlight it there.";
            return report;
        }

        // Attempt to extract 'Best Guess' context from diagnostics (Strategy 5 or 6)
        const proximity = diagnostics.strategies.proximityMatch;
        const fuzzy = diagnostics.strategies.fuzzyMatch;
        let candidates: Candidate[] =
            proximity && (proximity.found ?? 0) > 0
                ? (proximity.results ?? [])
                : fuzzy && (fuzzy.found ?? 0) > 0
                  ? (fuzzy.results ?? [])
                  : [];

        // Guaranteed Fallback: If no candidates, conduct a Brute Force word search
        if (candidates.length === 0) {
            const words = cleanedSnippet
                .split(/\s+/)
                .filter((w) => w.length > 3)
                .sort((a, b) => b.length - a.length);
            if (words.length > 0) {
                const bestWord = words[0].toLocaleLowerCase();
                const idx = bodyContent.toLocaleLowerCase().indexOf(bestWord);
                if (idx !== -1) {
                    candidates = [{ start: idx, end: idx + bestWord.length }];
                }
            }
        }

        if (candidates.length > 0) {
            const best = candidates[0];
            // Expand the match to the surrounding paragraph for context
            let start = best.start;
            let end = best.end;

            while (start > 0 && bodyContent[start - 1] !== "\n") start--;
            while (end < bodyContent.length && bodyContent[end] !== "\n") end++;

            report.bestGuessContext = bodyContent.substring(start, end).trim();
        } else {
            // Absolute last resort: return the raw snippet (at least it's not empty)
            report.bestGuessContext = rawSnippet;
        }

        report.type = "DECORATION_MISMATCH";
        report.reason = "Structural mismatch detected.";
        report.hint = "The selection contains markers or formatting the engine couldn't map automatically.";

        return report;
    }
}
