import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { DatabaseContextGenerator } from './contextGenerator';
import { ConnectionConfig } from './types';
import { SettingsWebview } from './settingsWebview';

export function activate(context: vscode.ExtensionContext): void {
  const connectionManager = new ConnectionManager(context);
  const settingsWebview = new SettingsWebview(context, connectionManager);

  context.subscriptions.push(
    vscode.commands.registerCommand('sql-context.openSettings', async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder to manage SQL Context settings.');
        return;
      }
      settingsWebview.show(folder);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sql-context.configureConnection', async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder to manage SQL Context settings.');
        return;
      }
      settingsWebview.show(folder);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sql-context.generateContext', async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder before generating context.');
        return;
      }

      let connection = await connectionManager.getConnection(folder);
      if (!connection) {
        const configure = await vscode.window.showInformationMessage(
          'No database connection is configured for this workspace.',
          'Configure Now'
        );
        if (configure === 'Configure Now') {
          connection = await configureConnection(folder, connectionManager);
        } else {
          return;
        }
      }

      if (!connection) {
        return;
      }

      const targetUri = await promptForOutputUri(folder);
      if (!targetUri) {
        return;
      }

      try {
        const generator = new DatabaseContextGenerator(connection);
        const markdown = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Generating database context...',
            cancellable: false
          },
          async () => generator.generateMarkdown()
        );

        await ensureDirectory(path.dirname(targetUri.fsPath));
        await fs.writeFile(targetUri.fsPath, markdown, 'utf8');

        const action = await vscode.window.showInformationMessage(
          `Database context saved to ${targetUri.fsPath}`,
          'Open File'
        );
        if (action === 'Open File') {
          const document = await vscode.workspace.openTextDocument(targetUri);
          await vscode.window.showTextDocument(document);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to generate context: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sql-context.importConnectionFromEnv', async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder before importing connection data.');
        return;
      }

      const content = await promptForEnvContent();
      if (!content) {
        return;
      }

      try {
        const config = await connectionManager.importFromEnv(folder, content);
        vscode.window.showInformationMessage(
          `Imported ${config.provider} connection for workspace ${folder.name}.`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to import .env data: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sql-context.exportConnectionToEnv', async () => {
      const folder = await pickWorkspaceFolder();
      if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder before exporting connection data.');
        return;
      }

      const envString = await connectionManager.exportToEnv(folder);
      if (!envString) {
        vscode.window.showWarningMessage('No connection configured for this workspace.');
        return;
      }

      await vscode.env.clipboard.writeText(envString);
      const action = await vscode.window.showInformationMessage(
        'Connection data copied to the clipboard.',
        'Open Preview'
      );
      if (action === 'Open Preview') {
        const document = await vscode.workspace.openTextDocument({ language: 'dotenv', content: envString });
        await vscode.window.showTextDocument(document, { preview: true });
      }
    })
  );
}

export function deactivate(): void {
  // no-op
}

async function configureConnection(
  folder: vscode.WorkspaceFolder,
  manager: ConnectionManager,
  existing?: ConnectionConfig
): Promise<ConnectionConfig | undefined> {
  type ProviderOption = vscode.QuickPickItem & { value: ConnectionConfig['provider'] };
  const provider = await vscode.window.showQuickPick<ProviderOption>(
    [
      { label: 'PostgreSQL', value: 'postgres' },
      { label: 'MySQL', value: 'mysql' },
      { label: 'SQLite', value: 'sqlite' }
    ],
    {
      title: `Configure database for ${folder.name}`,
      placeHolder: 'Select database provider',
      canPickMany: false,
      ignoreFocusOut: true
    }
  );

  if (!provider) {
    return undefined;
  }

  let config: ConnectionConfig | undefined;
  switch (provider.value) {
    case 'postgres':
      config = await promptForSqlConnection('postgres', existing);
      break;
    case 'mysql':
      config = await promptForSqlConnection('mysql', existing);
      break;
    case 'sqlite':
      config = await promptForSqliteConnection(folder, existing);
      break;
    default:
      config = undefined;
  }

  if (!config) {
    return undefined;
  }

  await manager.saveConnection(folder, config);
  vscode.window.showInformationMessage(`Connection saved for workspace ${folder.name}.`);
  return config;
}

async function promptForSqlConnection(
  provider: 'postgres' | 'mysql',
  existing?: ConnectionConfig
): Promise<ConnectionConfig | undefined> {
  const defaults = getProviderDefaults(provider);
  const host = await vscode.window.showInputBox({
    prompt: 'Host name',
    value: existing?.host ?? defaults.host,
    ignoreFocusOut: true
  });
  if (!host) {
    return undefined;
  }

  const portInput = await vscode.window.showInputBox({
    prompt: 'Port',
    value: String(existing?.port ?? defaults.port),
    ignoreFocusOut: true,
    validateInput: (value) => (value && !/^[0-9]+$/.test(value) ? 'Port must be a number' : undefined)
  });
  if (!portInput) {
    return undefined;
  }

  const database = await vscode.window.showInputBox({
    prompt: 'Database name',
    value: existing?.database,
    ignoreFocusOut: true
  });
  if (!database) {
    return undefined;
  }

  const user = await vscode.window.showInputBox({
    prompt: 'User name',
    value: existing?.user,
    ignoreFocusOut: true
  });
  if (!user) {
    return undefined;
  }

  const password = await vscode.window.showInputBox({
    prompt: existing?.password ? 'Password (leave empty to keep current)' : 'Password',
    value: '',
    password: true,
    ignoreFocusOut: true
  });
  if (password === undefined) {
    return undefined;
  }

  const sslChoice = await vscode.window.showQuickPick(
    [
      { label: 'No', value: false, picked: !existing?.ssl },
      { label: 'Yes', value: true, picked: existing?.ssl === true }
    ],
    {
      placeHolder: 'Use SSL connection?',
      canPickMany: false,
      ignoreFocusOut: true
    }
  );

  const config: ConnectionConfig = {
    provider,
    host,
    port: Number(portInput),
    database,
    user,
    password: password.length > 0 ? password : existing?.password,
    ssl: sslChoice?.value ?? existing?.ssl ?? false
  };

  return config;
}

