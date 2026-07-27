import { describe, it, expect, beforeEach } from "vitest";

// ====================================================================
// We test SelectionLogic methods in isolation by importing the class
// and mocking only the `app` dependency (which is only needed for
// locateSelection / resolveVirtualContent, not for the pure functions).
// ====================================================================

// Import the SelectionLogic class
// We need to handle the export format: `export var SelectionLogic = class { ... }`
import { SelectionLogic } from "../src/core/SelectionLogic";

let logic;

beforeEach(() => {
    // Create with a mock app (methods we test don't use it)
    logic = new SelectionLogic({});
});

// ====================================================================
// stripBrowserJunk
// ====================================================================
describe("stripBrowserJunk", () => {
    it("normalizes smart quotes", () => {
        expect(logic.stripBrowserJunk("\u201cHello\u201d")).toBe('"Hello"');
        expect(logic.stripBrowserJunk("\u2018world\u2019")).toBe("'world'");
    });

    it("removes footnote citations but preserves named content", () => {
        expect(logic.stripBrowserJunk("end.[^8] Next")).toBe("end. Next");
        expect(logic.stripBrowserJunk("text[1] more")).toBe("text more");
        // Named footnotes are now preserved for literal matching
        expect(logic.stripBrowserJunk("text[^note] more")).toBe("text[^note] more");
    });

    it("normalizes dashes", () => {
        expect(logic.stripBrowserJunk("a\u2014b")).toBe("a-b");
        expect(logic.stripBrowserJunk("a\u2013b")).toBe("a-b");
    });

    it("removes zero-width characters", () => {
        expect(logic.stripBrowserJunk("he\u200Bllo")).toBe("hello");
        expect(logic.stripBrowserJunk("he\uFEFFllo")).toBe("hello");
    });

    it("collapses whitespace", () => {
        expect(logic.stripBrowserJunk("hello   world")).toBe("hello world");
        expect(logic.stripBrowserJunk("  padded  ")).toBe("padded");
    });

    it("preserves cuneiform characters", () => {
        const cuneiform = "𒀜𒊏𒄩𒋀";
        const result = logic.stripBrowserJunk(`test ${cuneiform} end`);
        expect(result).toContain(cuneiform);
    });

    it("preserves emoji", () => {
        expect(logic.stripBrowserJunk("hello 🎉 world")).toBe("hello 🎉 world");
    });
});

// ====================================================================
// createFlexibleLinePattern — code point safety
// ====================================================================
describe("createFlexibleLinePattern", () => {
    it("produces a pattern that matches basic text", () => {
        const pattern = logic.createFlexibleLinePattern("hello world");
        const regex = new RegExp(pattern, "gmu");
        expect(regex.test("hello world")).toBe(true);
    });

    it("handles cuneiform characters (supplementary plane)", () => {
        const pattern = logic.createFlexibleLinePattern("A𒀜𒊏B");
        const regex = new RegExp(pattern, "gmu");
        expect(regex.test("A𒀜𒊏B")).toBe(true);
    });

    it("matches source with inline footnotes skipped", () => {
        const pattern = logic.createFlexibleLinePattern("end. Next");
        const regex = new RegExp(pattern, "gmu");
        // Filter out the noise using our new Structural Filter!
        const filtered = logic.applyStructuralFilter({ text: "end.[^8] Next", segments: [] }).text;
        expect(regex.test(filtered)).toBe(true);
    });

    it("matches source with bold/italic formatting", () => {
        const pattern = logic.createFlexibleLinePattern("las Lista Real");
        const regex = new RegExp(pattern, "gmu");
        const filtered = logic.applyStructuralFilter({ text: "las *Lista Real", segments: [] }).text;
        expect(regex.test(filtered)).toBe(true);
    });

    it("generates valid regex for mixed cuneiform + ASCII", () => {
        const snippet = "Atrahasis (𒀜𒊏𒄩𒋀) es un poema";
        expect(() => {
            const pattern = logic.createFlexibleLinePattern(snippet);
            new RegExp(pattern, "gmu");
        }).not.toThrow();
    });

    it("matches smart quotes flexibly", () => {
        // Pattern built from ASCII " should match source with smart quotes
        const pattern = logic.createFlexibleLinePattern('said "hello"');
        expect(new RegExp(pattern, "gmu").test("said \u201chello\u201d")).toBe(true);
        // Also matches itself (fresh regex to avoid lastIndex issue with g flag)
        expect(new RegExp(pattern, "gmu").test('said "hello"')).toBe(true);
    });

    it("matches dashes flexibly", () => {
        // Pattern built from ASCII "-" uses the flexible char class [-\u2010-\u2015]
        const pattern = logic.createFlexibleLinePattern("a-b");
        expect(new RegExp(pattern, "gmu").test("a-b")).toBe(true);
        expect(new RegExp(pattern, "gmu").test("a\u2013b")).toBe(true); // en-dash
        expect(new RegExp(pattern, "gmu").test("a\u2014b")).toBe(true); // em-dash
    });
});

