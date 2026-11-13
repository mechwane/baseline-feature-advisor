import * as vscode from 'vscode';
import * as ts from 'typescript';

// Load web-features data.json directly so CommonJS never hits ERR_REQUIRE_ESM
let featuresData: Record<string, any> = {};
try {
    const rawData = require('web-features/data.json');
    featuresData = rawData.features || rawData;
} catch {
    try {
        const pkg = require('web-features');
        featuresData = pkg.features || pkg.default?.features || {};
    } catch (e) {
        console.error('Could not load web-features dataset:', e);
    }
}

export interface APIIssue {
    api: string;
    featureName: string;
    line: number;       // 1-based
    column: number;     // 0-based
    endLine: number;    // 1-based
    endColumn: number;  // 0-based
    category: 'js-api' | 'html' | 'css' | 'security';
    type: 'deprecated' | 'non-baseline' | 'newly-available' | 'unsafe';
    description: string;
    suggestion: string;
    browserSupport: string;
    status: string;
    baselineDate?: string;
    mdnUrl?: string;
    codeSnippet?: string;
}

export interface APIInfo {
    isBaseline: boolean;
    baselineLevel: 'high' | 'low' | 'false' | 'unsafe';
    featureName: string;
    browserSupport: string;
    status: string;
    suggestion?: string;
    baselineDate?: string;
}

interface FeatureRule {
    featureId: string;
    featureName: string;
    baseline: 'high' | 'low' | false | 'unsafe';
    baselineDate?: string;
    browserSupport: string;
    status: string;
    suggestion: string;
    category: 'js-api' | 'html' | 'css' | 'security';
}

export class BaselineScanner {
    private jsRules = new Map<string, FeatureRule>();
    private cssPropertyRules = new Map<string, FeatureRule>();
    private cssSelectorRules = new Map<string, FeatureRule>();
    private htmlTagRules = new Map<string, FeatureRule>();
    private htmlAttrRules = new Map<string, FeatureRule>();

    constructor() {
        this.buildRulesIndex();
    }

