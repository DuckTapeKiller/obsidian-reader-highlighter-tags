![Reader Highlighter Tags Art](https://github.com/user-attachments/assets/3d9d5720-d308-4af5-b277-faab84745f62)

# Reader Highlighter Tags

A powerful Obsidian plugin that brings a **Medium-like highlighting experience** directly to **Reading View**.

Designed for power users who read long-form content in Obsidian, this plugin allows you to highlight, tag, annotate, and organize your notes without ever switching to Edit mode. It is "smart" about your content—understanding lists, indentation, and identical text occurrences to ensure your markdown remains clean and valid.

### Video Tutorial
![Tutorial Video](videos/tutorial.mp4)
---

## Core Features

### High-Precision Selection Engine
The plugin utilizes a custom "Noise Shield" structural filtering engine. This system strips non-visible Markdown syntax—including footnotes, task checkboxes, callout headers, and internal HTML tags—from the virtual content before matching. This ensures that text selected in the browser precisely correlates with the physical coordinates in the source file.

- **Coordinate Mapping**: Handles complex document transformations, including transclusions and embedded files, to accurately inject markers into the underlying Markdown.
- **Literal Character Support**: Sophisticated regex gap patterns preserve literal characters like brackets, asterisks, and dollar signs, ensuring that technical notes (math formulas, regex strings) are highlighted with 100% accuracy.
- **Anchor Matching**: Large multi-paragraph selections are located using a dual-anchor strategy (start and end chunks), providing resilience against structural anomalies in long blocks.

### Global Research & Advanced Filtering
Evolve your highlights into a structured knowledge base with the **Global Research View**.
- **Vault-Wide Scanning**: Search and aggregate highlights across your entire vault in a single, high-performance view.
- **Advanced Property Filtering**: Filter your research by *any* Obsidian property field (frontmatter). Select keys like `Autor`, `tags`, `category`, or `status` and filter by specific values.
- **Smart Tag Support**: Intelligently handles Obsidian's array and string tag formats, supporting partial matches (e.g., filtering for "research" finds notes tagged `#research`).
- **Semantic Color Filtering**: Toggle 15 dedicated color chips to isolate highlights by their assigned meanings (e.g., "Show me only 'Vocabulary' highlights").

### Visual Knowledge Mapping (Canvas Integration)
Transform linear highlights into 2D spatial maps.
- **Global Canvas Export**: Export your filtered Research View results into a structured Obsidian Canvas.
- **Single-Note Explosion**: Export the current document's highlights into a canvas node graph with a single click from the sidebar.
- **Automatic Layout**: Highlights are clustered as individual cards connected to their parent file cards via visual edges.

### Live Sync & Transclusion Exports
Generate highlight notebooks that never get out of date.
- **Block-Reference Injection**: The export engine intelligently injects unique Obsidian block IDs (`^id`) into your source documents if they are missing.
- **Live Transclusions**: Exports use the `![[File#^id]]` syntax. Any edits, typo fixes, or contextual updates made in your source notes are automatically reflected in your exported highlight summaries.

### Smart Content Handling
- **Callout Blocks**: Automatically recognizes Obsidian callout prefixes (e.g., `> [!INFO]`). Highlights are applied to the inner content without corrupting the callout syntax.
- **Native HTML Blocks**: Capable of matching text within raw HTML `div` or `span` tags by stripping structural tags from the search buffer.
- **PDF Companion Notes**: Attach the floating toolbar to PDF views. Highlights captured from PDFs are automatically saved into a sibling Markdown file (e.g., `Book - Highlights.md`) with linked back-references.

### Tagging and Metadata
- **Frontmatter Integration**: Optionally applies highlight tags directly to the note's YAML frontmatter. Existing tags are checked to prevent duplicates.
- **Semantic Taxonomy**: Assign custom "meanings" to a palette of 15 UI-optimized colors in the settings for precise categorization.
- **Contextual Suggestions**: Fuzzy-search tagging modal suggests tags based on recent usage, folder names, and existing file metadata.

### Workflow Tools
- **Highlight Navigator**: A dedicated sidebar view with tabbed switching for highlights and footnotes. Includes an instant "Export Canvas" action for the current file.
- **Erase Highlight**: A "sweep-and-clean" utility that removes markers from the selected range, even across multiple paragraphs.
- **Footnote Annotations**: Captures comments as standard Markdown footnotes appended to the bottom of the document.
- **Quote Templates**: Customizable templates for copying text as formatted blockquotes with metadata variables (date, file path, context).

### UI and Performance
- **Aesthetic Toolbar**: A glassmorphism-inspired floating toolbar with wrapped semantic color grids.
- **Mobile Optimization**: includes haptic feedback, keyboard-aware modals, and long-press shortcuts for mobile reading efficiency.
- **Performance**: Asynchronous vault scanning and safe regex execution prevent browser freezes even in massive vaults.

## Settings

### Highlighting
- **15-Color Palette**: Use a fixed, meticulously chosen semantic taxonomy. Assign "Meanings" (e.g. Pink = "Insight", Blue = "Vocabulary") to colors for global filtering.
- **Color Highlighting**: Toggle between standard Obsidian `==` syntax and HTML `<mark>` tags for persistent, theme-independent colors.

### Toolbar
- **Custom Positioning**: Set the toolbar to follow text or remain anchored to screen edges.
- **Toggle Buttons**: Enable or disable specific actions (Tag, Quote, Erase, Annotate) based on your personal workflow.

### Integration
- **Reading Progress**: Automatically tracks and restores the scroll position for every note in your vault.
- **Hotkeys**: Mod+Shift+1-9 for instant semantic color application and comprehensive command registration for all core actions.

## Installation

### Manual Installation
1. Download the latest release files (`main.js`, `manifest.json`, `styles.css`) from the GitHub releases page.
2. Create a folder named `reader-highlighter-tags` in your vault's `.obsidian/plugins/` directory.
3. Move the downloaded files into that folder.