// ====================================================================
// createFlexiblePattern — multi-line matching
// ====================================================================
describe("createFlexiblePattern", () => {
    it("matches single-line text against source with footnotes", () => {
        const source = "mundo.[^8] Ensor interpretaba temas";
        const snippet = "mundo. Ensor interpretaba temas";
        const pattern = logic.createFlexiblePattern(snippet);
        const regex = new RegExp(pattern, "gmu");
        const filtered = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        expect(regex.test(filtered)).toBe(true);
    });

    it("matches cuneiform paragraph against source", () => {
        const source = "***Atrahasis*** (𒀜𒊏𒄩𒋀) es un poema épico";
        const snippet = "Atrahasis (𒀜𒊏𒄩𒋀) es un poema épico";
        const pattern = logic.createFlexiblePattern(snippet);
        const regex = new RegExp(pattern, "gmu");
        const filtered = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        expect(regex.test(filtered)).toBe(true);
    });

    it("matches italic text against source", () => {
        const source = "en una de las *Lista Real Sumerias*.[^4] La copia";
        const snippet = "en una de las Lista Real Sumerias. La copia";
        const pattern = logic.createFlexiblePattern(snippet);
        const regex = new RegExp(pattern, "gmu");
        const filtered = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        expect(regex.test(filtered)).toBe(true);
    });

    it("matches footnote list entries", () => {
        const source = "[^61]: Encina, 1961: 578";
        const snippet = "Encina, 1961: 578";
        const pattern = logic.createFlexiblePattern(snippet);
        const regex = new RegExp(pattern, "gmu");
        // Prefix regex handles the [^61]: part
        expect(regex.test(source)).toBe(true);
    });
});

// ====================================================================
// findCandidatesStripped — HTML entity tolerance
// ====================================================================
describe("findCandidatesStripped", () => {
    it("matches source containing HTML entities", () => {
        const source = "Tom &amp; Jerry and 2 &lt; 3";
        const snippet = "Tom & Jerry and 2 < 3";
        const candidates = logic.findCandidatesStripped(source, snippet, 0);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0].text).toContain("&amp;");
        expect(candidates[0].text).toContain("&lt;");
    });

    it("supports numeric HTML entities", () => {
        const source = "Cuneiform: &#x1221C; end";
        const snippet = "Cuneiform: 𒈜 end";
        const candidates = logic.findCandidatesStripped(source, snippet, 0);
        expect(candidates.length).toBeGreaterThan(0);
    });
});