    private buildRulesIndex() {
        // 1. Index official W3C/MDN web-features dataset
        for (const [featureId, feature] of Object.entries(featuresData)) {
            if (!feature || typeof feature !== 'object' || !feature.status) continue;
            if (feature.kind && feature.kind !== 'feature') continue;

            const baselineRaw = feature.status.baseline; // 'high' | 'low' | false
            const baseline: 'high' | 'low' | false =
                baselineRaw === 'high' ? 'high' :
                baselineRaw === 'low' ? 'low' : false;

            const supportSummary = this.formatBrowserSupport(feature.status);
            const statusLabel =
                baseline === 'high' ? `Baseline Widely Available (since ${feature.status.baseline_high_date || 'N/A'})` :
                baseline === 'low' ? `Baseline Newly Available (since ${feature.status.baseline_low_date || 'N/A'})` :
                'Limited Availability (Not Baseline)';

            const baseRule: Omit<FeatureRule, 'category'> = {
                featureId,
                featureName: feature.name || featureId,
                baseline,
                baselineDate: feature.status.baseline_low_date,
                browserSupport: supportSummary,
                status: statusLabel,
                suggestion: baseline === false
                    ? `Feature "${feature.name || featureId}" is not yet Baseline across all core browsers. Provide a fallback or polyfill.`
                    : `Feature "${feature.name || featureId}" became Baseline Newly Available on ${feature.status.baseline_low_date}. Verify browser targets.`
            };

            const compatFeatures: string[] = feature.compat_features || [];
            for (const bcdKey of compatFeatures) {
                this.mapBcdKeyToRule(bcdKey, baseRule);
            }
        }

        // 2. Add curated high-value unsafe, deprecated, and modern web APIs
        const curatedJsRules: Array<[string, FeatureRule]> = [
            ['document.execCommand', {
                featureId: 'execCommand',
                featureName: 'document.execCommand()',
                baseline: false,
                browserSupport: 'Deprecated across all modern browsers; inconsistent behavior',
                status: 'Deprecated / Non-Standard',
                suggestion: 'Use the asynchronous Clipboard API (navigator.clipboard.writeText / readText) instead.',
                category: 'js-api'
            }],
            ['document.write', {
                featureId: 'document-write',
                featureName: 'document.write()',
                baseline: 'unsafe',
                browserSupport: 'Blocked by browsers on slow connections and async scripts',
                status: 'Unsafe / Performance Anti-Pattern',
                suggestion: 'Use DOM manipulation methods like document.createElement() and element.appendChild().',
                category: 'security'
            }],
            ['eval', {
                featureId: 'eval',
                featureName: 'eval()',
                baseline: 'unsafe',
                browserSupport: 'Blocked by Content Security Policy (CSP) and prone to XSS injection',
                status: 'Unsafe Security Risk',
                suggestion: 'Use JSON.parse() for data parsing or safe structured logic instead of eval().',
                category: 'security'
            }],
            ['webkitRequestAnimationFrame', {
                featureId: 'requestAnimationFrame',
                featureName: 'webkitRequestAnimationFrame()',
                baseline: false,
                browserSupport: 'Legacy vendor-prefixed API',
                status: 'Deprecated Vendor Prefix',
                suggestion: 'Use standard requestAnimationFrame() (Baseline Widely Available).',
                category: 'js-api'
            }],
            ['mozRequestAnimationFrame', {
                featureId: 'requestAnimationFrame',
                featureName: 'mozRequestAnimationFrame()',
                baseline: false,
                browserSupport: 'Legacy vendor-prefixed API',
                status: 'Deprecated Vendor Prefix',
                suggestion: 'Use standard requestAnimationFrame() (Baseline Widely Available).',
                category: 'js-api'
            }],
            ['navigator.webkitGetUserMedia', {
                featureId: 'getUserMedia',
                featureName: 'navigator.webkitGetUserMedia()',
                baseline: false,
                browserSupport: 'Legacy vendor-prefixed media capture API',
                status: 'Deprecated Vendor Prefix',
                suggestion: 'Use navigator.mediaDevices.getUserMedia() instead.',
                category: 'js-api'
            }],
            ['window.showOpenFilePicker', {
                featureId: 'file-system-access',
                featureName: 'File System Access API (showOpenFilePicker)',
                baseline: false,
                browserSupport: 'Chromium only; not supported in Firefox or Safari',
                status: 'Not Baseline (Chromium-only)',
                suggestion: 'Provide an <input type="file"> fallback for Safari and Firefox users.',
                category: 'js-api'
            }],
            ['navigator.bluetooth', {
                featureId: 'web-bluetooth',
                featureName: 'Web Bluetooth API',
                baseline: false,
                browserSupport: 'Chromium only; unsupported in Safari and Firefox',
                status: 'Not Baseline (Experimental)',
                suggestion: 'Guard with ("bluetooth" in navigator) and show a graceful unsupported UI state.',
                category: 'js-api'
            }],
            ['navigator.usb', {
                featureId: 'webusb',
                featureName: 'WebUSB API',
                baseline: false,
                browserSupport: 'Chromium only; unsupported in Safari and Firefox',
                status: 'Not Baseline (Experimental)',
                suggestion: 'Guard with ("usb" in navigator) and provide a fallback workflow.',
                category: 'js-api'
            }],
            ['document.startViewTransition', {
                featureId: 'view-transitions',
                featureName: 'Same-Document View Transitions API',
                baseline: 'low',
                baselineDate: '2025-10-01',
                browserSupport: 'Chrome 111+, Edge 111+, Safari 18+, Firefox 144+',
                status: 'Baseline Newly Available',
                suggestion: 'Wrap calls in if (document.startViewTransition) so older browsers update the DOM cleanly.',
                category: 'js-api'
            }]
        ];

        for (const [key, rule] of curatedJsRules) {
            this.jsRules.set(key, rule);
        }
    }

