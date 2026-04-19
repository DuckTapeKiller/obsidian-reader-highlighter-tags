/**
 * Core Selection Logic
 * "Block Anchoring" Strategy with Ordinal Ranking:
 * 1. Find all occurrences of the snippet in the source (Exact match first, then Stripped/Markdown-Agnostic match).
 * 2. Calculate context similarity score for ALL candidates.
 * 3. Filter to keep only "valid" candidates (score ~ best score).
 * 4. Select the k-th valid candidate based on occurrenceIndex.
 */

export class SelectionLogic {
    constructor(app) {
        this.app = app;
    }

    async locateSelection(processedFile, view, selectionSnippet, context = null, occurrenceIndex = 0) {
        const snippet = this.stripBrowserJunk(selectionSnippet);
        const activeFile = view.file;
        
        // DEEP-RESOLUTION: Build virtual content of the view (including embeds)
        // Operation-level cache to prevent redundant reads and handle duplicate embeds
        const opContext = { cache: new Map(), visited: new Set() };
        const virtual = await this.resolveVirtualContent(activeFile, 0, opContext);
        const fullRaw = virtual.text;

        // FRONT MATTER SHIELD: Still needed for the main file if it has YAML
        // We'll calculate it based on the first segment (which is always the main file)
        let firstSegmentBodyStart = 0;
        if (fullRaw.startsWith('---')) {
            const secondDash = fullRaw.indexOf('---', 3);
            if (secondDash !== -1) {
                firstSegmentBodyStart = secondDash + 3;
                while (firstSegmentBodyStart < fullRaw.length && (fullRaw[firstSegmentBodyStart] === '\n' || fullRaw[firstSegmentBodyStart] === '\r')) {
                    firstSegmentBodyStart++;
                }
            }
        }

        // ISOLATED BODY SEARCH: Search in the full virtual content
        // (The shield only applies to the very beginning of the main file)
        const bodyContent = fullRaw.substring(firstSegmentBodyStart);

        // 1. Try standard search
        let candidates = this.findAllCandidates(bodyContent, snippet, 0);
        candidates = candidates.map(c => ({ ...c, start: c.start + firstSegmentBodyStart, end: c.end + firstSegmentBodyStart }));
        
        if (candidates.length === 0) {
            // 2. Try Stripped search
            candidates = this.findCandidatesStripped(bodyContent, snippet, 0);
            candidates = candidates.map(c => ({ ...c, start: c.start + firstSegmentBodyStart, end: c.end + firstSegmentBodyStart }));
        }

        if (candidates.length === 0) {
            // 3. Anchor fallback: match safe (non-math) words around rendered math
            candidates = this.findCandidatesAnchored(bodyContent, snippet, 0);
            candidates = candidates.map(c => ({ ...c, start: c.start + firstSegmentBodyStart, end: c.end + firstSegmentBodyStart }));
        }

        if (candidates.length > 0) {
            const result = this.resolveCandidates(candidates, fullRaw, context, occurrenceIndex);
            if (result) {
                // Map the virtual start/end back to a physical file and offset
                return this.mapVirtualToPhysical(result.start, result.end, virtual.segments);
            }
        }

        return null;
    }