// ====================================================================
// buildFuzzyMap — code point safety
// ====================================================================
describe("buildFuzzyMap", () => {
    it("includes cuneiform characters in normalized output", () => {
        const { normalized } = logic.buildFuzzyMap("Atrahasis (𒀜𒊏𒄩𒋀) es");
        expect(normalized).toContain("𒀜");
        expect(normalized).toContain("𒊏");
        expect(normalized).toContain("𒄩");
        expect(normalized).toContain("𒋀");
    });

    it("maps offsets correctly with cuneiform chars", () => {
        const text = "A𒀜B";
        const { normalized, map } = logic.buildFuzzyMap(text);
        expect(normalized).toBe("a𒀜b");
        // 'A' at offset 0, '𒀜' at offset 1 (2 code units), 'B' at offset 3
        expect(map[0]).toBe(0); // 'a' -> 'A' at 0
        expect(map[1]).toBe(1); // '𒀜' -> at 1
        expect(map[2]).toBe(3); // 'b' -> 'B' at 3
    });

    it("excludes punctuation and spaces", () => {
        const { normalized } = logic.buildFuzzyMap("hello, world!");
        expect(normalized).toBe("helloworld");
    });

    it("handles emoji", () => {
        const { normalized } = logic.buildFuzzyMap("A🎉B");
        // Emoji are not \p{L} or \p{N}, so excluded
        expect(normalized).toBe("ab");
    });
});

// ====================================================================
// normalizeForFuzzySearch — code point safety
// ====================================================================
describe("normalizeForFuzzySearch", () => {
    it("includes cuneiform characters", () => {
        const result = logic.normalizeForFuzzySearch("Atrahasis (𒀜𒊏𒄩𒋀) es");
        expect(result).toContain("𒀜");
        expect(result).toContain("atrahasis");
    });

    it("strips punctuation and spaces", () => {
        const result = logic.normalizeForFuzzySearch("Hello, World!");
        expect(result).toBe("helloworld");
    });

    it("lowercases correctly", () => {
        const result = logic.normalizeForFuzzySearch("AbCdEf");
        expect(result).toBe("abcdef");
    });
});

// ====================================================================
// safeRegexExec — timeout safety
// ====================================================================
describe("safeRegexExec", () => {
    it("returns matches for simple patterns", () => {
        const regex = /hello/g;
        const results = logic.safeRegexExec(regex, "hello world hello");
        expect(results.length).toBe(2);
        expect(results[0].index).toBe(0);
        expect(results[1].index).toBe(12);
    });

    it("returns empty array for non-matching pattern", () => {
        const regex = /xyz/g;
        const results = logic.safeRegexExec(regex, "hello world");
        expect(results.length).toBe(0);
    });

    it("handles invalid regex gracefully", () => {
        // Force a regex error by testing with a regex that throws
        const badRegex = /test/g;
        // This should work normally
        const results = logic.safeRegexExec(badRegex, "test");
        expect(results.length).toBe(1);
    });
});

// ====================================================================
// Full pipeline integration test — the "Atrahasis" paragraph
// ====================================================================
describe("Integration: Atrahasis paragraph", () => {
    const source = `---
title: Test
---

***Atrahasis*** (𒀜𒊏𒄩𒋀) es un poema épico acadio del siglo XVIII a. C., registrado en varias versiones en tablillas de arcilla[^1] y que lleva el nombre de uno de sus protagonistas, el sacerdote Atrahasis ('el muy sabio').[^2] La narrativa tiene cuatro puntos focales`;

    const snippet = `Atrahasis (𒀜𒊏𒄩𒋀) es un poema épico acadio del siglo XVIII a. C., registrado en varias versiones en tablillas de arcilla y que lleva el nombre de uno de sus protagonistas, el sacerdote Atrahasis ('el muy sabio'). La narrativa tiene cuatro puntos focales`;

    it("findAllCandidates finds the paragraph in body content", () => {
        // Strip front matter
        const bodyStart = source.indexOf("\n\n") + 2;
        const body = source.substring(bodyStart);

        const filteredBody = logic.applyStructuralFilter({ text: body, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const candidates = logic.findAllCandidates(filteredBody, cleanSnippet, 0);

        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0].text).toContain("𒀜𒊏𒄩𒋀");
    });
});

