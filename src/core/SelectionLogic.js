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
        // Build a stripped version of the text and a map of indices
        // We strip common formatting chars: * _ = <tags> AND [links](urls) AND [[wikilinks]]
        const map = []; // strippedIndex -> rawIndex
        let strippedRaw = "";

        // Enhanced Regex:
        // Group 1: Markdown Links [text](url)
        // Group 2: Wiki Links [[text]] or [[text|alias]]
        // Group 3: Markers to fully skip (*, _, ==, <tag>)
        const tokenRegex = /(\[(?:[^\]]+)\]\([^)]+\))|(\[\[(?:[^\]]+)\]\])|(\*|_|==|~~|<[^>]+>)/g;

        let lastIndex = 0;
        let match;

        while ((match = tokenRegex.exec(text)) !== null) {
            // 1. Process text BEFORE the match (keep it all)
            for (let i = lastIndex; i < match.index; i++) {
                map.push(i);
                strippedRaw += text[i];
            }

            const fullMatch = match[0];

            if (match[1]) {
                // It's a MARKDOWN LINK: [book](url)
                // We want to keep "book".
                const closingBracket = fullMatch.indexOf('](');
                if (closingBracket !== -1) {
                    const linkTextStart = match.index + 1; // Skip '['
                    const linkTextEnd = match.index + closingBracket; // End of text

                    for (let i = linkTextStart; i < linkTextEnd; i++) {
                        map.push(i);
                        strippedRaw += text[i];
                    }
                }
            } else if (match[2]) {
                // It's a WIKI LINK: [[Note]] or [[Note|Alias]]
                // Remove [[ and ]]
                const inner = fullMatch.substring(2, fullMatch.length - 2);
                const pipeIndex = inner.indexOf('|');

                let visibleStart, visibleEnd;

                if (pipeIndex !== -1) {
                    // Has Alias: [[Note|Alias]] -> Keep Alias
                    // Visible text starts after pipe.
                    // match.index + 2 (for [[) + pipeIndex + 1
                    visibleStart = match.index + 2 + pipeIndex + 1;
                    visibleEnd = match.index + fullMatch.length - 2;
                } else {
                    // No Alias: [[Note]] -> Keep Note
                    visibleStart = match.index + 2;
                    visibleEnd = match.index + fullMatch.length - 2;
                }

                for (let i = visibleStart; i < visibleEnd; i++) {
                    map.push(i);
                    strippedRaw += text[i];
                }
            } else {
                // It's a MARKER: * _ ==
                // Skip entirely.
            }

            lastIndex = tokenRegex.lastIndex;
        }

        // Tail
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

            // Calculate rawEnd
            let rawEnd;
            if (strippedEnd < map.length) {
                rawEnd = map[strippedEnd]; // matches correctly to valid char in raw
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
