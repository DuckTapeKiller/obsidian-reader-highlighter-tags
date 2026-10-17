/**
 * Generates an Obsidian Canvas from an array of highlights.
 * Grouped visually by file.
 */
import { App, TFile } from "obsidian";
import type { Highlight } from "./highlights";
import { formatDate } from "./time";
import type { HighlightColor } from "./colors";

export type HighlightWithFile = Highlight & { file: TFile };

const CANVAS_COLORS: Record<HighlightColor, string> = {
    red: "1",
    orange: "2",
    yellow: "3",
    green: "4",
    blue: "5",
    purple: "6",
};

interface CanvasNode {
    id: string;
    type: "file" | "text";
    file?: string;
    text?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
}

interface CanvasEdge {
    id: string;
    fromNode: string;
    fromSide: string;
    toNode: string;
    toSide: string;
}

function generateId(): string {
    return Math.random().toString(36).substring(2, 12) + Math.random().toString(36).substring(2, 12);
}

export async function exportHighlightsToCanvas(app: App, allHighlights: HighlightWithFile[]): Promise<string> {
    if (!allHighlights || allHighlights.length === 0) {
        throw new Error("No highlights to export.");
    }

    // Group highlights by file path
    const groups = new Map<string, { file: TFile; highlights: HighlightWithFile[] }>();
    for (const h of allHighlights) {
        if (!groups.has(h.file.path)) {
            groups.set(h.file.path, { file: h.file, highlights: [] });
        }
        groups.get(h.file.path).highlights.push(h);
    }

    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];

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
            color: "3", // Default obsidian color (blue/green-ish)
        });

        let rowIndex = 1;
        for (const h of group.highlights) {
            const hNodeId = generateId();

            // Canvas colours: 1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple.
            const canvasColor = h.color ? CANVAS_COLORS[h.color] : "";

            nodes.push({
                id: hNodeId,
                type: "text",
                text: `${h.text}\n\n— [[${group.file.path}|${group.file.basename}]]`,
                x: currentX,
                y: rowIndex * (ROW_HEIGHT + ROW_SPACING),
                width: COLUMN_WIDTH,
                height: ROW_HEIGHT,
                color: canvasColor,
            });

            // Create an edge from the file to the highlight
            edges.push({
                id: generateId(),
                fromNode: fileNodeId,
                fromSide: "bottom",
                toNode: hNodeId,
                toSide: "top",
            });

            rowIndex++;
        }

        columnIndex++;
    }

    const canvasData = {
        nodes,
        edges,
    };

    // Generate filename
    const date = formatDate("YYYYMMDD-HHmmss");
    const exportPath = `Research Canvas ${date}.canvas`;

    await app.vault.create(exportPath, JSON.stringify(canvasData, null, 2));

    return exportPath;
}
