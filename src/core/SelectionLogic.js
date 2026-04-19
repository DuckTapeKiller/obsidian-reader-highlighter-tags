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

const GAP_PATTERN = "[\\s\\u00a0\\u1680\\u2000-\\u200b\\u202f\\u205f\\u3000\\u21a9\\u21b5\\ufe0e\\ufe0f]";
const INLINE_DECORATION_PATTERN = "(?:<mark[^>]*>|<\\/mark>|==|\\*\\*|~~|\\*|_|`)";
const OPTIONAL_MARKDOWN_LINE_PREFIX = "[ \\t]{0,3}(?:(?:>\\s*)*(?:#{1,6}[ \\t]+|-\\s\\[[ xX]\\][ \\t]+|[-*+][ \\t]+|\\d{1,3}[.)][ \\t]+|\\[\\^[^\\]]+\\]:[ \\t]*))?";
const MARKDOWN_PREFIX_ONLY_RE = /^[ \t]*(?:(?:>\s*)+|#{1,6}[ \t]*|-\s\[[ xX]\][ \t]*|[-*+][ \t]*|\d{1,3}[.)][ \t]*|\[\^[^\]]+\]:[ \t]*)+$/;
const INLINE_DECORATION_RE = /<mark[^>]*>|<\/mark>|==|\*\*|~~|\*|_|`/g;

export var SelectionLogic = class {
  constructor(app) {
    this.app = app;
    this.blockLevelTagsForSplit = BLOCK_LEVEL_TAGS_FOR_SPLIT;
  }

  async locateSelection(processedFile, view, selectionSnippet, context = null, occurrenceIndex = 0) {
    const snippet = this.stripBrowserJunk(selectionSnippet);
    if (!snippet) {
      return null;
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
        while (firstSegmentBodyStart < fullRaw.length && (fullRaw[firstSegmentBodyStart] === "\n" || fullRaw[firstSegmentBodyStart] === "\r")) {
          firstSegmentBodyStart++;
        }
      }
    }

    const bodyContent = fullRaw.substring(firstSegmentBodyStart);
    const selectionBlocks = this.splitSelectionBlocks(snippet);

    let candidates = selectionBlocks.length > 1 ? this.findBlockSequenceCandidates(bodyContent, selectionBlocks, 0) : [];

    if (candidates.length === 0) {
      candidates = this.findAllCandidates(bodyContent, snippet, 0);
    }

    if (candidates.length === 0) {
      candidates = this.findCandidatesStripped(bodyContent, snippet, 0);
    }

    if (candidates.length === 0) {
      candidates = this.findFuzzyCandidates(bodyContent, snippet, 0);
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates = this.offsetCandidates(candidates, firstSegmentBodyStart);

    const result = this.resolveCandidates(candidates, fullRaw, context, occurrenceIndex);
    if (!result) {
      return null;
    }

    return this.mapVirtualToPhysical(result.start, result.end, virtual.segments);
  }

  async resolveVirtualContent(file, depth = 0, opContext = { cache: /* @__PURE__ */ new Map(), visited: /* @__PURE__ */ new Set() }) {
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
    let virtualText = "";
    const segments = [];
    let lastOffset = 0;
    for (const embed of sortedEmbeds) {
      const adjustedStart = embed.position.start.offset - fmOffset;
      const adjustedEnd = embed.position.end.offset - fmOffset;
      if (adjustedStart < 0)
        continue;
      const preText = raw.substring(lastOffset, adjustedStart);
      const segStart = virtualText.length;
      virtualText += preText;
      segments.push({
        vStart: segStart,
        vEnd: virtualText.length,
        file,
        pOffset: lastOffset + fmOffset
      });
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(embed.link.split("#")[0], file.path);
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
        const segStart2 = virtualText.length;
        virtualText += embedText;
        segments.push({
          vStart: segStart2,
          vEnd: virtualText.length,
          file,
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
      file,
      pOffset: lastOffset + fmOffset
    });
    const result = { text: virtualText, segments };
    opContext.cache.set(file.path, result);
    return result;
  }

  mapVirtualToPhysical(vStart, vEnd, segments) {
    const startSeg = segments.find((s) => vStart >= s.vStart && vStart < s.vEnd);
    const endSeg = segments.find((s) => vEnd > s.vStart && vEnd <= s.vEnd);
    if (!startSeg || !endSeg)
      return null;
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
    if (candidates.length === 0)
      return null;

    if (context) {
      const cleanContext = context.replace(/\s+/g, " ").trim();
      candidates = candidates.map((cand) => {
        const sourceBlock = (cand.text || raw.substring(cand.start, cand.end)).replace(/\s+/g, " ").trim();
        const score = this.calculateSimilarity(sourceBlock, cleanContext);
        return { ...cand, score };
      });

      const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
      const threshold = bestScore * 0.85;
      const validCandidates = candidates.filter((candidate) => candidate.score >= threshold);

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
    const lines = this.splitSelectionBlocks(this.stripUrlsForPatternMatch(snippet), false);
    if (lines.length === 0) {
      return "";
    }

    const contentPatterns = lines.map((line) => this.createFlexibleLinePattern(line));
    const lineBridge = `(?:[ \\t]*(?:${INLINE_DECORATION_PATTERN}){0,3}[ \\t]*\\r?\\n(?:[ \\t>]*\\r?\\n){0,3})`;
    const joined = contentPatterns.map((pattern, index) => {
      const linePattern = `${OPTIONAL_MARKDOWN_LINE_PREFIX}${pattern}`;
      return index === 0 ? linePattern : `${lineBridge}${linePattern}`;
    }).join("");

    return joined;
  }

  createFlexibleLinePattern(line) {
    const normalizedLine = this.normalizeComparableText(line);
    const parts = [];
    let pendingGap = false;

    const codePoints = [...normalizedLine];
    for (let i = 0; i < codePoints.length; i++) {
      const char = codePoints[i];
      if (/\s/.test(char)) {
        pendingGap = true;
        continue;
      }

      if (pendingGap && parts.length > 0) {
        parts.push(`(?:${GAP_PATTERN}|[-\u2010-\u2015]|"|'|[“”‘’«»]|[\\*_~=]|\\[\\^[^\\]]+\\]){1,5}`);
        pendingGap = false;
      }

      parts.push(this.getFlexibleCharPattern(char));
      if (i < codePoints.length - 1) {
        parts.push(`(?:${GAP_PATTERN}|[-\u2010-\u2015]|"|'|[“”‘’«»]|[\\*_~=]|\\[\\^[^\\]]+\\]){0,3}`);
      }
    }

    if (parts.length === 0) {
      return "";
    }

    return parts.join("");
  }

  getFlexibleCharPattern(char) {
    if (char === "-") {
      return "[-\u2010-\u2015]";
    }
    if (char === "\"") {
      return "[\"“”«»]";
    }
    if (char === "'") {
      return "['‘’`]";
    }
    return this.escapeRegex(char);
  }

  stripBrowserJunk(text) {
    if (!text) {
      return text;
    }

    return text.normalize("NFC")
      .replace(/#:~:text=[^&\s]+(?:&|$)?/g, "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/(?:\u21a9|\u21b5|\ufe0e|\ufe0f)+/g, " ")
      .replace(/[\u00a0\u202f]/g, " ")
      .replace(/[‐‑‒–—―]/g, "-")
      .replace(/[“”«»]/g, "\"")
      .replace(/[‘’]/g, "'")
      .replace(/\[\^?(?:[0-9-]+|[a-zA-Z?]+)\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  stripUrlsForPatternMatch(snippet) {
    return snippet
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<https?:\/\/[^>]+>/g, "");
  }

  findAllCandidates(text, snippet, bodyStart = 0) {
    const cleanSnippet = snippet.trim();
    if (!cleanSnippet) {
      return [];
    }

    const patternSnippet = this.stripUrlsForPatternMatch(cleanSnippet);
    if (!patternSnippet) {
      return [];
    }

    if (patternSnippet.length > 800) {
      const startAnchor = patternSnippet.substring(0, 150);
      const endAnchor = patternSnippet.substring(patternSnippet.length - 150);
      const startP = this.createFlexiblePattern(startAnchor);
      const endP = this.createFlexiblePattern(endAnchor);
      let startRegex;
      let endRegex;
      try {
        startRegex = new RegExp(startP, "gmu");
        endRegex = new RegExp(endP, "gmu");
      } catch (e) {
        console.error("INVALID REGEX PATTERN (anchor):", e);
        return [];
      }
      const startMatches = [];
      const endMatches = [];
      let match;
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
          const bestEnd = endMatches.find((endMatch) => endMatch.index > startMatch.index && endMatch.index - startMatch.index < cleanSnippet.length * 2);
          if (bestEnd) {
            return [{
              start: startMatch.index,
              end: bestEnd.index + bestEnd[0].length,
              text: text.substring(startMatch.index, bestEnd.index + bestEnd[0].length)
            }];
          }
        }
      }
    }

    const pattern = this.createFlexiblePattern(patternSnippet);
    if (!pattern) {
      return [];
    }

    let regex;
    try {
      regex = new RegExp(pattern, "gmu");
    } catch (_error) {
      console.error("INVALID REGEX PATTERN:", pattern);
      return [];
    }

    const candidates = [];
    let match;
    try {
      while ((match = regex.exec(text)) !== null) {
        candidates.push({
          start: match.index,
          end: match.index + match[0].length,
          text: match[0]
        });
      }
    } catch (e) {
      console.warn("Regex execution failed in findAllCandidates (mobile backtracking limit):", e);
      return [];
    }

    return candidates;
  }

  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  findCandidatesStripped(text, snippet, bodyStart = 0) {
    const map = [];
    let strippedRaw = "";
    const isFormattingMarker = (str, pos) => {
      const char = str[pos];
      const next1 = str[pos + 1];
      const next2 = str[pos + 2];
      if (char === "*" && next1 === "*" && next2 === "*") {
        return 3;
      }
      if (char === "*" && next1 === "*" || char === "~" && next1 === "~" || char === "=" && next1 === "=") {
        return 2;
      }
      if (char === "*" || char === "_") {
        return 1;
      }
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
      /([\u2013\u2014\u201c\u201d\u2018\u2019\u00ab\u00bb])/.source
    ].join("|"), "gm");
    let lastIndex = 0;
    let match;
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
    let regex;
    try {
      regex = new RegExp(pattern, "gmu");
    } catch (e) {
      console.error("INVALID REGEX PATTERN in findCandidatesStripped:", e);
      return [];
    }
    const candidates = [];
    let strippedMatch;
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
            text: text.substring(rawStart, rawEnd)
          });
        }
      }
    } catch (e) {
      console.warn("Regex execution failed in findCandidatesStripped (mobile backtracking limit):", e);
      return [];
    }
    return candidates;
  }

  findBlockSequenceCandidates(text, selectionBlocks, bodyStart = 0) {
    if (selectionBlocks.length === 0) {
      return [];
    }

    const documentLines = this.createDocumentLineRecords(text);
    const candidates = [];

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
          text: text.substring(firstLine.start, documentLines[lastMatch].end)
        });
      }
    }

    return this.dedupeCandidates(candidates);
  }

  createDocumentLineRecords(text) {
    const lines = [];
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
        skippable: compare.length === 0 || MARKDOWN_PREFIX_ONLY_RE.test(rawLine.trimEnd())
      });

      if (nextBreak === -1) {
        break;
      }
      offset = nextBreak + 1;
    }

    return lines;
  }

  splitSelectionBlocks(snippet, filterEmpty = true) {
    const normalized = snippet.replace(/\r\n?/g, "\n");
    const blocks = normalized.split("\n").map((line) => this.normalizeComparableText(line));
    return filterEmpty ? blocks.filter((line) => line.length > 0) : blocks;
  }

  normalizeLineForCompare(line) {
    const strippedLine = line.replace(INLINE_DECORATION_RE, "");
    const parts = this.splitMarkdownLine(strippedLine);
    return this.normalizeComparableText(parts.content);
  }

  normalizeComparableText(text) {
    return this.stripBrowserJunk(text)
      .replace(INLINE_DECORATION_RE, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  splitMarkdownLine(line) {
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
      /^\[\^[^\]]+\]:\s*/
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

  lineMatches(source, target) {
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

  findFuzzyCandidates(text, snippet, bodyStart = 0) {
    const needle = this.normalizeForFuzzySearch(snippet);
    if (!needle) {
      return [];
    }

    const { normalized, map } = this.buildFuzzyMap(text);
    if (!normalized) {
      return [];
    }

    const candidates = [];
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
          text: text.substring(rawStart, rawEnd)
        });
      }
      fromIndex = matchIndex + 1;
    }

    return this.dedupeCandidates(candidates);
  }

  buildFuzzyMap(text) {
    let normalized = "";
    const map = [];

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

  normalizeForFuzzySearch(text) {
    return [...this.normalizeComparableText(text)]
      .filter((char) => /[\p{L}\p{N}]/u.test(char))
      .join("")
      .toLocaleLowerCase();
  }

  dedupeCandidates(candidates) {
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

  offsetCandidates(candidates, offset) {
    return candidates.map((candidate) => ({
      ...candidate,
      start: candidate.start + offset,
      end: candidate.end + offset
    }));
  }

  calculateSimilarity(source, target) {
    if (source === target)
      return 1e3;
    const sSet = new Set(source.split(" "));
    const tSet = new Set(target.split(" "));
    let intersection = 0;
    for (const token of tSet) {
      if (sSet.has(token))
        intersection++;
    }
    const union = new Set([...sSet, ...tSet]).size;
    const jaccard = union === 0 ? 0 : intersection / union;
    const lenMultiplier = 1 / (1 + Math.abs(source.length - target.length) * 0.1);
    return jaccard * 0.7 + lenMultiplier * 0.3;
  }
};