    private mapBcdKeyToRule(bcdKey: string, baseRule: Omit<FeatureRule, 'category'>) {
        // Only map top-level CSS properties (e.g. css.properties.anchor-name), NOT sub-values (css.properties.width.anchor-size)
        if (bcdKey.startsWith('css.properties.')) {
            const parts = bcdKey.replace('css.properties.', '').split('.');
            const prop = parts[0];
            if (parts.length === 1 && prop && !this.cssPropertyRules.has(prop)) {
                this.cssPropertyRules.set(prop, { ...baseRule, category: 'css' });
            }
            return;
        }

        // Only map top-level CSS selectors (e.g. css.selectors.has)
        if (bcdKey.startsWith('css.selectors.')) {
            const parts = bcdKey.replace('css.selectors.', '').split('.');
            const sel = parts[0];
            if (parts.length === 1 && sel && !this.cssSelectorRules.has(`:${sel}`)) {
                this.cssSelectorRules.set(`:${sel}`, { ...baseRule, category: 'css' });
            }
            return;
        }

        // Map HTML elements (html.elements.dialog) and element-specific attributes
        if (bcdKey.startsWith('html.elements.')) {
            const parts = bcdKey.replace('html.elements.', '').split('.');
            if (parts.length === 1 && !this.htmlTagRules.has(parts[0])) {
                this.htmlTagRules.set(parts[0], { ...baseRule, category: 'html' });
            } else if (parts.length === 2 && parts[1] !== 'content' && !this.htmlAttrRules.has(parts[1])) {
                this.htmlAttrRules.set(parts[1], { ...baseRule, category: 'html' });
            }
            return;
        }

        // Only map top-level global HTML attributes (e.g. html.global_attributes.popover)
        if (bcdKey.startsWith('html.global_attributes.')) {
            const parts = bcdKey.replace('html.global_attributes.', '').split('.');
            const attr = parts[0];
            if (parts.length === 1 && attr && attr !== 'content' && !this.htmlAttrRules.has(attr)) {
                this.htmlAttrRules.set(attr, { ...baseRule, category: 'html' });
            }
            return;
        }

        // Map Web APIs (api.Navigator.share -> navigator.share)
        if (bcdKey.startsWith('api.')) {
            const parts = bcdKey.replace('api.', '').split('.');
            if (parts.length === 2) {
                const [iface, member] = parts;
                const rootMap: Record<string, string> = {
                    Navigator: 'navigator',
                    Document: 'document',
                    Window: 'window',
                    Clipboard: 'navigator.clipboard',
                    Permissions: 'navigator.permissions',
                    ServiceWorkerContainer: 'navigator.serviceWorker',
                    MediaDevices: 'navigator.mediaDevices',
                    Geolocation: 'navigator.geolocation'
                };
                const root = rootMap[iface];
                if (root) {
                    const expr = `${root}.${member}`;
                    if (!this.jsRules.has(expr)) {
                        this.jsRules.set(expr, { ...baseRule, category: 'js-api' });
                    }
                }
            }
        }
    }

    private formatBrowserSupport(status: any): string {
        if (!status?.support) return 'Check MDN compatibility table';
        const s = status.support;
        const parts: string[] = [];
        if (s.chrome) parts.push(`Chrome ${s.chrome}+`);
        if (s.edge) parts.push(`Edge ${s.edge}+`);
        if (s.firefox) parts.push(`Firefox ${s.firefox}+`);
        if (s.safari) parts.push(`Safari ${s.safari}+`);
        return parts.length > 0 ? parts.join(', ') : 'Limited cross-browser support';
    }

    private shouldFlagRule(rule: FeatureRule): boolean {
        if (rule.baseline === 'unsafe' || rule.baseline === false) {
            return true;
        }
        const config = vscode.workspace.getConfiguration('baselineAdvisor');
        const target = config.get<string>('targetBaseline', 'widely');
        if (target === 'widely' && rule.baseline === 'low') {
            return true;
        }
        return false;
    }