    async resolveVirtualContent(file, depth = 0, opContext = { cache: new Map(), visited: new Set() }) {
        if (depth > 5) {
            return { text: "", segments: [] };
        }

        // Return cached result if disk was already read for this file in this operation
        if (opContext.cache.has(file.path)) {
            return opContext.cache.get(file.path);
        }

        // Recursion shield (prevents A embedding A)
        if (opContext.visited.has(file.path)) {
            return { text: "", segments: [] };
        }
        opContext.visited.add(file.path);

        let raw = await this.app.vault.read(file);
        
        // EMBED YAML SHIELD: Remove front matter from embedded notes.
        // We track how many characters were removed (fmOffset) so that embed
        // positions from metadataCache (which reference the original file) can
        // be correctly adjusted to point into the stripped string.
        let fmOffset = 0;
        if (depth > 0 && raw.startsWith('---')) {
            const originalLength = raw.length;
            const secondDash = raw.indexOf('---', 3);
            if (secondDash !== -1) {
                raw = raw.substring(secondDash + 3);
                // Move past trailing newlines
                while (raw.startsWith('\n') || raw.startsWith('\r')) {
                    raw = raw.substring(1);
                }
                fmOffset = originalLength - raw.length;
            }
        }

        const cache = this.app.metadataCache.getFileCache(file);
        const embeds = cache?.embeds || [];
        
        // Sort embeds by offset to process them in order
        const sortedEmbeds = [...embeds].sort((a, b) => a.position.start.offset - b.position.start.offset);
        
        let virtualText = "";
        const segments = [];
        let lastOffset = 0;

        for (const embed of sortedEmbeds) {
            const adjustedStart = embed.position.start.offset - fmOffset;
            const adjustedEnd = embed.position.end.offset - fmOffset;

            // Ensure we don't try to process embeds that were inside the stripped frontmatter
            if (adjustedStart < 0) continue;

            // Add text before the embed
            const preText = raw.substring(lastOffset, adjustedStart);
            const segStart = virtualText.length;
            virtualText += preText;
            segments.push({
                vStart: segStart,
                vEnd: virtualText.length,
                file: file,
                pOffset: lastOffset + fmOffset
            });

            // Resolve the embed
            const targetFile = this.app.metadataCache.getFirstLinkpathDest(embed.link.split('#')[0], file.path);
            if (targetFile) {
                // Fork the visited set for the sub-branch to allow sibling duplicates
                const subContext = { ...opContext, visited: new Set(opContext.visited) };
                const subVirtual = await this.resolveVirtualContent(targetFile, depth + 1, subContext);
                const embedStart = virtualText.length;
                virtualText += subVirtual.text;
                
                // Add sub-segments with adjusted virtual offsets
                for (const subSeg of subVirtual.segments) {
                    segments.push({
                        vStart: subSeg.vStart + embedStart,
                        vEnd: subSeg.vEnd + embedStart,
                        file: subSeg.file,
                        pOffset: subSeg.pOffset
                    });
                }
            } else {
                // Keep the original embed text if target not found
                const embedText = raw.substring(adjustedStart, adjustedEnd);
                const segStart = virtualText.length;
                virtualText += embedText;
                segments.push({
                    vStart: segStart,
                    vEnd: virtualText.length,
                    file: file,
                    pOffset: adjustedStart + fmOffset
                });
            }
            lastOffset = adjustedEnd;
        }

        // Add remaining text
        const tailText = raw.substring(lastOffset);
        const tailStart = virtualText.length;
        virtualText += tailText;
        segments.push({
            vStart: tailStart,
            vEnd: virtualText.length,
            file: file,
            pOffset: lastOffset + fmOffset
        });

        const result = { text: virtualText, segments };
        opContext.cache.set(file.path, result);
        return result;
    }

    mapVirtualToPhysical(vStart, vEnd, segments) {
        // Find segment containing the start
        const startSeg = segments.find(s => vStart >= s.vStart && vStart < s.vEnd);
        const endSeg = segments.find(s => vEnd > s.vStart && vEnd <= s.vEnd);
        
        if (!startSeg || !endSeg) return null;

        const pStart = startSeg.pOffset + (vStart - startSeg.vStart);
        const pEnd = endSeg.pOffset + (vEnd - endSeg.vStart);
        
        // ARCHITECTURAL NOTE: We return raw: "" as an explicit contract requiring the
        // caller (main.js) to re-read the file. This ensures we always work with the
        // freshest content for expansion and prevents stale-state highlights.
        return {
            file: startSeg.file,
            start: pStart,
            end: pEnd,
            raw: ""
        };
    }

    resolveCandidates(candidates, raw, context, occurrenceIndex) {
        if (candidates.length === 0) return null;

        // If context is provided, we filter candidates to only those that match the context.
        if (context) {
            const cleanContext = context.replace(/\s+/g, ' ').trim();

            // Step 1: Score all candidates
            candidates = candidates.map(cand => {
                // Get source block (lines around candidate)
                let blockStart = raw.lastIndexOf('\n', cand.start);
                if (blockStart === -1) blockStart = 0;
                let blockEnd = raw.indexOf('\n', cand.end);
                if (blockEnd === -1) blockEnd = raw.length;

                const sourceBlock = raw.substring(blockStart, blockEnd).replace(/\s+/g, ' ').trim();
                const score = this.calculateSimilarity(sourceBlock, cleanContext);
                return { ...cand, score };
            });

            // Step 2: Determine validity threshold
            const bestScore = Math.max(...candidates.map(c => c.score));
            const threshold = bestScore * 0.85;

            // Filter
            const validCandidates = candidates.filter(c => c.score >= threshold);

            // Step 3: Use Ordinal Index
            if (occurrenceIndex >= 0 && occurrenceIndex < validCandidates.length) {
                const chosen = validCandidates[occurrenceIndex];
                return { raw, start: chosen.start, end: chosen.end };
            }

            // Fallback
            if (validCandidates.length > 0) {
                return { raw, start: validCandidates[0].start, end: validCandidates[0].end };
            }
        }

        // No context or fallback
        return { raw, start: candidates[0].start, end: candidates[0].end };
    }

