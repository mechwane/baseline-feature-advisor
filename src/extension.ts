import * as vscode from 'vscode';
import { BaselineScanner, APIIssue } from './scanner';
import { AIAdvisor } from './aiAdvisor';

const SUPPORTED_LANGUAGES = [
    'javascript',
    'javascriptreact',
    'typescript',
    'typescriptreact',
    'html',
    'css'
];

let scanner: BaselineScanner;
let aiAdvisor: AIAdvisor;
let statusBarItem: vscode.StatusBarItem;
let scanTimeout: NodeJS.Timeout | undefined;

const diagnosticCollection = vscode.languages.createDiagnosticCollection('baselineAdvisor');
const issueCache = new Map<string, APIIssue[]>();

export function activate(context: vscode.ExtensionContext) {
    scanner = new BaselineScanner();
    aiAdvisor = new AIAdvisor();

    // 1. Status Bar Badge
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'baselineAdvisor.scanFile';
    statusBarItem.tooltip = 'Click to scan active file for non-Baseline web features';
    statusBarItem.text = '$(shield) Baseline';
    statusBarItem.show();

    // 2. Command: Scan Active File
    const scanFileCommand = vscode.commands.registerCommand('baselineAdvisor.scanFile', async () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showWarningMessage('No active file to scan.');
            return;
        }

        const document = activeEditor.document;
        const issues = await runDocumentScan(document);

        if (issues.length === 0) {
            vscode.window.showInformationMessage('✅ All detected web features in this file are Baseline-compliant!');
        } else {
            vscode.window.showWarningMessage(
                `⚠️ Found ${issues.length} non-Baseline or unsafe feature(s). Hover or press Ctrl+. for AI fixes.`
            );
        }
    });

    // 3. Command: Scan Entire Workspace
    const scanWorkspaceCommand = vscode.commands.registerCommand('baselineAdvisor.scanWorkspace', async () => {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Baseline Advisor: Scanning workspace...',
                cancellable: true
            },
            async (progress, token) => {
                issueCache.clear();
                const results = await scanner.scanWorkspace(progress, token, diagnosticCollection);

                if (results.totalIssues === 0) {
                    vscode.window.showInformationMessage('✅ Workspace is Baseline-compliant!');
                } else {
                    vscode.window.showWarningMessage(
                        `⚠️ Found ${results.totalIssues} issue(s) across ${results.filesWithIssues} file(s). Check the Problems panel.`
                    );
                }
            }
        );
    });

    // 4. Command: Apply AI Fix for a specific issue
    const askAIForFixCommand = vscode.commands.registerCommand(
        'baselineAdvisor.askAIForFix',
        async (uri: vscode.Uri, issue: APIIssue) => {
            const document = await vscode.workspace.openTextDocument(uri);
            const range = new vscode.Range(
                new vscode.Position(Math.max(0, issue.line - 1), Math.max(0, issue.column)),
                new vscode.Position(Math.max(0, issue.endLine - 1), Math.max(0, issue.endColumn))
            );

            const snippet = issue.codeSnippet || document.getText(range);
            const surrounding = getSurroundingContext(document, issue.line - 1);

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Generating AI Baseline replacement for ${issue.api}...`,
                    cancellable: true
                },
                async (_progress, token) => {
                    const suggestion = await aiAdvisor.getSuggestion(
                        issue.api,
                        snippet,
                        surrounding,
                        document.languageId,
                        token
                    );

                    if (!suggestion.replacementCode || suggestion.replacementCode === snippet) {
                        vscode.window.showInformationMessage(
                            `${suggestion.alternative}: ${suggestion.explanation}`
                        );
                        return;
                    }

                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(uri, range, suggestion.replacementCode);
                    const applied = await vscode.workspace.applyEdit(edit);

                    if (applied) {
                        vscode.window.showInformationMessage(
                            `✅ Replaced with ${suggestion.alternative} (${suggestion.providerUsed})`
                        );
                        await runDocumentScan(document);
                    }
                }
            );
        }
    );

    // 5. Real-Time Scanning on Open, Save, and Typing
    const onDidOpenTextDocument = vscode.workspace.onDidOpenTextDocument(async (document) => {
        if (isRelevantDocument(document)) {
            await runDocumentScan(document);
        }
    });

    const onDidChangeActiveEditor = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor && isRelevantDocument(editor.document)) {
            await runDocumentScan(editor.document);
        } else {
            statusBarItem.text = '$(shield) Baseline';
        }
    });

    const onDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument((event) => {
        const config = vscode.workspace.getConfiguration('baselineAdvisor');
        if (!config.get<boolean>('enableRealTimeScanning', true)) return;

        const document = event.document;
        if (!isRelevantDocument(document)) return;

        if (scanTimeout) clearTimeout(scanTimeout);
        scanTimeout = setTimeout(async () => {
            await runDocumentScan(document);
        }, 650);
    });

    const onDidChangeConfig = vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('baselineAdvisor')) {
            aiAdvisor.clearCache();
            if (vscode.window.activeTextEditor && isRelevantDocument(vscode.window.activeTextEditor.document)) {
                await runDocumentScan(vscode.window.activeTextEditor.document);
            }
        }
    });

    // 6. Rich AI Hover Provider
    const hoverProvider = vscode.languages.registerHoverProvider(SUPPORTED_LANGUAGES, {
        async provideHover(document, position, token) {
            const issues = issueCache.get(document.uri.toString()) || [];
            const matchedIssue = issues.find((issue) => {
                const range = new vscode.Range(
                    new vscode.Position(Math.max(0, issue.line - 1), Math.max(0, issue.column)),
                    new vscode.Position(Math.max(0, issue.endLine - 1), Math.max(0, issue.endColumn))
                );
                return range.contains(position);
            });

            if (!matchedIssue) return null;

            const snippet = matchedIssue.codeSnippet || matchedIssue.api;
            const surrounding = getSurroundingContext(document, matchedIssue.line - 1);
            const aiSuggestion = await aiAdvisor.getSuggestion(
                matchedIssue.api,
                snippet,
                surrounding,
                document.languageId,
                token
            );

            const md = new vscode.MarkdownString();
            md.isTrusted = true;

            const badge =
                matchedIssue.type === 'unsafe' ? '🚨 Unsafe / Security Risk' :
                matchedIssue.type === 'deprecated' ? '⚠️ Deprecated API' :
                matchedIssue.type === 'newly-available' ? '🆕 Baseline Newly Available' :
                '⚠️ Not Baseline-Supported';

            md.appendMarkdown(`### ${badge}: \`${matchedIssue.api}\`\n\n`);
            md.appendMarkdown(`**Feature:** ${matchedIssue.featureName}\n\n`);
            md.appendMarkdown(`**Status:** ${matchedIssue.status}\n\n`);
            md.appendMarkdown(`**Browser Support:** ${matchedIssue.browserSupport}\n\n`);
            md.appendMarkdown(`---\n\n`);
            md.appendMarkdown(`**💡 Recommended Alternative (${aiSuggestion.providerUsed}):** ${aiSuggestion.alternative}\n\n`);
            md.appendMarkdown(`${aiSuggestion.explanation}\n\n`);

            if (aiSuggestion.codeExample) {
                md.appendCodeblock(aiSuggestion.codeExample, document.languageId);
            }

            const args = encodeURIComponent(JSON.stringify([document.uri, matchedIssue]));
            md.appendMarkdown(`\n[✨ Apply AI Baseline Fix](command:baselineAdvisor.askAIForFix?${args})`);

            return new vscode.Hover(md);
        }
    });

    // 7. Lightbulb Quick Fix Provider (Ctrl + .)
    const codeActionProvider = vscode.languages.registerCodeActionsProvider(
        SUPPORTED_LANGUAGES,
        {
            provideCodeActions(document, range) {
                const issues = issueCache.get(document.uri.toString()) || [];
                const actions: vscode.CodeAction[] = [];

                for (const issue of issues) {
                    const issueRange = new vscode.Range(
                        new vscode.Position(Math.max(0, issue.line - 1), Math.max(0, issue.column)),
                        new vscode.Position(Math.max(0, issue.endLine - 1), Math.max(0, issue.endColumn))
                    );

                    if (!issueRange.intersection(range)) continue;

                    // Action 1: Instant Built-in Quick Fix (if deterministic replacement exists)
                    const snippet = issue.codeSnippet || document.getText(issueRange);
                    const instantFix = aiAdvisor.getFallbackSuggestion(issue.api, snippet);
                    if (instantFix.replacementCode && instantFix.replacementCode !== snippet) {
                        const quickFix = new vscode.CodeAction(
                            `Baseline Fix: Replace with ${instantFix.alternative}`,
                            vscode.CodeActionKind.QuickFix
                        );
                        quickFix.edit = new vscode.WorkspaceEdit();
                        quickFix.edit.replace(document.uri, issueRange, instantFix.replacementCode);
                        quickFix.isPreferred = true;
                        actions.push(quickFix);
                    }

                    // Action 2: Live AI-Powered Context Fix
                    const aiFix = new vscode.CodeAction(
                        `✨ AI Baseline Fix for ${issue.api}`,
                        vscode.CodeActionKind.QuickFix
                    );
                    aiFix.command = {
                        command: 'baselineAdvisor.askAIForFix',
                        title: 'Get AI Baseline Fix',
                        arguments: [document.uri, issue]
                    };
                    actions.push(aiFix);
                }

                return actions;
            }
        },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    );

    context.subscriptions.push(
        statusBarItem,
        diagnosticCollection,
        scanFileCommand,
        scanWorkspaceCommand,
        askAIForFixCommand,
        onDidOpenTextDocument,
        onDidChangeActiveEditor,
        onDidChangeTextDocument,
        onDidChangeConfig,
        hoverProvider,
        codeActionProvider
    );

    // Scan currently active document on startup
    if (vscode.window.activeTextEditor && isRelevantDocument(vscode.window.activeTextEditor.document)) {
        runDocumentScan(vscode.window.activeTextEditor.document);
    }
}

async function runDocumentScan(document: vscode.TextDocument): Promise<APIIssue[]> {
    const issues = await scanner.scanDocument(document);
    issueCache.set(document.uri.toString(), issues);

    if (issues.length === 0) {
        diagnosticCollection.delete(document.uri);
        if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
            statusBarItem.text = '$(check) Baseline: OK';
        }
    } else {
        const diagnostics = issues.map((issue) => scanner.createDiagnostic(issue));
        diagnosticCollection.set(document.uri, diagnostics);
        if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
            statusBarItem.text = `$(warning) Baseline: ${issues.length} issue${issues.length > 1 ? 's' : ''}`;
        }
    }

    return issues;
}

function getSurroundingContext(document: vscode.TextDocument, zeroBasedLine: number): string {
    const startLine = Math.max(0, zeroBasedLine - 5);
    const endLine = Math.min(document.lineCount - 1, zeroBasedLine + 5);
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    return document.getText(range);
}

function isRelevantDocument(document: vscode.TextDocument): boolean {
    return SUPPORTED_LANGUAGES.includes(document.languageId);
}

export function deactivate() {
    if (scanTimeout) clearTimeout(scanTimeout);
    diagnosticCollection.dispose();
}