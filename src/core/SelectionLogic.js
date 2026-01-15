/**
 * Core Selection Logic
 * "Block Anchoring" Strategy with Ordinal Ranking:
 * 1. Find all occurrences of the snippet in the source.
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

        let candidates = this.findAllCandidates(raw, selectionSnippet);
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
            // We want to keep all candidates that look "correct".
            // If we have 10 lines of "- text", they should all have nearly identical high scores.

            const bestScore = Math.max(...candidates.map(c => c.score));
            // Using a loose threshold to allow for minor variations but exclude different blocks
            const threshold = bestScore * 0.85;

            // Filter
            const validCandidates = candidates.filter(c => c.score >= threshold);

            // Step 3: Use Ordinal Index
            // If the DOM says we clicked the 3rd instance (index 2), pick validCandidates[2].
            if (occurrenceIndex >= 0 && occurrenceIndex < validCandidates.length) {
                const chosen = validCandidates[occurrenceIndex];
                return { raw, start: chosen.start, end: chosen.end };
            }

            // Fallback: if index out of bounds (maybe DOM count mismatch), return first valid or best valid
            if (validCandidates.length > 0) {
                return { raw, start: validCandidates[0].start, end: validCandidates[0].end };
            }
        }

        // No context or fallback for no valid matches found (weird), return simple first
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