    createFlexiblePattern(snippet) {
        // NON-BACKTRACKING GAP PATTERN
        // This includes whitespace, arrows, markers, and Markdown symbols (*, _, ~, =).
        const gapPattern = '[\\s\\u21a9\\u21b5\\ufe0e\\ufe0f\\d\\.\\[\\](){}\\^:>\\*\\+\\#\\u00a0_~=\\-\\|\\u2013\\u2014\\u201c\\u201d\\u2018\\u2019\\u00ab\\u00bb]';
        
        // TOKENIZED PATTERN BUILDER
        // Every character in the snippet gets an optional gap after it to handle 
        // disappearing Markdown markers (**, *, _, [^], etc.) anywhere.
        let parts = [];
        for (let i = 0; i < snippet.length; i++) {
            const char = snippet[i];
            
            if (char.match(/\s/)) {
                // Collapse consecutive spaces into a single required gap
                if (parts.length > 0 && parts[parts.length-1].includes(gapPattern)) continue;
                parts.push(`(?:${gapPattern})+?`);
            } else {
                parts.push(this.escapeRegex(char));
                // Inject an optional gap after every character (Omni-Gap)
                if (i < snippet.length - 1) {
                    parts.push(`(?:${gapPattern})*?`);
                }
            }
        }
        
        const pattern = parts.join('');
        
        // Final pattern starts with optional MARKDOWN FORMATTING markers only.
        // IMPORTANT: We intentionally use a narrower set here than gapPattern.
        // gapPattern (used between characters) includes \s and \. which is fine
        // mid-match, but a leading gap that includes those characters can consume
        // the period + newlines at the end of a preceding paragraph, causing the
        // match to start there instead of at the actual snippet start.
        // This leading gap must only cover invisible inline formatting markers
        // (**, *, _, ~~, ==, >, #, etc.) that precede the first visible character
        // in raw Markdown but are absent from the user's rendered selection.
        const leadingMarkdownOnly = '[\\*_~=#>\\+\\|\\u21a9\\u21b5\\ufe0e\\ufe0f]';
        return `(?:${leadingMarkdownOnly})*?${pattern}`;
    }

