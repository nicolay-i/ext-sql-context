import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { ConnectionCredentials, CredentialsManager, DatabaseType } from './credentials';
import { DatabaseManager } from './database';
import { credentialsFromEnv, credentialsToEnv } from './envUtils';
import { buildMarkdownContext } from './markdown';
import { getWorkspaceId, pickWorkspaceFolder } from './workspace';

const ISO_PLACEHOLDER = /\$\{ISO_DATE\}/g;

function isoTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveOutputPath(folder: vscode.WorkspaceFolder, pattern: string): string {
    const replaced = pattern.replace(ISO_PLACEHOLDER, isoTimestamp());
    if (path.isAbsolute(replaced)) {
        return replaced;
    }
    return path.join(folder.uri.fsPath, replaced);
}

async function promptForOutputPath(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('ext-sql-context', folder.uri);
    const defaultPattern = config.get<string>('defaultOutputPattern') ?? 'context/context-${ISO_DATE}.md';
    const defaultValue = defaultPattern.replace(ISO_PLACEHOLDER, isoTimestamp());

    const input = await vscode.window.showInputBox({
        prompt: 'Enter the path for the generated Markdown context (absolute or relative to the workspace).',
        value: defaultValue,
        ignoreFocusOut: true
    });

    if (input === undefined) {
        return undefined;
    }

    const trimmed = input.trim();
    const pattern = trimmed.length === 0 ? defaultPattern : trimmed;
    return resolveOutputPath(folder, pattern);
}

async function ensureDirectoryExists(filePath: string): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
}

interface DatabaseTypePick extends vscode.QuickPickItem {
    value: DatabaseType;
}

async function promptDatabaseType(existing?: ConnectionCredentials): Promise<DatabaseType | undefined> {
    const options: DatabaseTypePick[] = [
        { label: 'PostgreSQL', value: 'postgres', picked: existing?.type === 'postgres' },
        { label: 'MySQL', value: 'mysql', picked: existing?.type === 'mysql' },
        { label: 'SQLite', value: 'sqlite', picked: existing?.type === 'sqlite' }
    ];

    const selection = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select the database type'
    });

    return selection?.value;
}

async function promptPort(defaultPort: number, existing?: number): Promise<number | undefined> {
    const value = existing ?? defaultPort;
    const result = await vscode.window.showInputBox({
        prompt: 'Port',
        value: value.toString(),
        ignoreFocusOut: true,
        validateInput: (input) => {
            if (input.trim().length === 0) {
                return undefined;
            }
            return /^\d+$/.test(input.trim()) ? undefined : 'Port must be a number';
        }
    });

    if (result === undefined) {
        return undefined;
    }

    const trimmed = result.trim();
    if (trimmed.length === 0) {
        return value;
    }

    return Number(trimmed);
}

async function promptBooleanQuickPick(
    placeHolder: string,
    existing?: boolean
): Promise<boolean | undefined | null> {
    const options: Array<vscode.QuickPickItem & { value: boolean | undefined }> = [
        { label: 'Do not specify', description: 'Use driver defaults', value: undefined, picked: existing === undefined },
        { label: 'Enable', value: true, picked: existing === true },
        { label: 'Disable', value: false, picked: existing === false }
    ];

    const selection = await vscode.window.showQuickPick(options, { placeHolder });
    if (!selection) {
        return null;
    }

    return selection.value;
}

async function promptSqliteCredentials(existing?: ConnectionCredentials): Promise<ConnectionCredentials | undefined> {
    const manual = await vscode.window.showInputBox({
        prompt: 'Enter the SQLite database file path (leave blank to pick a file).',
        value: existing?.filePath,
        ignoreFocusOut: true
    });

    if (manual === undefined) {
        return undefined;
    }

    let filePath = manual.trim();
    if (!filePath) {
        const selection = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Select SQLite database file'
        });
        if (!selection || selection.length === 0) {
            return undefined;
        }
        filePath = selection[0].fsPath;
    }

    return { type: 'sqlite', filePath };
}

async function promptRelationalCredentials(
    type: Exclude<DatabaseType, 'sqlite'>,
    existing?: ConnectionCredentials
): Promise<ConnectionCredentials | undefined> {
    const host = await vscode.window.showInputBox({
        prompt: 'Host',
        value: existing?.host,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? 'Host is required' : undefined)
    });
    if (host === undefined) {
        return undefined;
    }

    const port = await promptPort(type === 'postgres' ? 5432 : 3306, existing?.port);
    if (port === undefined) {
        return undefined;
    }

    const user = await vscode.window.showInputBox({
        prompt: 'User (optional)',
        value: existing?.user,
        ignoreFocusOut: true
    });
    if (user === undefined) {
        return undefined;
    }

    const passwordInput = await vscode.window.showInputBox({
        prompt: existing?.password ? 'Password (leave empty to keep current value)' : 'Password (optional)',
        password: true,
        ignoreFocusOut: true
    });
    if (passwordInput === undefined) {
        return undefined;
    }

    const database = await vscode.window.showInputBox({
        prompt: 'Database name',
        value: existing?.database,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? 'Database name is required' : undefined)
    });
    if (database === undefined) {
        return undefined;
    }

    let schema: string | undefined;
    if (type === 'postgres') {
        const schemaInput = await vscode.window.showInputBox({
            prompt: 'Schema (optional, leave empty for all user schemas)',
            value: existing?.schema,
            ignoreFocusOut: true
        });
        if (schemaInput === undefined) {
            return undefined;
        }
        schema = schemaInput.trim() || undefined;
    }

    const sslSelection = await promptBooleanQuickPick('Use SSL?', existing?.ssl);
    if (sslSelection === null) {
        return undefined;
    }

    const password = passwordInput === '' ? existing?.password : passwordInput;

    return {
        type,
        host: host.trim(),
        port,
        user: user.trim() || undefined,
        password: password || undefined,
        database: database.trim(),
        schema,
        ssl: sslSelection === undefined ? undefined : sslSelection
    };
}