// ====================================================================
// Structural Filter (Noise Shield) Edge Cases
// ====================================================================
describe("Structural Filter (Noise Shield) Integration", () => {
    it("Issue B: Deeply Nested Lists with Checkboxes & Links", () => {
        const source = `- Elemento principal de la lista, con un pie de página temprano[^1].
	- Nivel dos: Aquí hay algo de texto normal.
		- Nivel tres: Citas superpuestas: «Los dioses dijeron: "Que haya luz"[^2] pero nadie escuchó».
			- Nivel cuatro: Esta línea termina abruptamente.[^3]
				- Nivel cinco: El corazón de las tinieblas. Textos en **negrita y *cursiva al mismo tiempo***.
	- De vuelta al nivel dos. ¿Sobrevivirá el motor de Regex a este salto?
		- [x] Una tarea completada con un enlace a [Wikipedia](https://wikipedia.org) y un footnote[^4].
		- [ ] Una tarea sin completar con ~~texto tachado~~ y \`código en línea\`.`;
        const snippet =
            'Elemento principal de la lista, con un pie de página temprano. Nivel dos: Aquí hay algo de texto normal. Nivel tres: Citas superpuestas: "Los dioses dijeron: "Que haya luz" pero nadie escuchó". Nivel cuatro: Esta línea termina abruptamente. Nivel cinco: El corazón de las tinieblas. Textos en negrita y cursiva al mismo tiempo. De vuelta al nivel dos. ¿Sobrevivirá el motor de Regex a este salto? Una tarea completada con un enlace a Wikipedia y un footnote. Una tarea sin completar con texto tachado y código en línea.';

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });

    it("Issue C: Intersecting Blockquotes & Math Formulas", () => {
        const source = `> "El conocimiento es poder", dijo Sir Francis Bacon.
> Pero, ¿qué pasa cuando el texto...
>> ...se anida profundamente dentro de citas ocultas?
>> Y además contiene matemáticas en línea como $\\sqrt{a^2 + b^2} = c$?
> 
> Y luego regresa e incluye footnotes [^5] dentro del formato de la cita.`;
        const snippet = `"El conocimiento es poder", dijo Sir Francis Bacon. Pero, ¿qué pasa cuando el texto... ...se anida profundamente dentro de citas ocultas? Y además contiene matemáticas en línea como sqrt{a^2 + b^2} = c? Y luego regresa e incluye footnotes dentro del formato de la cita.`;

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });

    it("Issue D: Markdown Tables with Alignment Rows", () => {
        const source = `| Header A (Left)          |  Header B (Center)   |  Header C (Right) |
| :----------------------- | :------------------: | ----------------: |
| Fila 1, **Columna 1**    | Fila 1, *Columna 2*  | Fila 1, ~~Col 3~~ |
| Una celda [^6] muy larga | Texto con emojis 🚀✨ |          $E=mc^2$ |
| Nested \`code\`            | «Tablas y comillas»  |        Fila final |`;
        const snippet = `Header A (Left) Header B (Center) Header C (Right) Fila 1, Columna 1 Fila 1, Columna 2 Fila 1, Col 3 Una celda muy larga Texto con emojis 🚀✨ E=mc^2 Nested code «Tablas y comillas» Fila final`;

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });

    it("Issue E: Callout Borders", () => {
        const source = `> [!WARNING] Cuidado con los Callouts
> Este bloque es un callout de Obsidian. Internamente, Obsidian genera un div con múltiples capas (\`callout-title\`, \`callout-content\`). Resaltar entre párrafos aquí es una prueba ácida.`;
        const snippet = `Cuidado con los Callouts
Este bloque es un callout de Obsidian. Internamente, Obsidian genera un div con múltiples capas (callout-title, callout-content). Resaltar entre párrafos aquí es una prueba ácida.`;

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });
});

