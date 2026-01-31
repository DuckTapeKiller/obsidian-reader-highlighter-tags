/**
 * Export highlights from a file to a new markdown file.
 * Finds all ==text== and <mark>text</mark> elements and creates a summary.
 */
export async function exportHighlightsToMD(app, file) {
    const raw = await app.vault.read(file);

    const highlights = [];

    // Pattern for ==text== (markdown highlights)
    const markdownPattern = /==(.*?)==/gs;

    // Pattern for <mark>text</mark> (HTML highlights)
    const htmlPattern = /<mark[^>]*>(.*?)<\/mark>/gs;

    // Extract markdown highlights
    let match;
    while ((match = markdownPattern.exec(raw)) !== null) {
        highlights.push({
            text: match[1].trim(),
            type: "markdown",
            position: match.index
        });
    }

    // Extract HTML highlights
    while ((match = htmlPattern.exec(raw)) !== null) {
        highlights.push({
            text: match[1].trim(),
            type: "html",
            position: match.index
        });
    }

    // Sort by position in document
    highlights.sort((a, b) => a.position - b.position);

    if (highlights.length === 0) {
        throw new Error("No highlights found in this file.");
    }

    // Get current date
    const date = window.moment
        ? window.moment().format("YYYY-MM-DD HH:mm")
        : new Date().toISOString().split("T")[0];

    // Generate export content
    const exportContent = `# Highlights from [[${file.basename}]]

> Exported: ${date}
> Source: [[${file.path}]]
> Total highlights: ${highlights.length}

---

${highlights.map((h, i) => `${i + 1}. ${h.text}`).join("\n\n")}

---

*Exported by Reader Highlighter Tags*
`;

    // Create unique filename
    let exportPath = `${file.parent.path}/${file.basename} - Highlights.md`;

    // Check if file exists, if so add timestamp
    const existingFile = app.vault.getAbstractFileByPath(exportPath);
    if (existingFile) {
        const timestamp = window.moment
            ? window.moment().format("YYYYMMDD-HHmmss")
            : Date.now();
        exportPath = `${file.parent.path}/${file.basename} - Highlights ${timestamp}.md`;
    }

    await app.vault.create(exportPath, exportContent);

    return exportPath;
}

/**
 * Get all highlights from a file for the navigator view.
 * Returns array of { text, type, position, context }
 */
export function getHighlightsFromContent(raw) {
    const highlights = [];

    // Pattern for ==text== (markdown highlights)
    const markdownPattern = /==(.*?)==/gs;

    // Pattern for <mark>text</mark> (HTML highlights)
    const htmlPattern = /<mark[^>]*>(.*?)<\/mark>/gs;

    // Extract markdown highlights
    let match;
    while ((match = markdownPattern.exec(raw)) !== null) {
        // Get surrounding context (line it's on)
        const lineStart = raw.lastIndexOf("\n", match.index) + 1;
        const lineEnd = raw.indexOf("\n", match.index + match[0].length);
        const context = raw.substring(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

        highlights.push({
            text: match[1].trim(),
            type: "markdown",
            position: match.index,
            context: context
        });
    }

    // Extract HTML highlights
    while ((match = htmlPattern.exec(raw)) !== null) {
        const lineStart = raw.lastIndexOf("\n", match.index) + 1;
        const lineEnd = raw.indexOf("\n", match.index + match[0].length);
        const context = raw.substring(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();

        // Try to extract color from style
        const colorMatch = match[0].match(/background:\s*([^;>"]+)/);
        const color = colorMatch ? colorMatch[1].trim() : null;

        highlights.push({
            text: match[1].trim(),
            type: "html",
            position: match.index,
            context: context,
            color: color
        });
    }

    // Sort by position in document
    highlights.sort((a, b) => a.position - b.position);

    return highlights;
}
