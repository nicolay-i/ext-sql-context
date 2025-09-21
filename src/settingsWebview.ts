import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ConnectionManager } from './connectionManager';
import { ConnectionConfig } from './types';
import { testConnection } from './contextGenerator';

type InMessage =
  | { type: 'ready' }
  | { type: 'save'; config: ConnectionConfig }
  | { type: 'delete' }
  | { type: 'importEnv'; source: 'clipboard' | 'file' | 'paste'; content?: string }
  | { type: 'exportEnv' }
  | { type: 'pickSqliteFile' }
  | { type: 'saveGeneration'; outputPathTemplate: string }
  | { type: 'testConnection'; config: ConnectionConfig }
  | { type: 'startGeneration' };

type OutMessage =
  | { type: 'state'; connection?: ConnectionConfig; workspaceName: string; outputPathTemplate: string; outputPathPreview: string }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'exportResult'; env?: string }
  | { type: 'pickedSqliteFile'; filePath?: string };

export class SettingsWebview {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager
  ) {}

  async show(folder: vscode.WorkspaceFolder): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'sqlContextSettings',
      `SQL Context Settings — ${folder.name}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = await this.getHtml(panel);

    const post = (msg: OutMessage) => panel.webview.postMessage(msg);

    const sendState = async () => {
      const conn = await this.connectionManager.getConnection(folder);
      const { template, preview } = await this.getGenerationSettings(folder);
      post({ type: 'state', connection: conn, workspaceName: folder.name, outputPathTemplate: template, outputPathPreview: preview });
    };

    const disposables: vscode.Disposable[] = [];

    disposables.push(
      panel.webview.onDidReceiveMessage(async (msg: InMessage) => {
        try {
          switch (msg.type) {
            case 'ready': {
              await sendState();
              break;
            }
            case 'save': {
              const existing = await this.connectionManager.getConnection(folder);
              const next: ConnectionConfig = { ...msg.config } as ConnectionConfig;
              if (next.provider !== 'sqlite') {
                if (!next.password && existing && existing.provider !== 'sqlite') {
                  next.password = existing.password;
                }
              }
              await this.connectionManager.saveConnection(folder, next);
              post({ type: 'info', message: 'Connection settings saved.' });
              await sendState();
              break;
            }
            case 'delete': {
              await this.connectionManager.removeConnection(folder);
              post({ type: 'info', message: 'Connection deleted.' });
              await sendState();
              break;
            }
            case 'importEnv': {
              if (msg.source === 'paste' && msg.content) {
                const cfg = await this.connectionManager.importFromEnv(folder, msg.content);
                post({ type: 'info', message: `Connection imported (${cfg.provider}).` });
                await sendState();
                break;
              }
              if (msg.source === 'clipboard') {
                const content = await vscode.env.clipboard.readText();
                if (!content.trim()) {
                  post({ type: 'error', message: 'Clipboard is empty.' });
                } else {
                  const cfg = await this.connectionManager.importFromEnv(folder, content);
                  post({ type: 'info', message: `Connection imported (${cfg.provider}).` });
                }
                await sendState();
                break;
              }
              if (msg.source === 'file') {
                const uri = await vscode.window.showOpenDialog({
                  title: 'Select .env file',
                  canSelectFiles: true,
                  canSelectFolders: false,
                  canSelectMany: false,
                  filters: { 'Env files': ['env'], 'All files': ['*'] }
                });
                if (!uri || uri.length === 0) {
                  break;
                }
                const buffer = await vscode.workspace.fs.readFile(uri[0]);
                const content = Buffer.from(buffer).toString('utf8');
                const cfg = await this.connectionManager.importFromEnv(folder, content);
                post({ type: 'info', message: `Connection imported (${cfg.provider}).` });
                await sendState();
                break;
              }
              break;
            }
            case 'exportEnv': {
              const env = await this.connectionManager.exportToEnv(folder);
              if (!env) {
                post({ type: 'error', message: 'Connection not configured.' });
              } else {
                await vscode.env.clipboard.writeText(env);
                post({ type: 'info', message: 'Exported to .env and copied to clipboard.' });
                void vscode.window.showInformationMessage('.env content copied to clipboard.');
              }
              post({ type: 'exportResult', env: env ?? undefined });
              break;
            }
            case 'pickSqliteFile': {
              const uri = await vscode.window.showOpenDialog({
                title: 'Select SQLite database file',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
              });
              const filePath = uri && uri.length > 0 ? uri[0].fsPath : undefined;
              post({ type: 'pickedSqliteFile', filePath });
              break;
            }
            case 'saveGeneration': {
              const config = vscode.workspace.getConfiguration('sql-context', folder.uri);
              await config.update('outputPathTemplate', msg.outputPathTemplate, vscode.ConfigurationTarget.WorkspaceFolder);
              void vscode.window.showInformationMessage('Context file path template saved.');
              await sendState();
              break;
            }
            case 'startGeneration': {
              await vscode.commands.executeCommand('sql-context.generateContext', folder);
              break;
            }
            case 'testConnection': {
              await testConnection(msg.config);
              post({ type: 'info', message: 'Connection successful.' });
              break;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          post({ type: 'error', message });
        }
      })
    );

    panel.onDidDispose(() => disposables.forEach(d => d.dispose()));

    // initial state request
    await sendState();
  }
  
  private async getHtml(panel: vscode.WebviewPanel): Promise<string> {
    const mediaPath = vscode.Uri.file(path.join(this.context.extensionPath, 'media'));
    const htmlUri = vscode.Uri.joinPath(mediaPath, 'settings.html');
    const buffer = await fs.readFile(htmlUri.fsPath);
    const raw = buffer.toString('utf8');

    const nonce = String(Date.now());
    const csp = [
      `default-src 'none'`,
      `img-src ${panel.webview.cspSource} blob: data:`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return raw
      .replace(/\{\{csp\}\}/g, csp)
      .replace(/\{\{nonce\}\}/g, nonce);
  }

  private async getGenerationSettings(folder: vscode.WorkspaceFolder): Promise<{ template: string; preview: string }> {
    const config = vscode.workspace.getConfiguration('sql-context', folder.uri);
    const template = config.get<string>('outputPathTemplate') ?? 'context/context-${isoDate}.md';
    const iso = new Date().toISOString();
    const safeIso = iso.replace(/[:]/g, '-').replace(/\./g, '-');
    const preview = this.applyTemplate(template, safeIso, folder);
    return { template, preview };
  }

  private applyTemplate(template: string, iso: string, folder: vscode.WorkspaceFolder): string {
    const replacements: Record<string, string> = {
      '${isoDate}': iso,
      '${date}': iso,
      '{{isoDate}}': iso,
      '{{date}}': iso,
      '${workspaceFolder}': folder.uri.fsPath,
      '${workspaceName}': folder.name
    };
    let result = template;
    for (const [ph, val] of Object.entries(replacements)) {
      result = result.split(ph).join(val);
    }
    return result;
  }
}
