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
        const file = view.file;
        const raw = await this.app.vault.read(file);

        // 1. Try standard exact search first
        let candidates = this.findAllCandidates(raw, selectionSnippet);

        // 2. If no exact matches (likely due to markdown like *bold* that isn't in selection), 
        // try Stripped/Markdown-Agnostic search
        if (candidates.length === 0) {
            candidates = this.findCandidatesStripped(raw, selectionSnippet);
        }

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

    findAllCandidates(text, snippet) {
        const escaped = snippet.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = escaped.replace(/\s+/g, '\\s+');

        const regex = new RegExp(pattern, 'g');
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

    findCandidatesStripped(text, snippet) {
        // Build a stripped version of the text and a map of indices.
        // This allows matching user selections (which see rendered text) to raw markdown positions.
        //
        // Handled constructs:
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
        // Group 1:  Obsidian embeds: ![[note]] or ![[note|alias]]
        // Group 2:  Image with reference: ![alt][ref]
        // Group 3:  Image with URL: ![alt](url) or ![alt](url "title")
        // Group 4:  Reference-style link: [text][ref]
        // Group 5:  Markdown link: [text](url) or [text](url "title")
        // Group 6:  Wiki link: [[note]] or [[note|alias]]
        // Group 7:  Footnote reference: [^id]
        // Group 8:  Block math: $$...$$
        // Group 9:  Inline math: $...$
        // Group 10: Obsidian comment: %%...%%
        // Group 11: Inline code: `code`
        // Group 12: Autolink: <https://...> or <email@...>
        // Group 13: HTML tag: <tag> or </tag>
        // Group 14: Escaped character: \* \_ \[ etc.
        // Group 15: Triple formatting: ***
        // Group 16: Double formatting: ** ~~ ==
        // Group 17: Single formatting: * _

        const tokenRegex = new RegExp([
            // Group 1: Obsidian embed ![[...]]
            /(!\[\[(?:[^\]]+)\]\])/.source,
            // Group 2: Image with reference ![alt][ref]
            /(!\[(?:[^\]]*)\]\[(?:[^\]]*)\])/.source,
            // Group 3: Image with URL ![alt](url) or ![alt](url "title")
            /(!\[(?:[^\]]*)\]\((?:[^()"]*(?:\([^)]*\))?[^()"]*(?:"[^"]*")?)\))/.source,
            // Group 4: Reference-style link [text][ref]
            /(\[(?:[^\]]+)\]\[(?:[^\]]*)\])/.source,
            // Group 5: Markdown link [text](url) or [text](url "title")
            /(\[(?:[^\]]+)\]\((?:[^()"]*(?:\([^)]*\))?[^()"]*(?:"[^"]*")?)\))/.source,
            // Group 6: Wiki link [[...]]
            /(\[\[(?:[^\]]+)\]\])/.source,
            // Group 7: Footnote reference [^id]
            /(\[\^[^\]]+\])/.source,
            // Group 8: Block math $$...$$
            /(\$\$[^$]+\$\$)/.source,
            // Group 9: Inline math $...$  (non-greedy, no spaces around)
            /(\$(?:[^$\s]|[^$\s][^$]*[^$\s])\$)/.source,
            // Group 10: Obsidian comment %%...%%
            /(%%[^%]*%%)/.source,
            // Group 11: Inline code `...`
            /(`[^`]+`)/.source,
            // Group 12: Autolink <https://...> or <email@...>
            /(<(?:https?:\/\/[^>]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>)/.source,
            // Group 13: HTML tag <tag> or </tag>
            /(<\/?[a-zA-Z][^>]*>)/.source,
            // Group 14: Escaped character \X
            /(\\[*_\[\](){}#>+\-.!`~=|\\])/.source,
            // Group 15: Triple formatting ***
            /(\*\*\*)/.source,
            // Group 16: Double formatting ** ~~ ==
            /(\*\*|~~|==)/.source,
            // Group 17: Single formatting * _
            /(\*|_)/.source,
        ].join('|'), 'g');

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
            } else if (match[2]) {
                // IMAGE WITH REFERENCE: ![alt][ref]
                // Keep alt text
                const closingBracket = fullMatch.indexOf('][');
                if (closingBracket !== -1) {
                    const altStart = matchStart + 2; // Skip '!['
                    const altEnd = matchStart + closingBracket;
                    extractVisibleText(altStart, altEnd);
                }
            } else if (match[3]) {
                // IMAGE WITH URL: ![alt](url)
                // Keep alt text
                const closingBracket = fullMatch.indexOf('](');
                if (closingBracket !== -1) {
                    const altStart = matchStart + 2; // Skip '!['
                    const altEnd = matchStart + closingBracket;
                    extractVisibleText(altStart, altEnd);
                }
            } else if (match[4]) {
                // REFERENCE-STYLE LINK: [text][ref]
                // Keep link text
                const closingBracket = fullMatch.indexOf('][');
                if (closingBracket !== -1) {
                    const textStart = matchStart + 1; // Skip '['
                    const textEnd = matchStart + closingBracket;
                    extractVisibleText(textStart, textEnd);
                }
            } else if (match[5]) {
                // MARKDOWN LINK: [text](url)
                // Keep link text
                const closingBracket = fullMatch.indexOf('](');
                if (closingBracket !== -1) {
                    const textStart = matchStart + 1; // Skip '['
                    const textEnd = matchStart + closingBracket;
                    extractVisibleText(textStart, textEnd);
                }
            } else if (match[6]) {
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
            } else if (match[7]) {
                // FOOTNOTE REFERENCE: [^id]
                // In rendered view, this typically shows as a superscript number
                // We'll keep the ID for matching purposes
                const idStart = matchStart + 2; // Skip '[^'
                const idEnd = matchStart + fullMatch.length - 1; // Before ']'
                addRawText(idStart, idEnd);
            } else if (match[8]) {
                // BLOCK MATH: $$...$$
                // Keep the math content for matching
                const mathStart = matchStart + 2;
                const mathEnd = matchStart + fullMatch.length - 2;
                addRawText(mathStart, mathEnd);
            } else if (match[9]) {
                // INLINE MATH: $...$
                // Keep the math content for matching
                const mathStart = matchStart + 1;
                const mathEnd = matchStart + fullMatch.length - 1;
                addRawText(mathStart, mathEnd);
            } else if (match[10]) {
                // OBSIDIAN COMMENT: %%...%%
                // Skip entirely - comments are hidden
            } else if (match[11]) {
                // INLINE CODE: `code`
                const codeStart = matchStart + 1;
                const codeEnd = matchStart + fullMatch.length - 1;
                addRawText(codeStart, codeEnd);
            } else if (match[12]) {
                // AUTOLINK: <https://...>
                const urlStart = matchStart + 1;
                const urlEnd = matchStart + fullMatch.length - 1;
                addRawText(urlStart, urlEnd);
            } else if (match[13]) {
                // HTML TAG: <tag> or </tag>
                // Skip entirely
            } else if (match[14]) {
                // ESCAPED CHARACTER: \*
                // Keep the escaped character (without backslash)
                const charPos = matchStart + 1;
                map.push(charPos);
                strippedRaw += text[charPos];
            } else if (match[15] || match[16] || match[17]) {
                // FORMATTING MARKERS: *** ** ~~ == * _
                // Skip entirely
            }

            lastIndex = tokenRegex.lastIndex;
        }

        // Tail - process remaining text after last match
        for (let i = lastIndex; i < text.length; i++) {
            map.push(i);
            strippedRaw += text[i];
        }

        // Now search for snippet in strippedRaw
        const escaped = snippet.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = escaped.replace(/\s+/g, '\\s+');
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