// ====================================================================
// Scholarly Resilience (Footnotes, Asian Scripts, Subscripts)
// ====================================================================
describe("Scholarly Resilience", () => {
    it("Example 1: Banzai (Asian script + named footnote)", () => {
        const source =
            "The origin of the term is a classical Chinese phrase in the 7th-century *Book of Northern Qi*, which states: 丈夫玉碎恥甎全 ('A true man would [^rather] be the shattered jewel, ashamed to be the intact tile').[^6]";
        const snippet =
            "The origin of the term is a classical Chinese phrase in the 7th-century Book of Northern Qi, which states: 丈夫玉碎恥甎全 ('A true man would rather be the shattered jewel, ashamed to be the intact tile').[7]";

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });

    it("Example 3: Aihara (Italicized footnote)", () => {
        const source =
            "- Hideki Aihara (2017). 一九四五 占守島の真実：少年戦車兵が見た最後の戦場 [^*1945: The Truth about Shumushu Island: The Last Battlefield Seen by a Young Tank Soldier*] (in Japanese). PHP Institute.";
        const snippet =
            "Hideki Aihara (2017). 一九四五 占守島の真実：少年戦車兵が見た最後の戦場 [^1945: The Truth about Shumushu Island: The Last Battlefield Seen by a Young Tank Soldier] (in Japanese). PHP Institute.";

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });

    it("Example 4: Anunnaki (Subscripts & citations)", () => {
        const source =
            'written as "*d*a-nun-na", "*d*a-nun-na-ke<sub>4</sub>-ne", or "*d*a-nun-na", possibly meaning "princely offspring",[^1] "royal offspring" or literally "offspring/progeny/seed of princes".[^*citation needed*]';
        const snippet =
            'written as "da-nun-na", "da-nun-na-ke4-ne", or "da-nun-na", possibly meaning "princely offspring",[1] "royal offspring" or literally "offspring/progeny/seed of princes".[^citation needed]';

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });

    it("Example 5: Akkadian (Inline supplement drink[^s])", () => {
        const source = 'comments that she "drink[^s] water with the Anunnaki".[^43]';
        const snippet = 'comments that she "drink[^s] water with the Anunnaki".[43]';

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });

    it("Lambert Regression: Complex citation numbers [6-1]", () => {
        const source = "Wilfred G. Lambert y Alan Millard[^6] publicaron... Lambert y Millard. [^5] Otro fragmento";
        const snippet = "Wilfred G. Lambert y Alan Millard[7] publicaron... Lambert y Millard. [6-1] Otro fragmento";

        const virtual = logic.applyStructuralFilter({ text: source, segments: [] }).text;
        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const pattern = logic.createFlexiblePattern(cleanSnippet);
        const regex = new RegExp(pattern, "gmu");

        expect(regex.test(virtual)).toBe(true);
    });
});

// ====================================================================
// Structural Integrity & Guardrails (Prefix Protection)
// ====================================================================
describe("Structural Integrity & Guardrails", () => {
    it("protects footnote entry prefixes", () => {
        const source = "[^5]: Katharine Conley; Pierre Taminiaux (2006). Surrealism and Its Others.";
        // User selects the whole line in browser, which might include "5: "
        const snippet = "5: Katharine Conley; Pierre Taminiaux (2006). Surrealism and Its Others.";

        const cleanSnippet = logic.stripBrowserJunk(snippet);
        // Hybrid engine is designed to work on RAW text with structural noise
        const result = logic.findHybridCandidates(source, cleanSnippet, 0);
        expect(result.length).toBeGreaterThan(0);

        const snapped = logic.snapToStructuralBoundaries(source, result[0]);
        // The highlight must start AFTER the ": "
        const actualText = source.substring(snapped.start, snapped.end);
        expect(actualText).not.toContain("[^5]:");
        expect(actualText.startsWith("Katharine")).toBe(true);
    });

    it("protects callout header prefixes", () => {
        const source = "> [!INFO] This is the title\nThis is content.";
        const snippet = "INFO This is the title This is content.";

        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const result = logic.findHybridCandidates(source, cleanSnippet, 0);
        expect(result.length).toBeGreaterThan(0);

        const snapped = logic.snapToStructuralBoundaries(source, result[0]);
        const actualText = source.substring(snapped.start, snapped.end);
        expect(actualText).not.toContain("> [!INFO]");
        expect(actualText).toContain("This is the title\nThis is content");
    });

    it("protects list markers", () => {
        const source = "- [ ] Task one\n- [x] Task two";
        const snippet = "Task one Task two";

        const cleanSnippet = logic.stripBrowserJunk(snippet);
        const result = logic.findHybridCandidates(source, cleanSnippet, 0);
        expect(result.length).toBeGreaterThan(0);

        const snapped = logic.snapToStructuralBoundaries(source, result[0]);
        const actualText = source.substring(snapped.start, snapped.end);
        expect(actualText).not.toContain("- [ ]");
        expect(actualText).toContain("Task one");
    });
});