    stripBrowserJunk(text) {
        if (!text) return text;
        
        return text.normalize('NFC')
            // 1. Arrows and variants -> space
            .replace(/[\u21a9\u21b5\ufe0e\ufe0f]+/g, ' ') 
            // 2. Normalized whitespace
            .replace(/[\u00a0\s]+/g, ' ')
            // 3. Smart Punctuation (em-dash, guillemets, etc.) -> space
            .replace(/[\u2013\u2014\u201c\u201d\u2018\u2019\u00ab\u00bb]+/g, ' ')
            // 4. Bracketed markers like [why?], [PDF], [123] (Footnotes in Reading View)
            // Removed trailing lookahead to handle notes followed by punctuation like [7])
            .replace(/\[(?:[0-9-]+|[a-zA-Z?]+)\]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    findAllCandidates(text, snippet, bodyStart = 0) {
        const cleanSnippet = snippet.trim();
        if (!cleanSnippet) return [];

        // EDGE ANCHORING for large selections (e.g., massive bibliographies)
        // If the snippet is huge, we anchor on the start and end to avoid regex engine limits.
        if (cleanSnippet.length > 800) {
            const startAnchor = cleanSnippet.substring(0, 150);
            const endAnchor = cleanSnippet.substring(cleanSnippet.length - 150);
            
            const startP = this.createFlexiblePattern(startAnchor);
            const startRegex = new RegExp(startP, 'g');
            const endRegex = new RegExp(this.createFlexiblePattern(endAnchor), 'g');
            
            const startMatches = [];
            const endMatches = [];
            
            let m;
            while ((m = startRegex.exec(text)) !== null) {
                if (m.index >= bodyStart) startMatches.push(m);
            }
            while ((m = endRegex.exec(text)) !== null) {
                if (m.index >= bodyStart) endMatches.push(m);
            }
            
            if (startMatches.length > 0 && endMatches.length > 0) {
                // Find a logical range: starting with a start match and ending with an end match
                for (const startM of startMatches) {
                    const bestEnd = endMatches.find(e => e.index > startM.index && (e.index - startM.index) < cleanSnippet.length * 2);
                    if (bestEnd) {
                        return [{
                            start: startM.index,
                            end: bestEnd.index + bestEnd[0].length,
                            text: text.substring(startM.index, bestEnd.index + bestEnd[0].length)
                        }];
                    }
                }
            }
        }

        const pattern = this.createFlexiblePattern(cleanSnippet);
        let regex;
        try {
            regex = new RegExp(pattern, 'g');
        } catch (e) {
            console.error("INVALID REGEX PATTERN:", pattern, e);
            return [];
        }
        const candidates = [];

        let match;
        while ((match = regex.exec(text)) !== null) {
            candidates.push({
                start: match.index,
                end: match.index + match[0].length,
                text: match[0]
            });
        }

        return candidates;
    }

    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    findCandidatesStripped(text, snippet, bodyStart = 0) {
        // Build a stripped version of the text and a map of indices.
        // This allows matching user selections (which see rendered text) to raw markdown positions.
        //
        // Handled constructs:
        // - Fenced code blocks: ```...```
        // - Markdown links: [text](url), [text](url "title"), ![alt](url)
        // - Reference-style links: [text][ref], ![alt][ref]
        // - Wiki links: [[note]], [[note|alias]]
        // - Obsidian embeds: ![[note]], ![[note|alias]]
        // - Inline code: `code`
        // - Math/LaTeX: $inline$, $$block$$
        // - Footnote references: [^1]
        // - Obsidian comments: %%hidden%%
        // - Autolinks: <https://...>, <email@...>
        // - HTML tags: <tag>, </tag>
        // - Escaped characters: \*, \_, etc.
        // - Formatting markers: ***, **, *, _, ~~, ==
        // - Callout markers: > [!info], > (continuation lines)
        // - Block IDs: ^block-id
        // - Table separator rows: |---|
        // - Table bars: |

        const map = []; // strippedIndex -> rawIndex
        let strippedRaw = "";

        // Helper: Check if character at position is a formatting marker to skip
        const isFormattingMarker = (str, pos) => {
            const char = str[pos];
            const next1 = str[pos + 1];
            const next2 = str[pos + 2];

            // Triple markers: *** (bold+italic)
            if (char === '*' && next1 === '*' && next2 === '*') {
                return 3;
            }
            // Double markers: ** ~~ ==
            if ((char === '*' && next1 === '*') ||
                (char === '~' && next1 === '~') ||
                (char === '=' && next1 === '=')) {
                return 2;
            }
            // Single markers: * _
            if (char === '*' || char === '_') {
                return 1;
            }
            return 0;
        };

        // Helper: Extract visible text from a range, stripping formatting markers
        const extractVisibleText = (startPos, endPos) => {
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

        // Helper: Add raw text without any stripping
        const addRawText = (startPos, endPos) => {
            for (let i = startPos; i < endPos; i++) {
                map.push(i);
                strippedRaw += text[i];
            }
        };

        // Comprehensive regex - ORDER MATTERS (more specific patterns first):
        // Group 1:  Fenced code block: ```lang\n...\n```
        // Group 2:  Obsidian embeds: ![[note]] or ![[note|alias]]
        // Group 3:  Image with reference: ![alt][ref]
        // Group 4:  Image with URL: ![alt](url) or ![alt](url "title")
        // Group 5:  Reference-style link: [text][ref]
        // Group 6:  Markdown link: [text](url) or [text](url "title")
        // Group 7:  Wiki link: [[note]] or [[note|alias]]
        // Group 8:  Footnote reference: [^id]
        // Group 9:  Block math: $$...$$
        // Group 10: Inline math: $...$
        // Group 11: Obsidian comment: %%...%%
        // Group 12: Inline code: `code`
        // Group 13: Autolink: <https://...> or <email@...>
        // Group 14: HTML tag: <tag> or </tag>
        // Group 15: Escaped character: \* \_ \[ etc.
        // Group 16: Triple formatting: ***
        // Group 17: Double formatting: ** ~~ ==
        // Group 18: Single formatting: * _
        // Group 19: Callout marker (header or continuation line)
        // Group 20: Block ID ^block-id
        // Group 21: Table Separator Row |---|
        // Group 22: Table Bar |

        const tokenRegex = new RegExp([
            // Group 1: Fenced code block ```...``` (must come before inline code)
            // Uses [\s\S]*? to match across newlines. The fence can have an optional language tag.
            /(`{3}[^\n]*\n[\s\S]*?`{3})/.source,
            // Group 2: Obsidian embed ![[...]]
            /(!\[\[(?:[^\]]+)\]\])/.source,
            // Group 3: Image with reference ![alt][ref]
            /(!\[(?:[^\]]*)\]\[(?:[^\]]*)\])/.source,
            // Group 4: Image with URL ![alt](url) or ![alt](url "title")
            /(!\[(?:[^\]]*)\]\((?:[^()"]*(?:\([^)]*\))?[^()"]*(?:"[^"]*")?)\))/.source,
            // Group 5: Reference-style link [text][ref] (ensure it's not a footnote [^id])
            /(\[(?!\^)(?:[^\]]+)\]\[(?:[^\]]*)\])/.source,
            // Group 6: Markdown link [text](url) or [text](url "title") (ensure it's not a footnote [^id])
            /(\[(?!\^)(?:[^\]]+)\]\((?:[^()"]*(?:\([^)]*\))?[^()"]*(?:"[^"]*")?)\))/.source,
            // Group 7: Wiki link [[...]]
            /(\[\[(?:[^\]]+)\]\])/.source,
            // Group 8: Footnote reference [^id] (optionally including colon/space for definitions)
            /(\[\^[^\]]+\]:?\s?)/.source,
            // Group 9: Block math $$...$$
            /(\$\$[^$]+\$\$)/.source,
            // Group 10: Inline math $...$  (non-greedy, no spaces around)
            /(\$(?:[^$\s]|[^$\s][^$]*[^$\s])\$)/.source,
            // Group 11: Obsidian comment %%...%%
            /(%%[^%]*%%)/.source,
            // Group 12: Inline code `...`
            /(`[^`]+`)/.source,
            // Group 13: Autolink <https://...> or <email@...>
            /(<(?:https?:\/\/[^>]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>)/.source,
            // Group 14: HTML tag <tag> or </tag>
            /(<\/?[a-zA-Z][^>]*>)/.source,
            // Group 15: Escaped character \X
            /(\\[*_\[\](){}#>+\-.!`~=|\\])/.source,
            // Group 16: Triple formatting ***
            /(\*\*\*)/.source,
            // Group 17: Double formatting ** ~~ ==
            /(\*\*|~~|==)/.source,
            // Group 18: Single formatting * _
            /(\*|_)/.source,
            // Group 19: Callout marker (header or continuation line)
            /(^[ \t]*>[ \t]?(?:\[![^\]]+\][ \t]?)?)/.source,
            // Group 20: Block ID ^block-id
            /([ \t]\^[a-zA-Z0-9-]+(?=\s|$))/.source,
            // Group 21: Table Separator Row |---|
            /(\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|)/.source,
            // Group 22: Table Bar |
            /(\|)/.source,
            // Group 23: Smart Punctuation & Dashes
            /([\u2013\u2014\u201c\u201d\u2018\u2019\u00ab\u00bb])/.source,
        ].join('|'), 'gm'); // Multiline mode is REQUIRED for the ^ marker in Group 19 (Callouts)

        let lastIndex = 0;
        let match;

        while ((match = tokenRegex.exec(text)) !== null) {
            // Process text BEFORE the match
            for (let i = lastIndex; i < match.index; i++) {
                map.push(i);
                strippedRaw += text[i];
            }

            const fullMatch = match[0];
            const matchStart = match.index;

            if (match[1]) {
                // FENCED CODE BLOCK: ```lang\n...\n```
                // Strip the opening fence line (```lang\n), keep the code content, strip closing fence.
                const firstNewline = fullMatch.indexOf('\n');
                if (firstNewline !== -1) {
                    // Content starts after the opening fence line
                    const codeStart = matchStart + firstNewline + 1;
                    // Content ends before the closing ``` (last 3 chars + possible newline before them)
                    const closingFence = fullMatch.lastIndexOf('```');
                    const codeEnd = closingFence !== -1
                        ? matchStart + closingFence
                        : matchStart + fullMatch.length;
                    addRawText(codeStart, codeEnd);
                }
            } else if (match[2]) {
                // OBSIDIAN EMBED: ![[note]] or ![[note|alias]]
                // Keep the visible text (note name or alias)
                const inner = fullMatch.substring(3, fullMatch.length - 2); // Remove ![[ and ]]
                const pipeIndex = inner.indexOf('|');
                if (pipeIndex !== -1) {
                    // Has alias: keep alias
                    const visibleStart = matchStart + 3 + pipeIndex + 1;
                    const visibleEnd = matchStart + fullMatch.length - 2;
                    extractVisibleText(visibleStart, visibleEnd);
                } else {
                    // No alias: keep note name
                    const visibleStart = matchStart + 3;
                    const visibleEnd = matchStart + fullMatch.length - 2;
                    extractVisibleText(visibleStart, visibleEnd);
                }
            } else if (match[3]) {
                // IMAGE WITH REFERENCE: ![alt][ref]
                // Keep alt text
                const closingBracket = fullMatch.indexOf('][');
                if (closingBracket !== -1) {
                    const altStart = matchStart + 2; // Skip '!['
                    const altEnd = matchStart + closingBracket;
                    extractVisibleText(altStart, altEnd);
                }
            } else if (match[4]) {
                // IMAGE WITH URL: ![alt](url)
                // Keep alt text
                const closingBracket = fullMatch.indexOf('](');
                if (closingBracket !== -1) {
                    const altStart = matchStart + 2; // Skip '!['
                    const altEnd = matchStart + closingBracket;
                    extractVisibleText(altStart, altEnd);
                }
            } else if (match[5]) {
                // REFERENCE-STYLE LINK: [text][ref]
                // Keep link text
                const closingBracket = fullMatch.indexOf('][');
                if (closingBracket !== -1) {
                    const textStart = matchStart + 1; // Skip '['
                    const textEnd = matchStart + closingBracket;
                    extractVisibleText(textStart, textEnd);
                }
            } else if (match[6]) {
                // MARKDOWN LINK: [text](url)
                // Keep link text
                const closingBracket = fullMatch.indexOf('](');
                if (closingBracket !== -1) {
                    const textStart = matchStart + 1; // Skip '['
                    const textEnd = matchStart + closingBracket;
                    extractVisibleText(textStart, textEnd);
                }
            } else if (match[7]) {
                // WIKI LINK: [[note]] or [[note|alias]]
                const inner = fullMatch.substring(2, fullMatch.length - 2);
                const pipeIndex = inner.indexOf('|');
                if (pipeIndex !== -1) {
                    const visibleStart = matchStart + 2 + pipeIndex + 1;
                    const visibleEnd = matchStart + fullMatch.length - 2;
                    extractVisibleText(visibleStart, visibleEnd);
                } else {
                    const visibleStart = matchStart + 2;
                    const visibleEnd = matchStart + fullMatch.length - 2;
                    extractVisibleText(visibleStart, visibleEnd);
                }
            } else if (match[8]) {
                // FOOTNOTE REFERENCE or DEFINITION: [^id] or [^id]:
                // We completely skip them (including optional colon) so they don't appear in strippedRaw.
            } else if (match[9]) {
                // BLOCK MATH: $$...$$
                // Keep the math content for matching
                const mathStart = matchStart + 2;
                const mathEnd = matchStart + fullMatch.length - 2;
                addRawText(mathStart, mathEnd);
            } else if (match[10]) {
                // INLINE MATH: $...$
                // Keep the math content for matching
                const mathStart = matchStart + 1;
                const mathEnd = matchStart + fullMatch.length - 1;
                addRawText(mathStart, mathEnd);
            } else if (match[11]) {
                // OBSIDIAN COMMENT: %%...%%
                // Skip entirely - comments are hidden
            } else if (match[12]) {
                // INLINE CODE: `code`
                const codeStart = matchStart + 1;
                const codeEnd = matchStart + fullMatch.length - 1;
                addRawText(codeStart, codeEnd);
            } else if (match[13]) {
                // AUTOLINK: <https://...>
                const urlStart = matchStart + 1;
                const urlEnd = matchStart + fullMatch.length - 1;
                addRawText(urlStart, urlEnd);
            } else if (match[14]) {
                // HTML TAG: <tag> or </tag>
                // Skip entirely
            } else if (match[15]) {
                // ESCAPED CHARACTER: \*
                // Keep the escaped character (without backslash)
                const charPos = matchStart + 1;
                map.push(charPos);
                strippedRaw += text[charPos];
            } else if (match[16] || match[17] || match[18]) {
                // FORMATTING MARKERS: *** ** ~~ == * _
                // Skip entirely
            } else if (match[19]) {
                // CALLOUT HEADER: Skip entirely
            } else if (match[20]) {
                // BLOCK ID: Skip entirely
            } else if (match[21]) {
                // TABLE SEPARATOR: Skip entirely
            } else if (match[22]) {
                // TABLE BAR: Skip entirely
            } else if (match[23]) {
                // SMART PUNCTUATION: Skip entirely
            }

            lastIndex = tokenRegex.lastIndex;
        }

        // Tail - process remaining text after last match
        for (let i = lastIndex; i < text.length; i++) {
            map.push(i);
            strippedRaw += text[i];
        }

        // Now search for snippet in strippedRaw
        const pattern = this.createFlexiblePattern(snippet.trim());
        const regex = new RegExp(pattern, 'g');

        const candidates = [];
        let strippedMatch;

        while ((strippedMatch = regex.exec(strippedRaw)) !== null) {
            const strippedStart = strippedMatch.index;
            const strippedEnd = strippedMatch.index + strippedMatch[0].length;

            const rawStart = map[strippedStart];

            let rawEnd;
            if (strippedEnd < map.length) {
                rawEnd = map[strippedEnd];
            } else {
                rawEnd = map[strippedEnd - 1] + 1;
            }

            candidates.push({
                start: rawStart,
                end: rawEnd,
                text: text.substring(rawStart, rawEnd)
            });
        }

        return candidates;
    }


    findCandidatesAnchored(text, snippet, bodyStart = 0) {
        // Fallback for selections containing rendered math/special chars (e.g. θ
        // rendered from $\theta$) that can't match raw LaTeX source directly.
        // Anchors on the first/last "safe" (non-math) words of the snippet.
        const clean = snippet.trim();
        if (clean.length < 20) return [];

        // "Safe" = ASCII printable or Latin-Extended (covers Spanish/French/etc.)
        const isSafe = (ch) => {
            const cp = ch.codePointAt(0);
            return (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xC0 && cp <= 0x24F) || (cp >= 0x1E00 && cp <= 0x1EFF);
        };

        const safeWords = clean.split(/\s+/).filter(w => w.length > 2 && [...w].every(isSafe));
        if (safeWords.length < 4) return [];

        const half = Math.max(2, Math.min(5, Math.floor(safeWords.length / 3)));
        const startAnchor = safeWords.slice(0, half).join(' ');
        const endAnchor = safeWords.slice(-half).join(' ');
        if (startAnchor === endAnchor) return [];

        try {
            const startRegex = new RegExp(this.createFlexiblePattern(startAnchor), 'g');
            const endRegex = new RegExp(this.createFlexiblePattern(endAnchor), 'g');

            const startMatches = [];
            const endMatches = [];
            let m;

            while ((m = startRegex.exec(text)) !== null) {
                if (m.index >= bodyStart) startMatches.push(m);
            }
            while ((m = endRegex.exec(text)) !== null) {
                if (m.index >= bodyStart) endMatches.push(m);
            }

            for (const startM of startMatches) {
                const bestEnd = endMatches.find(e =>
                    e.index > startM.index &&
                    (e.index - startM.index) < clean.length * 4
                );
                if (bestEnd) {
                    return [{
                        start: startM.index,
                        end: bestEnd.index + bestEnd[0].length,
                        text: text.substring(startM.index, bestEnd.index + bestEnd[0].length)
                    }];
                }
            }
        } catch (e) {
            console.error('Anchor match failed:', e);
        }
        return [];
    }

    calculateSimilarity(source, target) {
        if (source === target) return 1000;

        const sourceTokens = source.split(' ');
        const targetTokens = target.split(' ');

        const sSet = new Set(sourceTokens);
        const tSet = new Set(targetTokens);

        let intersection = 0;
        for (const t of tSet) {
            if (sSet.has(t)) intersection++;
        }

        const union = new Set([...sourceTokens, ...targetTokens]).size;
        const jaccard = union === 0 ? 0 : intersection / union;

        const lenDiff = Math.abs(source.length - target.length);
        const lenMultiplier = 1 / (1 + lenDiff * 0.1);

        return (jaccard * 0.7) + (lenMultiplier * 0.3);
    }
}