    async scanDocument(document: vscode.TextDocument): Promise<APIIssue[]> {
        const text = document.getText();
        const lang = document.languageId;

        try {
            if (['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(lang)) {
                const isTsx = lang === 'typescriptreact' || lang === 'javascriptreact';
                return this.scanScriptText(text, isTsx, 0);
            }
            if (lang === 'html') {
                return this.scanHTML(text);
            }
            if (lang === 'css') {
                return this.scanCSS(text, 0);
            }
        } catch (error) {
            console.error('Baseline Advisor scan error:', error);
        }

        return [];
    }

    private scanScriptText(code: string, isTsx: boolean, baseLineOffset: number): APIIssue[] {
        const issues: APIIssue[] = [];
        const seenRanges = new Set<string>();

        const sourceFile = ts.createSourceFile(
            isTsx ? 'scan.tsx' : 'scan.ts',
            code,
            ts.ScriptTarget.Latest,
            true,
            isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );

        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) {
                const targetNode = ts.isCallExpression(node) ? node.expression : node;
                const exprName = this.extractExpressionName(targetNode);

                if (exprName && this.jsRules.has(exprName)) {
                    const rule = this.jsRules.get(exprName)!;
                    if (this.shouldFlagRule(rule)) {
                        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
                        const rangeKey = `${start.line}:${start.character}`;

                        if (!seenRanges.has(rangeKey)) {
                            seenRanges.add(rangeKey);
                            issues.push({
                                api: exprName,
                                featureName: rule.featureName,
                                line: start.line + 1 + baseLineOffset,
                                column: start.character,
                                endLine: end.line + 1 + baseLineOffset,
                                endColumn: end.character,
                                category: rule.category,
                                type: this.mapIssueType(rule),
                                description: `${rule.featureName} — ${rule.status}`,
                                suggestion: rule.suggestion,
                                browserSupport: rule.browserSupport,
                                status: rule.status,
                                baselineDate: rule.baselineDate,
                                codeSnippet: node.getText(sourceFile)
                            });
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return issues;
    }

    private extractExpressionName(node: ts.Node): string | null {
        if (ts.isIdentifier(node)) {
            return node.text;
        }
        if (ts.isPropertyAccessExpression(node)) {
            const left = this.extractExpressionName(node.expression);
            const right = node.name.text;
            return left ? `${left}.${right}` : right;
        }
        return null;
    }

    private scanHTML(html: string): APIIssue[] {
        const issues: APIIssue[] = [];

        const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
        let tagMatch: RegExpExecArray | null;

        while ((tagMatch = tagRegex.exec(html)) !== null) {
            const fullTag = tagMatch[0];
            const tagName = tagMatch[1].toLowerCase();
            const attrsText = tagMatch[2] || '';
            const before = html.substring(0, tagMatch.index);
            const lineNum = (before.match(/\n/g) || []).length + 1;
            const lastNewline = before.lastIndexOf('\n');
            const colNum = tagMatch.index - (lastNewline === -1 ? 0 : lastNewline + 1);

            const tagRule = this.htmlTagRules.get(tagName);
            if (tagRule && this.shouldFlagRule(tagRule)) {
                issues.push({
                    api: `<${tagName}>`,
                    featureName: tagRule.featureName,
                    line: lineNum,
                    column: colNum,
                    endLine: lineNum,
                    endColumn: colNum + tagName.length + 1,
                    category: 'html',
                    type: this.mapIssueType(tagRule),
                    description: `<${tagName}> (${tagRule.featureName}) — ${tagRule.status}`,
                    suggestion: tagRule.suggestion,
                    browserSupport: tagRule.browserSupport,
                    status: tagRule.status,
                    codeSnippet: fullTag
                });
            }

            const attrRegex = /\b([a-zA-Z-:]+)(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
            let attrMatch: RegExpExecArray | null;
            while ((attrMatch = attrRegex.exec(attrsText)) !== null) {
                const attrName = attrMatch[1].toLowerCase();
                const attrRule = this.htmlAttrRules.get(attrName);
                if (attrRule && this.shouldFlagRule(attrRule)) {
                    const attrCol = colNum + 1 + tagName.length + attrMatch.index;
                    issues.push({
                        api: attrName,
                        featureName: attrRule.featureName,
                        line: lineNum,
                        column: attrCol,
                        endLine: lineNum,
                        endColumn: attrCol + attrName.length,
                        category: 'html',
                        type: this.mapIssueType(attrRule),
                        description: `HTML attribute "${attrName}" (${attrRule.featureName}) — ${attrRule.status}`,
                        suggestion: attrRule.suggestion,
                        browserSupport: attrRule.browserSupport,
                        status: attrRule.status,
                        codeSnippet: fullTag
                    });
                }
            }
        }

        const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
        let scriptMatch: RegExpExecArray | null;
        while ((scriptMatch = scriptRegex.exec(html)) !== null) {
            const scriptContent = scriptMatch[1];
            if (!scriptContent.trim()) continue;
            const beforeScript = html.substring(0, scriptMatch.index);
            const lineOffset = (beforeScript.match(/\n/g) || []).length;
            issues.push(...this.scanScriptText(scriptContent, false, lineOffset));
        }

        const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
        let styleMatch: RegExpExecArray | null;
        while ((styleMatch = styleRegex.exec(html)) !== null) {
            const styleContent = styleMatch[1];
            if (!styleContent.trim()) continue;
            const beforeStyle = html.substring(0, styleMatch.index);
            const lineOffset = (beforeStyle.match(/\n/g) || []).length;
            issues.push(...this.scanCSS(styleContent, lineOffset));
        }

        return issues;
    }

    private scanCSS(css: string, baseLineOffset: number): APIIssue[] {
        const issues: APIIssue[] = [];
        const lines = css.split('\n');

        lines.forEach((lineText, idx) => {
            const trimmed = lineText.trim();
            if (!trimmed || trimmed.startsWith('/*')) return;

            const propMatch = lineText.match(/^\s*([a-z-]+)\s*:\s*([^;]+);?/i);
            if (propMatch) {
                const prop = propMatch[1].toLowerCase();
                const rule = this.cssPropertyRules.get(prop);
                if (rule && this.shouldFlagRule(rule)) {
                    const col = lineText.indexOf(propMatch[1]);
                    issues.push({
                        api: prop,
                        featureName: rule.featureName,
                        line: idx + 1 + baseLineOffset,
                        column: col,
                        endLine: idx + 1 + baseLineOffset,
                        endColumn: col + prop.length,
                        category: 'css',
                        type: this.mapIssueType(rule),
                        description: `CSS property "${prop}" (${rule.featureName}) — ${rule.status}`,
                        suggestion: rule.suggestion,
                        browserSupport: rule.browserSupport,
                        status: rule.status,
                        codeSnippet: trimmed
                    });
                }
            }

            for (const [selector, rule] of this.cssSelectorRules.entries()) {
                const selIdx = lineText.indexOf(selector);
                if (selIdx !== -1 && this.shouldFlagRule(rule)) {
                    issues.push({
                        api: selector,
                        featureName: rule.featureName,
                        line: idx + 1 + baseLineOffset,
                        column: selIdx,
                        endLine: idx + 1 + baseLineOffset,
                        endColumn: selIdx + selector.length,
                        category: 'css',
                        type: this.mapIssueType(rule),
                        description: `CSS selector "${selector}" (${rule.featureName}) — ${rule.status}`,
                        suggestion: rule.suggestion,
                        browserSupport: rule.browserSupport,
                        status: rule.status,
                        codeSnippet: trimmed
                    });
                }
            }
        });

        return issues;
    }

    private mapIssueType(rule: FeatureRule): APIIssue['type'] {
        if (rule.baseline === 'unsafe') return 'unsafe';
        if (rule.baseline === 'low') return 'newly-available';
        if (rule.status.toLowerCase().includes('deprecated')) return 'deprecated';
        return 'non-baseline';
    }

    async getAPIInfo(apiName: string): Promise<APIInfo | null> {
        const rule =
            this.jsRules.get(apiName) ||
            this.cssPropertyRules.get(apiName) ||
            this.cssSelectorRules.get(apiName) ||
            this.htmlTagRules.get(apiName) ||
            this.htmlAttrRules.get(apiName);

        if (rule) {
            const flagged = this.shouldFlagRule(rule);
            return {
                isBaseline: !flagged,
                baselineLevel: rule.baseline === false ? 'false' : rule.baseline,
                featureName: rule.featureName,
                browserSupport: rule.browserSupport,
                status: rule.status,
                suggestion: rule.suggestion,
                baselineDate: rule.baselineDate
            };
        }

        return null;
    }

    async scanWorkspace(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
        diagnosticCollection: vscode.DiagnosticCollection
    ): Promise<{ totalIssues: number; filesWithIssues: number }> {
        const files = await vscode.workspace.findFiles(
            '**/*.{js,jsx,ts,tsx,html,css}',
            '{**/node_modules/**,**/dist/**,**/build/**,**/.next/**}'
        );

        diagnosticCollection.clear();

        let totalIssues = 0;
        let filesWithIssues = 0;

        for (let i = 0; i < files.length; i++) {
            if (token.isCancellationRequested) break;

            const file = files[i];
            progress.report({
                message: `Scanning ${vscode.workspace.asRelativePath(file)}`,
                increment: files.length > 0 ? 100 / files.length : 100
            });

            try {
                const document = await vscode.workspace.openTextDocument(file);
                const issues = await this.scanDocument(document);

                if (issues.length > 0) {
                    totalIssues += issues.length;
                    filesWithIssues++;

                    const diagnostics = issues.map(issue => this.createDiagnostic(issue));
                    diagnosticCollection.set(document.uri, diagnostics);
                }
            } catch (error) {
                console.error(`Error scanning ${file.fsPath}:`, error);
            }
        }

        return { totalIssues, filesWithIssues };
    }

    createDiagnostic(issue: APIIssue): vscode.Diagnostic {
        const range = new vscode.Range(
            new vscode.Position(Math.max(0, issue.line - 1), Math.max(0, issue.column)),
            new vscode.Position(Math.max(0, issue.endLine - 1), Math.max(0, issue.endColumn))
        );

        const severity =
            issue.type === 'unsafe' || issue.type === 'deprecated'
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Information;

        const diagnostic = new vscode.Diagnostic(
            range,
            `${issue.description}. ${issue.suggestion}`,
            severity
        );

        diagnostic.source = 'Baseline Feature Advisor';
        diagnostic.code = issue.api;
        return diagnostic;
    }
}