async function promptForSqliteConnection(
  folder: vscode.WorkspaceFolder,
  existing?: ConnectionConfig
): Promise<ConnectionConfig | undefined> {
  type SqliteMode = vscode.QuickPickItem & { value: 'browse' | 'manual' };
  const mode = await vscode.window.showQuickPick<SqliteMode>(
    [
      { label: 'Browse for file', value: 'browse' },
      { label: 'Enter path manually', value: 'manual' }
    ],
    {
      placeHolder: 'How do you want to select the SQLite database file?',
      canPickMany: false,
      ignoreFocusOut: true
    }
  );

  if (!mode) {
    return undefined;
  }

  let filePath: string | undefined;
  if (mode.value === 'browse') {
    const defaultUri = existing?.filePath ? vscode.Uri.file(existing.filePath) : folder.uri;
    const fileResult = await vscode.window.showOpenDialog({
      title: 'Select SQLite database file',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri
    });
    if (fileResult && fileResult.length > 0) {
      filePath = fileResult[0].fsPath;
    }
  } else {
    filePath = await vscode.window.showInputBox({
      prompt: 'SQLite database file path',
      value: existing?.filePath ?? path.join(folder.uri.fsPath, 'database.sqlite'),
      ignoreFocusOut: true
    });
  }

  if (!filePath) {
    return undefined;
  }

  return {
    provider: 'sqlite',
    filePath
  };
}

function getProviderDefaults(provider: 'postgres' | 'mysql'): { host: string; port: number } {
  if (provider === 'postgres') {
    return { host: 'localhost', port: 5432 };
  }
  return { host: 'localhost', port: 3306 };
}

async function promptForOutputUri(folder: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
  const configuration = vscode.workspace.getConfiguration('sql-context', folder.uri);
  const template = configuration.get<string>('outputPathTemplate') ?? 'context/context-${isoDate}.md';
  const iso = new Date().toISOString();
  const safeIso = iso.replace(/[:]/g, '-').replace(/\./g, '-');
  const defaultRelative = applyTemplate(template, safeIso, folder);

  const input = await vscode.window.showInputBox({
    title: 'Context file path',
    prompt: 'Enter a relative or absolute path for the context markdown file.',
    value: defaultRelative,
    ignoreFocusOut: true
  });

  if (!input) {
    return undefined;
  }

  const resolvedPath = applyTemplate(input, safeIso, folder);
  const absolutePath = path.isAbsolute(resolvedPath)
    ? resolvedPath
    : path.join(folder.uri.fsPath, resolvedPath);

  await ensureDirectory(path.dirname(absolutePath));
  return vscode.Uri.file(absolutePath);
}

function applyTemplate(template: string, iso: string, folder: vscode.WorkspaceFolder): string {
  const replacements: Record<string, string> = {
    '${isoDate}': iso,
    '${date}': iso,
    '{{isoDate}}': iso,
    '{{date}}': iso,
    '${workspaceFolder}': folder.uri.fsPath,
    '${workspaceName}': folder.name
  };
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  if (folders.length === 1) {
    return folders[0];
  }

  const selection = await vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select a workspace folder',
    ignoreFocusOut: true
  });
  return selection ?? undefined;
}

async function promptForEnvContent(): Promise<string | undefined> {
  const method = await vscode.window.showQuickPick(
    [
      { label: 'Paste .env content', value: 'paste' },
      { label: 'Read from clipboard', value: 'clipboard' },
      { label: 'Select .env file', value: 'file' }
    ],
    {
      placeHolder: 'Choose how to provide .env data for the database connection',
      canPickMany: false,
      ignoreFocusOut: true
    }
  );

  if (!method) {
    return undefined;
  }

  switch (method.value) {
    case 'clipboard': {
      const clipboard = await vscode.env.clipboard.readText();
      if (!clipboard.trim()) {
        vscode.window.showWarningMessage('Clipboard does not contain any text to import.');
        return undefined;
      }
      return clipboard;
    }
    case 'file': {
      const uri = await vscode.window.showOpenDialog({
        title: 'Select .env file',
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'Env files': ['env'], 'All files': ['*'] }
      });
      if (!uri || uri.length === 0) {
        return undefined;
      }
      try {
        const buffer = await fs.readFile(uri[0].fsPath);
        return buffer.toString('utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to read file: ${message}`);
        return undefined;
      }
    }
    case 'paste':
    default:
      return promptEnvInputEditor();
  }
}

async function promptEnvInputEditor(): Promise<string | undefined> {
  const document = await vscode.workspace.openTextDocument({ language: 'dotenv', content: '' });
  await vscode.window.showTextDocument(document);
  const response = await vscode.window.showInformationMessage(
    'Paste the .env connection settings into the untitled editor. Select "Use Content" when you are ready to import.',
    { modal: true },
    'Use Content'
  );

  let content: string | undefined;
  if (response === 'Use Content') {
    content = document.getText();
    if (!content.trim()) {
      vscode.window.showWarningMessage('No content detected in the editor.');
      content = undefined;
    }
  }

  // Close the temporary editor to avoid leaving stray buffers open.
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  return content;
}
