# Reader Highlighter Tags


https://github.com/user-attachments/assets/dff37003-3d0d-4b25-9348-c9141bfe0029

A powerful Obsidian plugin that brings a **Medium-like highlighting experience** directly to **Reading View**. 

Designed for power users who read long-form content in Obsidian, this plugin allows you to highlight, tag, and organize your notes without ever switching to Edit mode. It is "smart" about your content—understanding lists, indentation, and identical text occurrences to ensure your markdown remains clean and valid.

## ✨ Key Features

### 🖍️ Smart Highlighting
Select text in Reading View to see the floating toolbar.
- **Context Aware**: Works perfectly with lists, blockquotes, and indented blocks.
- **Smart Expansion**: Automatically expands selections to capture whole words or existing markers (`==`, `**`, `*`) to prevent messy formatting.
- **Auto-Cleaning**: Prevents "stacking" styles. If you bold a text that is already italicized, it cleans the old style first.

### 🎨 Customizable Styles & Colors
Customize how your highlights look in the **Settings**:
- **Highlight Styles**: Choose between standard `==highlight==`, **Bold**, or *Italic*.
- **Custom Color**: Enable **Color Highlighting** to choose a specific hex color (e.g., Yellow `#FFEE58`). This uses HTML `<mark>` tags to render the color perfectly in Obsidian.

<img width="1644" height="1002" alt="Settings" src="https://github.com/user-attachments/assets/e575b4fe-c31f-4660-9a09-003494d2cfc5" />

### 🏷️ Powerful Tagging
- **Manual Tagging**: Click the **Tag Icon** to open a fuzzy-search modal. Search your vault's existing tags or create new ones on the fly.
- **Auto-Tagging**: Set a "Default Tag Prefix" (e.g., `book`) in settings. Every time you highlight text, it will automatically append that tag (e.g., `#book ==highlighted text==`).

https://github.com/user-attachments/assets/d72ea80d-6c09-4afa-9493-783cd01d598b

### 🛠️ Floating Toolbar
The toolbar appears instantly when you select text.
- **Positioning**: Choose where it appears—**Next to Text** (Dynamic), or fixed at the **Top**, **Bottom**, **Left**, or **Right** of the screen.
- **Custom Buttons**: Toggle visibility for the **Tag**, **Quote**, or **Remove** buttons in settings.
- **Workflow Tools**:
    - **Quote Button**: Copies the selection to your clipboard as a formatted Markdown blockquote with a backlink (`> text [[Link]]`).
    - **Remove Button**: Cleanly strips highlighting and tags from the selected text.


![location_buttons](https://github.com/user-attachments/assets/33e95fd7-f3fa-4bf7-a006-01c226b14662)

### 📱 Mobile Optimized
- **Haptic Feedback**: Subtle vibration on success (configurable).
- **Touch-Friendly**: Large buttons and improved selection logic prevent the keyboard from popping up accidentally.

---

## ⚙️ Settings Guide

### Toolbar Position
*   **Next to text**: The classic "floating" behavior.
*   **Fixed Top / Bottom**: Good for mobile users who want consistent access.
*   **Fixed Left / Right**: Ideal for tablet or desktop users (Default is **Right**).

### Styling
*   **Highlight Style**: Defines the markdown syntax applied (`==`, `**`, `*`).
*   **Enable Color Highlighting**: Overrides the style to use a custom background color.
*   **Highlight Color**: The hex code for your custom color.

### Tags
*   **Default Tag Prefix**: If set (e.g., `todo`), this tag is automatically added to *every* highlight. Leave empty for manual tagging only.

### Buttons
*   Toggle **Show Tag Button**, **Show Quote Button**, or **Show Remove Button** to de-clutter your toolbar.

---

## 📦 Installation

### Manually
1.  Download the latest release (`main.js`, `manifest.json`, `styles.css`) from GitHub.
2.  Create a folder named `reader-highlighter-tags` inside your `.obsidian/plugins/` directory.
3.  Move the downloaded files into that folder.
4.  Reload Obsidian and enable **Reader Highlighter Tags** in **Settings > Community Plugins**.

## 💻 Development

```bash
npm install
npm run build
```

---
Built by [DuckTapeKiller](https://github.com/DuckTapeKiller).
