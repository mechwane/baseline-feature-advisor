import * as vscode from 'vscode';

export interface AISuggestion {
    alternative: string;
    explanation: string;
    replacementCode: string;
    codeExample: string;
    browserSupport: string;
    providerUsed: string;
}

export class AIAdvisor {
    private cache = new Map<string, AISuggestion>();

    clearCache() {
        this.cache.clear();
    }

    async getSuggestion(
        api: string,
        codeSnippet: string,
        surroundingContext: string,
        languageId: string,
        token?: vscode.CancellationToken
    ): Promise<AISuggestion> {
        const config = vscode.workspace.getConfiguration('baselineAdvisor');
        const aiEnabled = config.get<boolean>('aiSuggestions', true);
        const provider = config.get<string>('aiProvider', 'auto');
        const geminiKey = (config.get<string>('geminiApiKey', '') || '').trim();
        const openaiKey = (config.get<string>('openaiApiKey', '') || '').trim();

        const cacheKey = `${provider}:${languageId}:${api}:${codeSnippet.trim()}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey)!;
        }

        if (!aiEnabled) {
            return this.getFallbackSuggestion(api, codeSnippet);
        }

        const prompt = this.buildPrompt(api, codeSnippet, surroundingContext, languageId);

        try {
            let result: AISuggestion | null = null;

            if (provider === 'gemini' || (provider === 'auto' && geminiKey)) {
                if (geminiKey) {
                    result = await this.callGemini(geminiKey, prompt);
                }
            }

            if (!result && (provider === 'openai' || (provider === 'auto' && openaiKey))) {
                if (openaiKey) {
                    result = await this.callOpenAI(openaiKey, prompt);
                }
            }

            if (!result && (provider === 'vscode-lm' || provider === 'auto')) {
                result = await this.callVSCodeLM(prompt, token);
            }

            if (result) {
                this.cache.set(cacheKey, result);
                return result;
            }
        } catch (error) {
            console.error('Baseline Advisor AI error:', error);
        }

        const fallback = this.getFallbackSuggestion(api, codeSnippet);
        this.cache.set(cacheKey, fallback);
        return fallback;
    }

    private buildPrompt(api: string, codeSnippet: string, surroundingContext: string, languageId: string): string {
        return `You are a Web Standards & Baseline Compatibility expert.
Language: ${languageId}
Flagged Feature/API: ${api}
Exact Code Snippet to Replace:
\`\`\`${languageId}
${codeSnippet}
\`\`\`

Surrounding Context:
\`\`\`${languageId}${surroundingContext}
\`\`\`

Provide a modern, Baseline-supported replacement. Return ONLY valid JSON with these exact keys (no markdown fences):
{
  "alternative": "Short name of the Baseline replacement API or pattern",
  "explanation": "1-2 concise sentences explaining why the original feature is non-Baseline/unsafe and how the replacement solves it",
  "replacementCode": "The exact drop-in replacement code for the snippet above (clean code only, no markdown fences or comments)",
  "codeExample": "A short practical usage example",
  "browserSupport": "Cross-browser Baseline support summary"
}`;
    }

    private async callVSCodeLM(prompt: string, token?: vscode.CancellationToken): Promise<AISuggestion | null> {
        if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
            return null;
        }

        const models = await vscode.lm.selectChatModels();
        if (!models || models.length === 0) {
            return null;
        }

        const model = models[0];
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const cts = new vscode.CancellationTokenSource();
        const response = await model.sendRequest(messages, {}, token || cts.token);

        let fullText = '';
        for await (const chunk of response.text) {
            fullText += chunk;
        }