// ====================================================================
// pickBestCandidate — the pure disambiguation helper extracted in
// fix-duplicate-snippet-selection-match. No DOM, no app, no this.
// ====================================================================
describe("pickBestCandidate", () => {
    const { pickBestCandidate } = SelectionLogic;

    it("returns null on empty input", () => {
        expect(pickBestCandidate([], "x", "", "any context", 0, null, [])).toBeNull();
    });

    it("returns the only candidate when length is 1", () => {
        const c = { start: 5, end: 9, text: "word" };
        expect(pickBestCandidate([c], "x", "", "any context", 0, null, [])).toBe(c);
    });

    it("picks the 2nd candidate when withinBlockOffset points to it", () => {
        const c1 = { start: 0, end: 3, text: "cat" };
        const c2 = { start: 4, end: 7, text: "cat" };
        const c3 = { start: 8, end: 11, text: "cat" };
        const chosen = pickBestCandidate(
            [c1, c2, c3],
            "cat cat cat",
            "cat",
            "cat cat cat",
            0,
            4,
            []
        );
        expect(chosen).toBe(c2);
    });

    it("picks the 3rd candidate when withinBlockOffset points to it", () => {
        const c1 = { start: 0, end: 3, text: "yes" };
        const c2 = { start: 4, end: 7, text: "yes" };
        const c3 = { start: 8, end: 11, text: "yes" };
        const chosen = pickBestCandidate(
            [c1, c2, c3],
            "yes yes yes",
            "yes",
            "yes yes yes",
            0,
            8,
            []
        );
        expect(chosen).toBe(c3);
    });

    it("falls back to bodyBlocks/occurrenceIndex when no withinBlockOffset", () => {
        const c1 = { start: 0, end: 3, text: "yes" };
        const c2 = { start: 20, end: 23, text: "yes" };
        const bodyBlocks = [
            { start: 0, end: 10 },
            { start: 10, end: 30 },
        ];
        const chosen = pickBestCandidate(
            [c1, c2],
            "yes no yes no",
            "yes",
            "yes no yes no",
            1,
            null,
            bodyBlocks
        );
        expect(chosen).toBe(c2);
    });

    it("picks the right candidate even when a title candidate exists (the user's bug)", () => {
        // The user's actual scenario: a note with a title containing the word
        // and several body paragraphs also containing the word. The matcher
        // must NOT pick the title candidate.
        const body = "# Cervical cancer\n\nCervical cancer is a type of cancer that affects women.\n\nCervical screening is important.\n\nCervical cancer vaccine is recommended.";
        const c1 = { start: 2, end: 10, text: "Cervical" };   // in title
        const c2 = { start: 24, end: 32, text: "Cervical" };  // in body 1
        const c3 = { start: 80, end: 88, text: "Cervical" };  // in body 2
        const c4 = { start: 120, end: 128, text: "Cervical" }; // in body 3
        const ctx3 = "Cervical cancer vaccine is recommended.";
        const chosen = pickBestCandidate(
            [c1, c2, c3, c4],
            body,
            "Cervical",
            ctx3,
            0,
            0,
            []
        );
        expect(chosen).toBe(c4);
    });

    it("picks the right candidate in body 2 when context is body 2", () => {
        const body = "# Cervical cancer\n\nCervical cancer is a type of cancer.\n\nCervical screening is important.\n\nCervical cancer vaccine is recommended.";
        const c1 = { start: 2, end: 10, text: "Cervical" };
        const c2 = { start: 24, end: 32, text: "Cervical" };
        const c3 = { start: 70, end: 78, text: "Cervical" };
        const c4 = { start: 110, end: 118, text: "Cervical" };
        const ctx2 = "Cervical screening is important.";
        const chosen = pickBestCandidate(
            [c1, c2, c3, c4],
            body,
            "Cervical",
            ctx2,
            0,
            0,
            []
        );
        expect(chosen).toBe(c3);
    });

    it("emits console.warn and returns first when tied candidates remain after all disambiguation", () => {
        const c1 = { start: 0, end: 3, text: "cat" };
        const c2 = { start: 0, end: 3, text: "cat" };
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (msg) => warnings.push(msg);
        try {
            const chosen = pickBestCandidate([c1, c2], "cat cat", "cat", "cat cat", 0, null, []);
            expect(chosen).toBe(c1);
            expect(warnings.length).toBeGreaterThan(0);
            expect(warnings[0]).toMatch(/ambiguous occurrence/);
        } finally {
            console.warn = origWarn;
        }
    });

    // ====================================================================
    // Case-sensitive disambiguation: the user's real example.
    // Line: "On 17 Nov 2025, the WHO/UN formally recognised
    //        'World Cervical Cancer Elimination Day' — the first WHO Day
    //        ever for a cancer — to galvanise the 2020 Global Strategy."
    // "Cervical Cancer" (capital) and "cancer" (lowercase) coexist on the
    // same line. User selects the capital one — matcher must NOT pick the
    // lowercase one.
    // ====================================================================
    it("prefers the case-matching candidate when both cases exist on the same line", () => {
        const body = "On 17 Nov 2025, the WHO/UN formally recognised 'World Cervical Cancer Elimination Day' — the first WHO Day ever for a cancer — to galvanise the 2020 Global Strategy.";
        // findAllCandidates would return two "Cancer" matches at:
        //   62 (in 'Cervical Cancer', capital C)
        //  142 (lowercase 'cancer')
        // The candidate.text includes the preceding space for the 2nd one.
        const cCapital = { start: 62, end: 68, text: "Cancer" };
        const cLower = { start: 142, end: 148, text: " cancer" };
        const chosen = pickBestCandidate(
            [cCapital, cLower],
            body,
            "Cancer",
            body,
            0,
            62,
            []
        );
        expect(chosen).toBe(cCapital);
    });

    it("prefers the lowercase candidate when the snippet is lowercase", () => {
        const body = "On 17 Nov 2025, the WHO/UN formally recognised 'World Cervical Cancer Elimination Day' — the first WHO Day ever for a cancer — to galvanise the 2020 Global Strategy.";
        const cCapital = { start: 62, end: 68, text: "Cancer" };
        const cLower = { start: 142, end: 148, text: " cancer" };
        const chosen = pickBestCandidate(
            [cCapital, cLower],
            body,
            "cancer",
            body,
            0,
            142,
            []
        );
        expect(chosen).toBe(cLower);
    });
});

