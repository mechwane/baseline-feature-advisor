# AI-Powered Baseline Feature Advisor

[![Version](https://img.shields.io/visual-studio-marketplace/v/Algma-Tech.baseline-feature-advisor)](https://marketplace.visualstudio.com/items?itemName=Algma-Tech.baseline-feature-advisor)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/Algma-Tech.baseline-feature-advisor)](https://marketplace.visualstudio.com/items?itemName=Algma-Tech.baseline-feature-advisor)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/Algma-Tech.baseline-feature-advisor)](https://marketplace.visualstudio.com/items?itemName=Algma-Tech.baseline-feature-advisor)

⚡ **Baseline Feature Advisor** helps developers detect unsafe, deprecated, or non-Baseline web APIs, HTML attributes, and CSS features in their code and suggests **Baseline-supported, secure alternatives** — powered by AI.

---

## ✨ What's New in v2.0.0

- **Official W3C/MDN `web-features` Engine:** Checks JavaScript, TypeScript, JSX/TSX, HTML, and CSS against live Baseline **Widely Available** and **Newly Available** browser support targets.
- **Multi-Provider AI Advisor:** Supports **VS Code Built-in AI (`vscode.lm` — zero API key required)**, **Google Gemini (`gemini-2.5-flash`)**, and **OpenAI (`gpt-4o-mini`)**, plus an offline built-in Baseline knowledge base.
- **One-Click Lightbulb Quick Fixes (`Ctrl + .`):** Apply instant deterministic replacements or context-aware AI fixes directly in your editor.
- **HTML & CSS Baseline Scanning:** Detects experimental or non-Baseline CSS properties (`anchor-name`, `view-transition-name`, `:has()`), HTML tags/attributes (`popover`, `<dialog>`), and inline `<script>` / `<style>` blocks.
- **Live Status Bar Indicator:** Track file Baseline compliance at a glance in the VS Code status bar.

---

## 🚀 Features

- Detects unsafe, deprecated, and non-Baseline web APIs  
- Scans individual files or entire workspaces  
- Real-time scanning while typing  
- AI-powered hover cards and one-click Quick Fixes (`Ctrl + .`)  
- Works with **JavaScript, TypeScript, JSX, TSX, HTML, and CSS**

---

## 🛠️ Commands

| Command | Description |
|---------|-------------|
| **Baseline Advisor: Scan File for Non-Baseline Features** | Scan the active file for non-Baseline APIs, HTML, and CSS |
| **Baseline Advisor: Scan Workspace for Non-Baseline Features** | Scan all supported files across the entire workspace |
| **Baseline Advisor: Get AI Baseline Fix** | Replace a flagged feature with an AI-generated Baseline alternative |

---

## ⚙️ Configuration

Go to **Settings → Extensions → Baseline Feature Advisor**:

- `baselineAdvisor.enableRealTimeScanning` → Enable/disable real-time scanning while typing  
- `baselineAdvisor.targetBaseline` → Choose `"widely"` (30+ months cross-browser support) or `"newly"` (latest interoperable features)  
- `baselineAdvisor.aiSuggestions` → Enable or disable AI-powered suggestions and Quick Fixes  
- `baselineAdvisor.aiProvider` → Choose `"auto"`, `"vscode-lm"`, `"gemini"`, or `"openai"`  
- `baselineAdvisor.geminiApiKey` → Your Google Gemini API key for suggestions  
- `baselineAdvisor.openaiApiKey` → Your OpenAI API key for suggestions  

---

## 📦 Installation

You can install the extension in two ways:

### From VS Code Marketplace
1. Open **Visual Studio Code**  
2. Go to the **Extensions** sidebar (`Ctrl+Shift+X`)  
3. Search for **AI-Powered Baseline Feature Advisor**  
4. Click **Install**

### From the command line
Run this command in your terminal:
```bash
code --install-extension Algma-Tech.baseline-feature-advisor