        return this.parseStructuredJSON(fullText, `VS Code AI (${model.name})`);
    }

    private async callGemini(apiKey: string, prompt: string): Promise<AISuggestion | null> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.2,
                    responseMimeType: 'application/json'
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Gemini API HTTP ${response.status}`);
        }

        const data: any = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return this.parseStructuredJSON(text, 'Google Gemini');
    }

    private async callOpenAI(apiKey: string, prompt: string): Promise<AISuggestion | null> {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: 'You are a web standards expert. Always respond with valid JSON matching the requested schema.'
                    },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.2,
                max_tokens: 450
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API HTTP ${response.status}`);
        }

        const data: any = await response.json();
        const text = data?.choices?.[0]?.message?.content || '';
        return this.parseStructuredJSON(text, 'OpenAI');
    }

    private parseStructuredJSON(rawText: string, providerUsed: string): AISuggestion | null {
        const cleaned = rawText
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();

        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.alternative && !parsed.replacementCode) return null;

        return {
            alternative: parsed.alternative || 'Baseline-supported alternative',
            explanation: parsed.explanation || 'Replaced with a cross-browser Baseline-compliant API.',
            replacementCode: (parsed.replacementCode || '').trim(),
            codeExample: (parsed.codeExample || parsed.replacementCode || '').trim(),
            browserSupport: parsed.browserSupport || 'Baseline Widely Available',
            providerUsed
        };
    }

    getFallbackSuggestion(api: string, codeSnippet: string): AISuggestion {
        const fallbacks: Record<string, Omit<AISuggestion, 'providerUsed'>> = {
            'document.execCommand': {
                alternative: 'Clipboard API (navigator.clipboard.writeText)',
                explanation: 'document.execCommand() is deprecated and synchronous. The asynchronous Clipboard API is Baseline Widely Available and secure.',
                replacementCode: codeSnippet.replace(/document\.execCommand\s*\(\s*['"]copy['"]\s*\)/g, 'navigator.clipboard.writeText(text)'),
                codeExample: `await navigator.clipboard.writeText(textToCopy);`,
                browserSupport: 'Chrome 66+, Edge 79+, Firefox 63+, Safari 13.1+'
            },
            'document.write': {
                alternative: 'DOM Manipulation (insertAdjacentHTML / appendChild)',
                explanation: 'document.write() blocks page rendering and fails in deferred or module scripts.',
                replacementCode: codeSnippet.replace(/document\.write\s*\(([^)]+)\)/g, 'document.body.insertAdjacentHTML("beforeend", $1)'),
                codeExample: `document.body.insertAdjacentHTML('beforeend', '<p>Hello</p>');`,
                browserSupport: 'Baseline Widely Available across all browsers'
            },
            'eval': {
                alternative: 'JSON.parse()',
                explanation: 'eval() executes arbitrary strings as code, creating severe XSS risks and breaking Content Security Policy.',
                replacementCode: codeSnippet.replace(/\beval\s*\(/g, 'JSON.parse('),
                codeExample: `const data = JSON.parse(jsonString);`,
                browserSupport: 'Baseline Widely Available across all browsers'
            },
            'webkitRequestAnimationFrame': {
                alternative: 'requestAnimationFrame()',
                explanation: 'Vendor prefixes for requestAnimationFrame are obsolete.',
                replacementCode: codeSnippet.replace(/webkitRequestAnimationFrame/g, 'requestAnimationFrame'),
                codeExample: `requestAnimationFrame(animate);`,
                browserSupport: 'Baseline Widely Available across all browsers'
            },
            'mozRequestAnimationFrame': {
                alternative: 'requestAnimationFrame()',
                explanation: 'Vendor prefixes for requestAnimationFrame are obsolete.',
                replacementCode: codeSnippet.replace(/mozRequestAnimationFrame/g, 'requestAnimationFrame'),
                codeExample: `requestAnimationFrame(animate);`,
                browserSupport: 'Baseline Widely Available across all browsers'
            },
            'navigator.webkitGetUserMedia': {
                alternative: 'navigator.mediaDevices.getUserMedia()',
                explanation: 'navigator.webkitGetUserMedia is deprecated in favor of the promise-based MediaDevices API.',
                replacementCode: codeSnippet.replace(/navigator\.webkitGetUserMedia/g, 'navigator.mediaDevices.getUserMedia'),
                codeExample: `const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });`,
                browserSupport: 'Baseline Widely Available across all browsers'
            },
            'document.startViewTransition': {
                alternative: 'Feature-guarded View Transitions',
                explanation: 'Same-document View Transitions became Baseline Newly Available recently; guard it so older browsers fall back cleanly.',
                replacementCode: `document.startViewTransition ? ${codeSnippet} : updateDOM()`,
                codeExample: `if (document.startViewTransition) {\n  document.startViewTransition(() => updateDOM());\n} else {\n  updateDOM();\n}`,
                browserSupport: 'Chrome 111+, Edge 111+, Safari 18+, Firefox 144+'
            }
        };

        const match = fallbacks[api];
        if (match) {
            return { ...match, providerUsed: 'Built-in Baseline Knowledge Base' };
        }

        return {
            alternative: `Feature-guarded ${api}`,
            explanation: `${api} is not yet Baseline Widely Available across all core browsers. Add feature detection before calling it.`,
            replacementCode: codeSnippet,
            codeExample: `// Check browser support before using ${api}`,
            browserSupport: 'Partial browser support — verify on MDN / web.dev Baseline',
            providerUsed: 'Built-in Baseline Knowledge Base'
        };
    }
}