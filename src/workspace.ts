import * as vscode from 'vscode';

export async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        void vscode.window.showErrorMessage('No workspace is currently opened. Open a folder or workspace first.');
        return undefined;
    }

    if (folders.length === 1) {
        return folders[0];
    }

    const selection = await vscode.window.showQuickPick(
        folders.map((folder) => ({
            label: folder.name,
            description: folder.uri.fsPath,
            folder
        })),
        {
            placeHolder: 'Select a workspace folder for the SQL context operation'
        }
    );

    return selection?.folder;
}

export function getWorkspaceId(folder: vscode.WorkspaceFolder): string {
    return folder.uri.toString();
}
