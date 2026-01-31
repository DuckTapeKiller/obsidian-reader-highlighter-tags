![Reader Highlighter Tags Art](https://github.com/user-attachments/assets/3d9d5720-d308-4af5-b277-faab84745f62)

# Reader Highlighter Tags

A powerful Obsidian plugin that brings a **Medium-like highlighting experience** directly to **Reading View**.

Designed for power users who read long-form content in Obsidian, this plugin allows you to highlight, tag, annotate, and organize your notes without ever switching to Edit mode. It is "smart" about your content—understanding lists, indentation, and identical text occurrences to ensure your markdown remains clean and valid.

<div align="center">
  <video src="https://github.com/user-attachments/assets/dff37003-3d0d-4b25-9348-c9141bfe0029" controls="controls"></video>
</div>

---

## ✨ Features

### 🖍️ Smart Highlighting & Colors
Select text in Reading View to see the floating toolbar.
- **Context Aware**: Works perfectly with lists, blockquotes, and indented blocks.
- **Smart Expansion**: Automatically expands selections to capture whole words or existing markers to prevent messy formatting.
- **Color Palette**: Choose from **5 customizable colors** directly from the toolbar. Each color can have a specific meaning (e.g., Yellow for "Important", Blue for "Question") and can even apply an automatic tag.
- **Standard & Custom**: Supports both standard Obsidian highlighting (`==text==`) and persistent color highlighting (HTML `<mark>` tags) that retain their look across themes.

<p align="center">
  <img width="1644" height="1002" alt="Settings" src="https://github.com/user-attachments/assets/e575b4fe-c31f-4660-9a09-003494d2cfc5" />
</p>

### 📝 Footnote Annotations
Add comments to your highlights without cluttering the text.
- **Seamless Notes**: Click the **Annotation** button to add a comment.
- **Footnote Format**: Comments are automatically added as standard Markdown footnotes (`[^1]: My comment`) at the bottom of your document.
- **Non-Intrusive**: Keeps your reading flow uninterrupted while capturing your thoughts.

### 🏷️ Powerful Tagging
- **Multi-Select Modal**: Click the **Tag Icon** to open a fuzzy-search modal to apply multiple tags at once.
- **Smart Suggestions**: The plugin intelligently suggests tags based on:
    - **Recent Tags**: Your most frequently used tags.
    - **Folder Context**: Suggests tags based on the folder name (e.g., reading in `Books/` suggests `#books`).
    - **Frontmatter**: Suggests tags already used in the file's frontmatter.
- **Auto-Tagging**: Option to set a "Default Tag Prefix" that is automatically applied to every highlight.

<div align="center">
  <video src="https://github.com/user-attachments/assets/d72ea80d-6c09-4afa-9493-783cd01d598b" controls="controls"></video>
</div>

### 🗂️ Highlight Navigator
A dedicated sidebar view to manage your reading session.
- **Overview**: See a list of all highlights in the current document, organized by position.
- **Color Indicators**: Visual indicators show which color was used for each highlight.
- **Jump to Context**: Click any highlight in the list to instantly scroll to that location in the document.
- **Export**: One-click button to export all highlights to a separate Markdown file.

### 🛠️ Floating Toolbar
The toolbar appears instantly and intelligently when you select text.
- **Glassmorphism Design**: sleek, individual glass-effect buttons that don't obstruct your text.
- **Flexible Positioning**: Choose where it appears:
    - **Next to Text**: Follows your selection dynamically.
    - **Fixed Positions**: Top, Bottom, Left, or Right of the screen for consistent access.
- **Mobile Optimized**:
    - **Gestures**: Long-press text to highlight immediately.
    - **Smart UI**: Annotation modal automatically dodges the keyboard on mobile.
    - **Haptics**: Subtle vibration feedback on actions.
- **Customizable**: Toggle visibility for individual buttons (Tag, Quote, Remove, Annotation) and enable/disable tooltips.

<p align="center">
  <img src="https://github.com/user-attachments/assets/33e95fd7-f3fa-4bf7-a006-01c226b14662" alt="location_buttons" />
</p>

### 📥 Export & Management
- **Export to Markdown**: Create a summary note of all your highlights, properly linked back to the source.
- **Batch Remove**: Command to strip all highlights from a document instantly.
- **Cleanup**: Smart "Remove Highlight" button cleanly strips styles without breaking surrounding text.

### 📖 Reading Experience
- **Progress Tracker**: Automatically remembers your scroll position for every file. Resume exactly where you left off.
- **Undo Support**: Made a mistake? Use the "Undo last highlight" command to revert immediately.
- **Quote Templates**: Copy text as a formatted blockquote with custom templates (variables: `{{text}}`, `{{file}}`, `{{date}}`, `{{path}}`).

---

## ⚙️ Settings Guide

### Highlighting
* **Enable Color Highlighting**: Use `<mark>` tags for permanent colors instead of `==`.
* **Color Palette**: Configure your 5 quick-access colors and optional auto-tags for each.

### Toolbar
* **Toolbar Position**: Customize toolbar location (Text, Top, Bottom, Left, Right).
* **Button Visibility**: Show/hide Tag, Quote, Remove, or Annotation buttons.
* **Tooltips**: Toggle button tooltips on/off.

### Tags
* **Default Tag Prefix**: Automatically add this tag to *every* highlight.
* **Smart Suggestions**: Toggle contextual tag suggestions in the modal.

### Reading Progress
* **Track Progress**: Enable/disable saving scroll positions.
* **Clear Data**: Reset all saved reading positions.

### Shortcuts
* The plugin registers commands for almost every action, allowing you to set hotkeys for:
    * Highlighting & Tagging
    * Applying specific colors (1-5)
    * Adding annotations
    * Undoing the last action
    * Opening the Navigator
    * Exporting highlights

---

## 📦 Installation

### Manually
1.  Download the latest release (`main.js`, `manifest.json`, `styles.css`) from GitHub.
2.  Create a folder named `reader-highlighter-tags` inside your `.obsidian/plugins/` directory.
3.  Move the downloaded files into that folder.
4.  Reload Obsidian and enable **Reader Highlighter Tags** in **Settings > Community Plugins**.

---
