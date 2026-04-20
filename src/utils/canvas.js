/**
 * Generates an Obsidian Canvas from an array of highlights.
 * Grouped visually by file.
 */

function generateId() {
    return Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 12);
}

export async function exportHighlightsToCanvas(app, allHighlights) {
    if (!allHighlights || allHighlights.length === 0) {
        throw new Error("No highlights to export.");
    }

    // Group highlights by file path
    const groups = new Map();
    for (const h of allHighlights) {
        if (!groups.has(h.file.path)) {
            groups.set(h.file.path, { file: h.file, highlights: [] });
        }
        groups.get(h.file.path).highlights.push(h);
    }

    const nodes = [];
    const edges = [];

    let columnIndex = 0;
    const COLUMN_WIDTH = 500;
    const COLUMN_SPACING = 200;
    const ROW_HEIGHT = 200;
    const ROW_SPACING = 150;

    for (const group of groups.values()) {
        const fileNodeId = generateId();
        
        const currentX = columnIndex * (COLUMN_WIDTH + COLUMN_SPACING);
        
        // Create the top-level parent node for the file
        nodes.push({
            id: fileNodeId,
            type: "file",
            file: group.file.path,
            x: currentX,
            y: 0,
            width: COLUMN_WIDTH,
            height: 100,
            color: "3" // Default obsidian color (blue/green-ish)
        });

        let rowIndex = 1;
        for (const h of group.highlights) {
            const hNodeId = generateId();
            
            // Try to map a semantic color to a canvas color index if available
            // Canvas colors: 1:red, 2:orange, 3:yellow, 4:green, 5:cyan, 6:purple
            let canvasColor = "";
            if (h.color) {
                const colorMap = {
                    "#ffcdd2": "1", "#f8bbd0": "6", "#e1bee7": "6", "#d1c4e9": "6",
                    "#c5cae9": "6", "#bbdefb": "5", "#b3e5fc": "5", "#b2ebf2": "5",
                    "#b2dfdb": "4", "#c8e6c9": "4", "#dcedc8": "4", "#f0f4c0": "3",
                    "#fff9c4": "3", "#ffecb3": "2", "#ffe0b2": "2"
                };
                canvasColor = colorMap[h.color.toLowerCase()] || "";
            }

            nodes.push({
                id: hNodeId,
                type: "text",
                text: `${h.text}\n\n— [[${group.file.path}|${group.file.basename}]]`,
                x: currentX,
                y: rowIndex * (ROW_HEIGHT + ROW_SPACING),
                width: COLUMN_WIDTH,
                height: ROW_HEIGHT,
                color: canvasColor
            });

            // Create an edge from the file to the highlight
            edges.push({
                id: generateId(),
                fromNode: fileNodeId,
                fromSide: "bottom",
                toNode: hNodeId,
                toSide: "top"
            });

            rowIndex++;
        }
        
        columnIndex++;
    }

    const canvasData = {
        nodes,
        edges
    };

    // Generate filename
    const date = window.moment ? window.moment().format("YYYYMMDD-HHmmss") : Date.now();
    let exportPath = `Research Canvas ${date}.canvas`;

    await app.vault.create(exportPath, JSON.stringify(canvasData, null, 2));
    
    return exportPath;
}
