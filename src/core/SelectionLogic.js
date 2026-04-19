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
        
        const opContext = { cache: new Map(), visited: new Set() };
        const virtual = await this.resolveVirtualContent(activeFile, 0, opContext);
        const fullRaw = virtual.text;

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

        const bodyContent = fullRaw.substring(firstSegmentBodyStart);

        let candidates = this.findAllCandidates(bodyContent, snippet, 0);
        candidates = candidates.map(c => ({ ...c, start: c.start + firstSegmentBodyStart, end: c.end + firstSegmentBodyStart }));
        
        if (candidates.length === 0) {
            candidates = this.findCandidatesStripped(bodyContent, snippet, 0);
            candidates = candidates.map(c => ({ ...c, start: c.start + firstSegmentBodyStart, end: c.end + firstSegmentBodyStart }));
        }

        if (candidates.length > 0) {
            const result = this.resolveCandidates(candidates, fullRaw, context, occurrenceIndex);
            if (result) {
                return this.mapVirtualToPhysical(result.start, result.end, virtual.segments);
            }
        }

        return null;
    }

    async resolveVirtualContent(file, depth = 0, opContext = { cache: new Map(), visited: new Set() }) {
        if (depth > 5) {
            return { text: "", segments: [] };
        }

        if (opContext.cache.has(file.path)) {
            return opContext.cache.get(file.path);
        }

        if (opContext.visited.has(file.path)) {
            return { text: "", segments: [] };
        }
        opContext.visited.add(file.path);

        let raw = await this.app.vault.read(file);
        
        let fmOffset = 0;
        if (depth > 0 && raw.startsWith('---')) {
            const originalLength = raw.length;
            const secondDash = raw.indexOf('---', 3);
            if (secondDash !== -1) {
                raw = raw.substring(secondDash + 3);
                while (raw.startsWith('\n') || raw.startsWith('\r')) {
                    raw = raw.substring(1);
                }
                fmOffset = originalLength - raw.length;
            }
        }

        const cache = this.app.metadataCache.getFileCache(file);
        const embeds = cache?.embeds || [];
        
        const sortedEmbeds = [...embeds].sort((a, b) => a.position.start.offset - b.position.start.offset);
        
        let virtualText = "";
        const segments = [];
        let lastOffset = 0;

        for (const embed of sortedEmbeds) {
            const adjustedStart = embed.position.start.offset - fmOffset;
            const adjustedEnd = embed.position.end.offset - fmOffset;

            if (adjustedStart < 0) continue;

            const preText = raw.substring(lastOffset, adjustedStart);
            const segStart = virtualText.length;
            virtualText += preText;
            segments.push({
                vStart: segStart,
                vEnd: virtualText.length,
                file: file,
                pOffset: lastOffset + fmOffset
            });

            const targetFile = this.app.metadataCache.getFirstLinkpathDest(embed.link.split('#')[0], file.path);
            if (targetFile) {
                const subContext = { ...opContext, visited: new Set(opContext.visited) };
                const subVirtual = await this.resolveVirtualContent(targetFile, depth + 1, subContext);
                const embedStart = virtualText.length;
                virtualText += subVirtual.text;
                
                for (const subSeg of subVirtual.segments) {
                    segments.push({
                        vStart: subSeg.vStart + embedStart,
                        vEnd: subSeg.vEnd + embedStart,
                        file: subSeg.file,
                        pOffset: subSeg.pOffset
                    });
                }
            } else {
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
        const startSeg = segments.find(s => vStart >= s.vStart && vStart < s.vEnd);
        const endSeg = segments.find(s => vEnd > s.vStart && vEnd <= s.vEnd);
        
        if (!startSeg || !endSeg) return null;

        const pStart = startSeg.pOffset + (vStart - startSeg.vStart);
        const pEnd = endSeg.pOffset + (vEnd - endSeg.vStart);
        
        return {
            file: startSeg.file,
            start: pStart,
            end: pEnd,
            raw: ""
        };
    }

    resolveCandidates(candidates, raw, context, occurrenceIndex) {
        if (candidates.length === 0) return null;

        if (context) {
            const cleanContext = context.replace(/\s+/g, ' ').trim();

            candidates = candidates.map(cand => {
                let blockStart = raw.lastIndexOf('\n', cand.start);
                if (blockStart === -1) blockStart = 0;
                let blockEnd = raw.indexOf('\n', cand.end);
                if (blockEnd === -1) blockEnd = raw.length;

                const sourceBlock = raw.substring(blockStart, blockEnd).replace(/\s+/g, ' ').trim();
                const score = this.calculateSimilarity(sourceBlock, cleanContext);
                return { ...cand, score };
            });

            const bestScore = Math.max(...candidates.map(c => c.score));
            const threshold = bestScore * 0.85;

            const validCandidates = candidates.filter(c => c.score >= threshold);

            if (occurrenceIndex >= 0 && occurrenceIndex < validCandidates.length) {
                const chosen = validCandidates[occurrenceIndex];
                return { raw, start: chosen.start, end: chosen.end };
            }

            if (validCandidates.length > 0) {
                return { raw, start: validCandidates[0].start, end: validCandidates[0].end };
            }
        }

        return { raw, start: candidates[0].start, end: candidates[0].end };
    }

    createFlexiblePattern(snippet) {
        const gapPattern = '[\\s\\u21a9\\u21b5\\ufe0e\\ufe0f\\ufe0f\\u00a0\\u2013\\u2014\\u201c\\u201d\\u2018\\u2019\\u00ab\\u00bb]';
        
        let parts = [];
        for (let i = 0; i < snippet.length; i++) {
            const char = snippet[i];
            
            if (char.match(/\s/)) {
                if (parts.length > 0 && parts[parts.length-1].includes(gapPattern)) continue;
                parts.push(`(?:${gapPattern})+?`);
            } else {
                parts.push(this.escapeRegex(char));
                if (i < snippet.length - 1) {
                    parts.push(`(?:${gapPattern}|[\\*_~=])*?`);
                }
            }
        }
        
        const pattern = parts.join('');
        const leadingMarkdownOnly = '[\\*_~=#>\\+\\|\\u21a9\\u21b5\\ufe0e\\ufe0f]';
        return `(?:${leadingMarkdownOnly})*?${pattern}`;
    }

    stripBrowserJunk(text) {
        if (!text) return text;
        
        return text.normalize('NFC')
            .replace(/[\u21a9\u21b5\ufe0e\ufe0f]+/g, ' ') 
            .replace(/[\u00a0\s]+/g, ' ')
            .replace(/[\u2013\u2014\u201c\u201d\u2018\u2019\u00ab\u00bb]+/g, ' ')
            .replace(/\[(?:[0-9-]+|[a-zA-Z?]+)\]/g, '') // Footnotes: Remove entirely
            .replace(/\s+/g, ' ')
            .trim();
    }

    findAllCandidates(text, snippet, bodyStart = 0) {
        const cleanSnippet = snippet.trim();
        if (!cleanSnippet) return [];

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
            console.error("INVALID REGEX PATTERN:", pattern);
            throw e;
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
        const map = [];
        let strippedRaw = "";

        const isFormattingMarker = (str, pos) => {
            const char = str[pos];
            const next1 = str[pos + 1];
            const next2 = str[pos + 2];

            if (char === '*' && next1 === '*' && next2 === '*') return 3;
            if ((char === '*' && next1 === '*') || (char === '~' && next1 === '~') || (char === '=' && next1 === '=')) return 2;
            if (char === '*' || char === '_') return 1;
            return 0;
        };

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

        const addRawText = (startPos, endPos) => {
            for (let i = startPos; i < endPos; i++) {
                map.push(i);
                strippedRaw += text[i];
            }
        };

        const tokenRegex = new RegExp([
            /(`{3}[^\n]*\n[\s\S]*?`{3})/.source,
            /(!\[\[(?:[^\]]+)\]\])/.source,
            /(!\[(?:[^\]]*)\]\[(?:[^\]]*)\])/.source,
            /(!\[(?:[^\]]*)\]\((?:[^()"]*(?:\([^)]*\))?[^()"]*(?:"[^"]*")?)\))/.source,
            /(\[(?!\^)(?:[^\]]+)\]\[(?:[^\]]*)\])/.source,
            /(\[(?!\^)(?:[^\]]+)\]\((?:[^()"]*(?:\([^)]*\))?[^()"]*(?:"[^"]*")?)\))/.source,
            /(\[\[(?:[^\]]+)\]\])/.source,
            /(\[\^[^\]]+\]:?\s?)/.source,
            /(\$\$[^$]+\$\$)/.source,
            /(\$(?:[^$\s]|[^$\s][^$]*[^$\s])\$)/.source,
            /(%%[^%]*%%)/.source,
            /(`[^`]+`)/.source,
            /(<(?:https?:\/\/[^>]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>)/.source,
            /(<\/?[a-zA-Z][^>]*>)/.source,
            /(\\[*_\[\](){}#>+\-.!`~=|\\])/.source,
            /(\*\*\*)/.source,
            /(\*\*|~~|==)/.source,
            /(\*|_)/.source,
            /(^[ \t]*>[ \t]?(?:\[![^\]]+\][ \t]?)?)/.source,
            /([ \t]\^[a-zA-Z0-9-]+(?=\s|$))/.source,
            /(\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|)/.source,
            /(\|)/.source,
            /([\u2013\u2014\u201c\u201d\u2018\u2019\u00ab\u00bb])/.source,
        ].join('|'), 'gm');

        let lastIndex = 0;
        let match;

        while ((match = tokenRegex.exec(text)) !== null) {
            for (let i = lastIndex; i < match.index; i++) {
                map.push(i);
                strippedRaw += text[i];
            }

            const fullMatch = match[0];
            const matchStart = match.index;

            if (match[1]) {
                const firstNewline = fullMatch.indexOf('\n');
                if (firstNewline !== -1) {
                    const codeStart = matchStart + firstNewline + 1;
                    const closingFence = fullMatch.lastIndexOf('```');
                    const codeEnd = closingFence !== -1 ? matchStart + closingFence : matchStart + fullMatch.length;
                    addRawText(codeStart, codeEnd);
                }
            } else if (match[2]) {
                const inner = fullMatch.substring(3, fullMatch.length - 2);
                const pipeIndex = inner.indexOf('|');
                const visibleStart = matchStart + 3 + (pipeIndex !== -1 ? pipeIndex + 1 : 0);
                const visibleEnd = matchStart + fullMatch.length - 2;
                extractVisibleText(visibleStart, visibleEnd);
            } else if (match[3] || match[4] || match[5] || match[6]) {
                const closingBracket = fullMatch.indexOf(match[3] || match[5] ? '][' : ']( ');
                const textStart = matchStart + (match[3] || match[4] ? 2 : 1);
                const textEnd = matchStart + (closingBracket !== -1 ? closingBracket : fullMatch.indexOf(']'));
                extractVisibleText(textStart, textEnd);
            } else if (match[7]) {
                const inner = fullMatch.substring(2, fullMatch.length - 2);
                const pipeIndex = inner.indexOf('|');
                const visibleStart = matchStart + 2 + (pipeIndex !== -1 ? pipeIndex + 1 : 0);
                const visibleEnd = matchStart + fullMatch.length - 2;
                extractVisibleText(visibleStart, visibleEnd);
            } else if (match[8]) {
                // Footnotes: Skip
            } else if (match[9] || match[10]) {
                const mStart = matchStart + (match[9] ? 2 : 1);
                const mEnd = matchStart + fullMatch.length - (match[9] ? 2 : 1);
                addRawText(mStart, mEnd);
            } else if (match[12] || match[13]) {
                const cStart = matchStart + 1;
                const cEnd = matchStart + fullMatch.length - 1;
                addRawText(cStart, cEnd);
            } else if (match[15]) {
                const charPos = matchStart + 1;
                map.push(charPos);
                strippedRaw += text[charPos];
            }

            lastIndex = tokenRegex.lastIndex;
        }

        for (let i = lastIndex; i < text.length; i++) {
            map.push(i);
            strippedRaw += text[i];
        }

        const pattern = this.createFlexiblePattern(snippet.trim());
        const regex = new RegExp(pattern, 'g');
        const candidates = [];
        let strippedMatch;

        while ((strippedMatch = regex.exec(strippedRaw)) !== null) {
            const strippedStart = strippedMatch.index;
            const strippedEnd = strippedMatch.index + strippedMatch[0].length;
            const rawStart = map[strippedStart];
            const rawEnd = strippedEnd < map.length ? map[strippedEnd] : map[strippedEnd - 1] + 1;

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
        const sSet = new Set(source.split(' '));
        const tSet = new Set(target.split(' '));
        let intersection = 0;
        for (const t of tSet) if (sSet.has(t)) intersection++;
        const union = new Set([...sSet, ...tSet]).size;
        const jaccard = union === 0 ? 0 : intersection / union;
        const lenMultiplier = 1 / (1 + Math.abs(source.length - target.length) * 0.1);
        return (jaccard * 0.7) + (lenMultiplier * 0.3);
    }
}
