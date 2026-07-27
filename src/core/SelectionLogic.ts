import { App, TFile, MarkdownView } from "obsidian";

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
        withinBlockOffset: number | null = null
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

        const bodyBlocks = this.createDocumentBlockRecords(bodyContent);
        const result = this.resolveCandidates(
            candidates,
            fullRaw,
            selectionSnippet,
            context,
            occurrenceIndex,
            withinBlockOffset,
            bodyBlocks
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
            /\]\([^)]+\)/g,
            // Markdown Images: ![caption](url)
            /!\[[^\]]*\]\([^)]+\)/g,
            // Global HTML Tags (Reading view strips these)
            // ponytail: must start with a letter so literal `<2%`, `<3rd`, `5 < 10` are not consumed
            /<\/?[a-zA-Z][^>]*>/g,
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

    resolveCandidates(
        candidates: Candidate[],
        raw: string,
        snippet: string,
        context: string | null,
        occurrenceIndex: number,
        withinBlockOffset: number | null = null,
        bodyBlocks: { start: number; end: number }[] = []
    ): { raw: string; start: number; end: number } | null {
        if (candidates.length === 0) return null;

        if (context) {
            const cleanContext = context.replace(/\s+/g, " ").trim();
            const scored = candidates.map((cand) => {
                const sourceBlock = (cand.text || raw.substring(cand.start, cand.end)).replace(/\s+/g, " ").trim();
                const score = this.calculateSimilarity(sourceBlock, cleanContext);
                return { ...cand, score };
            });

            const bestScore = Math.max(...scored.map((candidate) => candidate.score ?? 0));
            const threshold = bestScore * 0.85;
            const validCandidates = scored.filter((candidate) => (candidate.score ?? 0) >= threshold);

            const chosen = SelectionLogic.pickBestCandidate(
                validCandidates,
                raw,
                snippet,
                cleanContext,
                occurrenceIndex,
                withinBlockOffset,
                bodyBlocks
            );
            if (chosen) {
                return { raw, start: chosen.start, end: chosen.end };
            }
        }

        return { raw, start: candidates[0].start, end: candidates[0].end };
    }

    /**
     * Pure disambiguation helper. Returns the candidate that best matches the
     * user's actual selection when the snippet appears more than once.
     *
     * Tries, in order:
     *   1. If the snippet appears multiple times in `context`, pick the i-th
     *      occurrence where i is the index whose start is closest to
     *      `withinBlockOffset`. (Within-block disambiguation.)
     *   2. Otherwise, if `bodyBlocks[occurrenceIndex]` is a valid block range,
     *      filter candidates to that block and return the only one (or the
     *      first). (Block-level disambiguation using the existing
     *      `occurrenceIndex`.)
     *   3. Otherwise, fall back to `candidates[occurrenceIndex]` or the first.
     *
     * Pure: no `this`, no DOM, no `app`. Safe to unit-test.
     */
    static pickBestCandidate(
        candidates: Candidate[],
        raw: string,
        snippet: string,
        context: string,
        occurrenceIndex: number,
        withinBlockOffset: number | null,
        bodyBlocks: { start: number; end: number }[]
    ): Candidate | null {
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

        const sortedByStart = [...candidates].sort((a, b) => a.start - b.start);
        const trimmedContext = context.trim();
        const trimmedSnippet = snippet.trim();

        // Strategy 1: coarse-to-fine anchor search.
        //
        // Idea (from user): pick the whole paragraph as the search anchor.
        // Build a flexible regex that allows inline markers (`**`, `~~`, `` ` ``,
        // etc.) between the chars of the context, then search `raw` for it.
        // Each match is a candidate position of the user's block in the body.
        //
        // For each candidate block-start, filter the body-candidates to that
        // block range, then prefer the case-matching candidate, then use
        // `withinBlockOffset` as a final tie-breaker. If only one block
        // matches, the answer is unambiguous. If multiple blocks match
        // (duplicate paragraphs in the note), pick the block whose
        // surrounding body text best matches the context.
        if (trimmedContext) {
            const blockStarts = SelectionLogic.findContextInBody(trimmedContext, raw);
            if (blockStarts.length > 0) {
                const rankedBlocks = SelectionLogic.rankBlocksByContext(
                    blockStarts,
                    trimmedContext,
                    raw
                );

                // Try the highest-ranked block first; fall through to the next
                // if it has zero candidates (shouldn't happen, but be safe).
                for (const blockStart of rankedBlocks) {
                    const approxBlockLen = Math.max(
                        trimmedContext.length,
                        40 // paranoia: short contexts
                    );
                    const blockEnd = blockStart + approxBlockLen + 32; // slack for inline markers
                    const inBlock = sortedByStart.filter(
                        (c) => c.start >= blockStart && c.start < blockEnd
                    );
                    if (inBlock.length === 0) continue;
                    if (inBlock.length === 1) return inBlock[0];

                    // Case-sensitive preference: if any candidate's normalised
                    // text matches the snippet's case, prefer those. This is
                    // the dominant signal when the same line has "Cancer" and
                    // "cancer" — the user almost always wants the case they
                    // clicked on.
                    const caseMatched = inBlock.filter((c) => {
                        const norm = SelectionLogic.normalizeSnippetTextForContext(
                            c.text || ""
                        );
                        return norm === trimmedSnippet;
                    });
                    if (caseMatched.length === 1) return caseMatched[0];
                    if (caseMatched.length > 1) {
                        // Multiple case-matches in this block — fall through
                        // to the position-based tie-breaker below with the
                        // narrowed set.
                        const refined = caseMatched;
                        const result = SelectionLogic.pickByInBlockOffset(
                            refined,
                            blockStart,
                            withinBlockOffset
                        );
                        if (result) return result;
                        continue;
                    }
                    // 0 case-matches: fall through to position-based with
                    // all inBlock candidates.
                    if (withinBlockOffset === null) {
                        // No tie-breaker available; warn and pick the first.
                        console.warn(
                            `[Highlighter] ambiguous occurrence: ${inBlock.length} candidates in matched block, no withinBlockOffset, picked first`
                        );
                        return inBlock[0];
                    }
                    const result = SelectionLogic.pickByInBlockOffset(
                        inBlock,
                        blockStart,
                        withinBlockOffset
                    );
                    if (result) return result;
                }
            }
        }

        // Strategy 2: block-level disambiguation via bodyBlocks + occurrenceIndex
        if (bodyBlocks.length > 0 && occurrenceIndex >= 0 && occurrenceIndex < bodyBlocks.length) {
            const block = bodyBlocks[occurrenceIndex];
            const inBlock = sortedByStart.filter((c) => c.start >= block.start && c.start < block.end);
            if (inBlock.length === 1) return inBlock[0];
            if (inBlock.length > 1) {
                if (withinBlockOffset !== null) {
                    let best = inBlock[0];
                    let bestDist = Math.abs(inBlock[0].start - block.start - withinBlockOffset);
                    for (let k = 1; k < inBlock.length; k++) {
                        const dist = Math.abs(inBlock[k].start - block.start - withinBlockOffset);
                        if (dist < bestDist) {
                            best = inBlock[k];
                            bestDist = dist;
                        }
                    }
                    if (bestDist > 0) {
                        console.warn(
                            `[Highlighter] ambiguous occurrence: ${inBlock.length} candidates remaining at offset ${withinBlockOffset}`
                        );
                    }
                    return best;
                }
                console.warn(
                    `[Highlighter] ambiguous occurrence: ${inBlock.length} candidates remaining in block ${occurrenceIndex}`
                );
                return inBlock[0];
            }
        }

        // Strategy 3: legacy fallback
        if (occurrenceIndex >= 0 && occurrenceIndex < sortedByStart.length) {
            const chosen = sortedByStart[occurrenceIndex];
            const isAmbiguous = sortedByStart.some(
                (c, i) => i !== occurrenceIndex && c.start === chosen.start
            );
            if (isAmbiguous) {
                console.warn(
                    `[Highlighter] ambiguous occurrence: ${sortedByStart.length} candidates remaining at offset ${chosen.start}`
                );
            }
            return chosen;
        }
        return sortedByStart[0];
    }

    /**
     * Find every body offset where the rendered context could live in `raw`.
     * The body may have inline markers between the chars of the context, so
     * we use a flexible regex that allows markers between every char.
     *
     * Returns positions sorted ascending. Empty array means the context
     * could not be located (caller falls through to the next strategy).
     */
    static findContextInBody(context: string, raw: string): number[] {
        // Coarse anchor: use up to the first 40 chars of the context. For a
        // full paragraph this is still highly specific; for short contexts
        // (a list item) it is the whole string.
        const anchorLen = Math.min(context.length, 40);
        const anchor = context.substring(0, anchorLen);
        if (anchor.length < 1) return [];

        const pattern = SelectionLogic.buildFlexibleContextPattern(anchor);
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, "gmu");
        } catch {
            return [];
        }

        const starts: number[] = [];
        try {
            let m: RegExpExecArray | null;
            let guard = 0;
            while ((m = regex.exec(raw)) !== null && guard++ < 100) {
                starts.push(m.index);
                if (m.index === regex.lastIndex) regex.lastIndex++; // avoid infinite loop
            }
        } catch {
            // regex failure — return what we have
        }
        return starts;
    }

    /**
     * Rank candidate block-starts by how well the surrounding body text
     * matches the context. Higher = better. Returns the input sorted
     * descending by score, ties broken by start ascending.
     */
    static rankBlocksByContext(blockStarts: number[], context: string, raw: string): number[] {
        const ctxWords = new Set(context.toLowerCase().split(/\s+/).filter((w) => w.length > 1));
        const scored = blockStarts.map((start) => {
            const windowStart = Math.max(0, start - 20);
            const windowEnd = Math.min(raw.length, start + context.length + 100);
            const window = raw.substring(windowStart, windowEnd);
            const normalizedWindow = SelectionLogic.normalizeSnippetTextForContext(window);
            const winWords = new Set(normalizedWindow.toLowerCase().split(/\s+/).filter((w) => w.length > 1));
            let intersection = 0;
            for (const w of ctxWords) if (winWords.has(w)) intersection++;
            const union = new Set([...ctxWords, ...winWords]).size;
            const score = union === 0 ? 0 : intersection / union;
            return { start, score };
        });
        scored.sort((a, b) => (b.score - a.score) || (a.start - b.start));
        return scored.map((s) => s.start);
    }

    /**
     * Build a flexible regex pattern from a string, allowing inline Markdown
     * markers between every character. The body may intersperse `**`, `~~`,
     * `` ` ``, `[`, `]`, etc. between the visible chars of the context.
     */
    static buildFlexibleContextPattern(text: string): string {
        const parts: string[] = [];
        for (const ch of text) {
            if (/\s/.test(ch)) {
                parts.push("\\s+");
            } else {
                parts.push(ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"));
            }
        }
        const joined = parts.join(`(?:${INLINE_DECORATION_PATTERN}){0,3}`);
        return `(?:${INLINE_DECORATION_PATTERN}){0,3}${joined}(?:${INLINE_DECORATION_PATTERN}){0,3}`;
    }

    /**
     * Pick the candidate in `cands` whose start is closest to
     * `blockStart + withinBlockOffset`. Returns null if `withinBlockOffset`
     * is null.
     */
    static pickByInBlockOffset(
        cands: Candidate[],
        blockStart: number,
        withinBlockOffset: number | null
    ): Candidate | null {
        if (withinBlockOffset === null || cands.length === 0) return null;
        const expected = blockStart + Math.max(0, withinBlockOffset);
        let best = cands[0];
        let bestDist = Math.abs(cands[0].start - expected);
        for (let k = 1; k < cands.length; k++) {
            const dist = Math.abs(cands[k].start - expected);
            if (dist < bestDist) {
                best = cands[k];
                bestDist = dist;
            }
        }
        const hasTie = cands.some((c) => c !== best && c.start === best.start);
        if (hasTie) {
            console.warn(
                `[Highlighter] ambiguous occurrence: ${cands.length} candidates in matched block at offset ${best.start}, picked first`
            );
        }
        return best;
    }

    /**
     * Symmetric removal helper. Find the `==` highlight wrapper that
     * CONTAINS the position `pos` (i.e. the opening `==` of the pair whose
     * closing `==` is at or after `pos`). Returns the position of the
     * opening `==`, or -1 if none.
     *
     * Unlike the inline expansion in main.ts, this walks back through the
     * body counting `==` pairs to find the correct opening — it works for
     * multi-word highlights like `==Cervical Cancer==` where the `==` is
     * not immediately adjacent to the selection.
     */
    static findOpeningEqMarker(raw: string, pos: number, bodyStart: number): number {
        let fromIdx = pos;
        while (fromIdx > bodyStart) {
            const idx = raw.lastIndexOf("==", fromIdx);
            if (idx === -1 || idx < bodyStart) return -1;
            // An opening marker has an even `==` count before it.
            const beforeCount = (raw.substring(bodyStart, idx).match(/==/g) || []).length;
            if (beforeCount % 2 === 0) {
                // Verify pos is in the pair (idx, closeIdx)
                const closeIdx = raw.indexOf("==", idx + 2);
                if (closeIdx !== -1 && pos < closeIdx) {
                    return idx;
                }
                // pos is after the pair; this highlight doesn't contain pos.
                return -1;
            }
            fromIdx = idx - 1;
        }
        return -1;
    }

    /**
     * Split a body string into contiguous paragraph blocks (separated by blank
     * lines). Used to map the rendered block element back to a source range.
     * Cheap, regex-based; no markdown parsing.
     */
    createDocumentBlockRecords(text: string): { start: number; end: number }[] {
        const blocks: { start: number; end: number }[] = [];
        let cursor = 0;
        const re = /[^\n]+(?:\n[^\n]+)*/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const blockStart = m.index;
            const blockEnd = m.index + m[0].length;
            // Skip the block if it is just whitespace and the next char is a blank line
            if (blockStart > cursor) {
                blocks.push({ start: cursor, end: blockStart });
            }
            blocks.push({ start: blockStart, end: blockEnd });
            cursor = blockEnd;
        }
        if (cursor < text.length) {
            blocks.push({ start: cursor, end: text.length });
        }
        return blocks;
    }

    /**
     * Strip inline Markdown formatting markers from a snippet's raw text so it
     * can be found inside a rendered-DOM context string. Pure, stateless.
     */
    static normalizeSnippetTextForContext(raw: string): string {
        if (!raw) return "";
        return raw
            .replace(INLINE_DECORATION_RE, "")
            .replace(/\[\^[^\]]+\]/g, "")
            .replace(/\^[a-zA-Z0-9-]+(?=\s|$)/g, "")
            .replace(/\s+/g, " ")
            .trim();
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

        // ponytail: normalizeComparableText runs once per failed selection (cold path, sub-millisecond, no caching needed).
        // Normalize both sides the same way the candidate strategies do, so smart quotes, em-dashes, NBSPs, and inline
        // decoration markers (`**`, `==`, `<mark>`) cannot create a false PHANTOM just because the cleaned snippet has
        // them folded differently from the raw body.
        const normalizedBody = this.normalizeComparableText(bodyContent).toLocaleLowerCase();
        const normalizedSnippet = this.normalizeComparableText(cleanedSnippet);
        const anchorWords = normalizedSnippet
            .split(/\s+/)
            .filter((w) => w.length > 2)
            .sort((a, b) => b.length - a.length);
        const anchor = anchorWords[0];
        if (anchor && !normalizedBody.includes(anchor.toLocaleLowerCase())) {
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