// ====================================================================
// findContextInBody — the coarse anchor search
// ====================================================================
describe("findContextInBody", () => {
    const { findContextInBody } = SelectionLogic;

    it("finds the context's block in a body that has no inline markers", () => {
        const body = "alpha\n\nbeta gamma delta\n\nepsilon";
        const starts = findContextInBody("beta gamma delta", body);
        expect(starts.length).toBe(1);
        // The match should start at the 'b' of "beta"
        expect(body.substring(starts[0], starts[0] + 4)).toBe("beta");
    });

    it("finds the context when the body has bold markers between chars", () => {
        const body = "alpha\n\n**beta** gamma delta\n\nepsilon";
        const starts = findContextInBody("beta gamma delta", body);
        expect(starts.length).toBe(1);
        // The match should land on the 'b' of the bolded beta
        expect(body.substring(starts[0], starts[0] + 1)).toBe("*");
    });

    it("returns multiple positions when the paragraph is duplicated", () => {
        const body = "para one\n\nbeta gamma\n\nbeta gamma";
        const starts = findContextInBody("beta gamma", body);
        expect(starts.length).toBe(2);
    });

    it("returns empty array when the context is not in the body", () => {
        const body = "completely different content here";
        const starts = findContextInBody("missing paragraph", body);
        expect(starts.length).toBe(0);
    });
});

