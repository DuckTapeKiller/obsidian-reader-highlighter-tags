# Reader Highlighter Tags

A powerful Obsidian plugin that allows you to **highlight** and **tag** text directly while in **Reading View**. 

Unlike other highlighting plugins, **Reader Highlighter Tags** is designed to be "smart" about your content—it understands lists, indentation, and identical text occurrences, ensuring your direct edits to the markdown source are precise and formatted correctly.

## Features

### 🖍️ Highlight in Reading View
Select any text in Reading View, and a floating toolbar will appear. 
- Click the **Highlighter Icon** to wrap your selection in `==markdown highlights==`.
- Works perfectly with **lists**, **indented blocks**, and **formatted text**.

### 🏷️ Smart Tagging
Add tags to your highlights instantly.
- Click the **Tag Icon** in the floating toolbar.
- **Search Existing Tags**: Fuzzy search through your vault's existing tags.
- **Create New Tags**: Type a new tag name (e.g., "Horror Book") and it will automatically convert it to a valid tag (`#Horror_Book`) and create it.
- **Auto-Formatting**: The plugin correctly places the tag *before* the highlight (e.g., `- #tag ==content==`), keeping your list formatting intact and your notes clean.

### 🧠 Intelligent Context Awareness
- **Whitespace Agnostic**: Select text regardless of how the browser renders distinct spaces vs. the source file. The plugin figures it out.
- **Duplicate Handling**: Have the same word appear 10 times in your note? The plugin knows exactly *which* one you selected and highlights only that specific instance.
- **Undo/Redo Support**: Seamlessly undo your highlights or tags without breaking your reading flow.

### ❌ Easy Removal
- Click on an existing highlight to bring up the toolbar and select the **Remove** button to strip the highlighting (and associated tag, if applicable).

## How to Use

1. **Open a Note** in Reading View.
2. **Select Text**: Drag to select any phrase, sentence, or list item.
3. **Use the Toolbar**:
    - **Highlight**: Click the marker icon.
    - **Tag**: Click the tag icon. Type to search or create a new tag.
    - **Remove**: Select already highlighted text to remove it.

## Installation

### Manually
1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Create a folder named `reader-highlighter-tags` inside your `.obsidian/plugins/` directory.
3. Move the downloaded files into that folder.
4. Reload Obsidian and enable the plugin in **Settings > Community Plugins**.

## Development

```bash
npm install
npm run build
```

---
Built by [DuckTapeKiller](https://github.com/DuckTapeKiller).