async function promptCredentials(type: DatabaseType, existing?: ConnectionCredentials): Promise<ConnectionCredentials | undefined> {
    if (type === 'sqlite') {
        return promptSqliteCredentials(existing);
    }
    return promptRelationalCredentials(type, existing);
}

async function configureDatabaseCommand(credentialsManager: CredentialsManager): Promise<void> {
    const folder = await pickWorkspaceFolder();
    if (!folder) {
        return;
    }

    const workspaceId = getWorkspaceId(folder);
    const existing = await credentialsManager.load(workspaceId);
    const type = await promptDatabaseType(existing);
    if (!type) {
        return;
    }

    const credentials = await promptCredentials(type, existing);
    if (!credentials) {
        return;
    }

    await credentialsManager.save(workspaceId, credentials);
    void vscode.window.showInformationMessage(`Database connection saved for workspace "${folder.name}".`);
}

async function openEnvEditor(): Promise<string | undefined> {
    const example = ['DB_TYPE=postgres', 'DB_HOST=localhost', 'DB_PORT=5432', 'DB_USER=user', 'DB_PASSWORD=secret', 'DB_NAME=database'].join('\n');
    const document = await vscode.workspace.openTextDocument({ content: example, language: 'dotenv' });
    await vscode.window.showTextDocument(document, { preview: true });
    const action = await vscode.window.showInformationMessage(
        'Paste or edit the connection settings in the opened editor, then choose Import to continue.',
        { modal: true },
        'Import',
        'Cancel'
    );

    if (action !== 'Import') {
        return undefined;
    }

    return document.getText();
}

async function importFromEnvCommand(credentialsManager: CredentialsManager): Promise<void> {
    const folder = await pickWorkspaceFolder();
    if (!folder) {
        return;
    }

    const workspaceId = getWorkspaceId(folder);
    const importMethod = await vscode.window.showQuickPick(
        [
            { label: 'Paste .env content', value: 'editor' },
            { label: 'Select .env file', value: 'file' }
        ],
        { placeHolder: 'Import database credentials from .env' }
    );

    if (!importMethod) {
        return;
    }

    let content: string | undefined;
    if (importMethod.value === 'editor') {
        content = await openEnvEditor();
    } else {
        const selection = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            openLabel: 'Import',
            filters: { 'Environment files': ['env'], 'All files': ['*'] }
        });
        if (!selection || selection.length === 0) {
            return;
        }
        content = await fs.readFile(selection[0].fsPath, 'utf8');
    }

    if (!content) {
        return;
    }

    const credentials = credentialsFromEnv(content);
    if (!credentials) {
        void vscode.window.showErrorMessage('Unable to parse the provided .env content.');
        return;
    }

    await credentialsManager.save(workspaceId, credentials);
    void vscode.window.showInformationMessage(`Database connection imported for workspace "${folder.name}".`);
}

async function exportToEnvCommand(credentialsManager: CredentialsManager): Promise<void> {
    const folder = await pickWorkspaceFolder();
    if (!folder) {
        return;
    }

    const workspaceId = getWorkspaceId(folder);
    const credentials = await credentialsManager.load(workspaceId);
    if (!credentials) {
        void vscode.window.showErrorMessage('No stored credentials found for this workspace.');
        return;
    }

    const envContent = credentialsToEnv(credentials);
    await vscode.env.clipboard.writeText(envContent);

    const selection = await vscode.window.showInformationMessage(
        'Database credentials were exported to the clipboard in .env format.',
        'Open Preview'
    );

    if (selection === 'Open Preview') {
        const document = await vscode.workspace.openTextDocument({ content: envContent, language: 'dotenv' });
        await vscode.window.showTextDocument(document, { preview: true });
    }
}

async function generateContextCommand(
    credentialsManager: CredentialsManager,
    databaseManager: DatabaseManager
): Promise<void> {
    const folder = await pickWorkspaceFolder();
    if (!folder) {
        return;
    }

    const workspaceId = getWorkspaceId(folder);
    const credentials = await credentialsManager.load(workspaceId);
    if (!credentials) {
        const action = await vscode.window.showInformationMessage(
            'No database connection has been configured for this workspace.',
            'Configure now'
        );
        if (action === 'Configure now') {
            await configureDatabaseCommand(credentialsManager);
        }
        return;
    }

    const outputPath = await promptForOutputPath(folder);
    if (!outputPath) {
        return;
    }

    try {
        const schema = await databaseManager.fetchSchema(credentials);
        const markdown = buildMarkdownContext(credentials, schema);
        await ensureDirectoryExists(outputPath);
        await fs.writeFile(outputPath, markdown, 'utf8');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(outputPath));
        await vscode.window.showTextDocument(document, { preview: false });
        void vscode.window.showInformationMessage(`Database context generated at ${outputPath}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to generate database context: ${message}`);
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const credentialsManager = new CredentialsManager(context);
    const databaseManager = new DatabaseManager();

    context.subscriptions.push(
        vscode.commands.registerCommand('ext-sql-context.configureDatabase', () => configureDatabaseCommand(credentialsManager)),
        vscode.commands.registerCommand('ext-sql-context.importEnv', () => importFromEnvCommand(credentialsManager)),
        vscode.commands.registerCommand('ext-sql-context.exportEnv', () => exportToEnvCommand(credentialsManager)),
        vscode.commands.registerCommand('ext-sql-context.generateContext', () =>
            generateContextCommand(credentialsManager, databaseManager)
        )
    );
}

export function deactivate(): void {
    // Nothing to clean up.
}