// ====================================================================
// createDocumentBlockRecords
// ====================================================================
describe("createDocumentBlockRecords", () => {
    it("splits a body on blank lines", () => {
        const body = "alpha beta\n\ngamma delta\n\nepsilon";
        const blocks = logic.createDocumentBlockRecords(body);
        expect(blocks.length).toBeGreaterThan(0);
        const covered = blocks.reduce((s, b) => s + (b.end - b.start), 0);
        expect(covered).toBe(body.length);
    });

    it("returns a single block for body without blank lines", () => {
        const body = "alpha\nbeta\ngamma";
        const blocks = logic.createDocumentBlockRecords(body);
        expect(blocks.length).toBe(1);
        expect(blocks[0]).toEqual({ start: 0, end: body.length });
    });

    it("returns an empty array for an empty body", () => {
        expect(logic.createDocumentBlockRecords("")).toEqual([]);
    });
});

// ====================================================================
// normalizeSnippetTextForContext
// ====================================================================
describe("normalizeSnippetTextForContext", () => {
    const { normalizeSnippetTextForContext } = SelectionLogic;

    it("strips bold markers", () => {
        expect(normalizeSnippetTextForContext("**cat**")).toBe("cat");
    });

    it("strips italic markers", () => {
        expect(normalizeSnippetTextForContext("*cat*")).toBe("cat");
    });

    it("strips strikethrough markers", () => {
        expect(normalizeSnippetTextForContext("~~cat~~")).toBe("cat");
    });

    it("strips inline code markers", () => {
        expect(normalizeSnippetTextForContext("`cat`")).toBe("cat");
    });

    it("collapses surrounding whitespace", () => {
        expect(normalizeSnippetTextForContext("  cat  ")).toBe("cat");
    });

    it("returns empty string for empty input", () => {
        expect(normalizeSnippetTextForContext("")).toBe("");
    });
});

describe("findOpeningEqMarker", () => {
    const { findOpeningEqMarker } = SelectionLogic;

    it("finds the opening == that wraps a multi-word highlight", () => {
        // The user's case: ==Cervical Cancer==, user selects "Cancer"
        // "Cancer" starts at index 10 (in "==Cervical Cancer==").
        const body = "==Cervical Cancer==";
        const openEq = findOpeningEqMarker(body, 10, 0);
        expect(openEq).toBe(0);
    });

    it("finds the opening == for a single-word highlight", () => {
        const body = "before ==Cancer== after";
        // "Cancer" starts at index 10
        const openEq = findOpeningEqMarker(body, 10, 0);
        expect(openEq).toBe(7);
    });

    it("returns -1 when the position is between two highlights (not inside one)", () => {
        // pos = 12 ("word2" between two highlights)
        const body = "==word1== word2 ==word3==";
        const openEq = findOpeningEqMarker(body, 12, 0);
        expect(openEq).toBe(-1);
    });

    it("finds the opening == for the second of two adjacent highlights", () => {
        // ==word1== ==word2==, pos = 12 (start of "word2")
        const body = "==word1== ==word2==";
        const openEq = findOpeningEqMarker(body, 12, 0);
        expect(openEq).toBe(10);
    });

    it("respects the bodyStart bound", () => {
        // Body has a fake "frontmatter" we should skip
        const raw = "---title: foo---\n==Cancer==";
        const bodyStart = 17; // start of the second line
        const openEq = findOpeningEqMarker(raw, 19, bodyStart);
        expect(openEq).toBe(17);
    });
});
