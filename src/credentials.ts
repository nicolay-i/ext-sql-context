import * as vscode from 'vscode';

export type DatabaseType = 'mysql' | 'postgres' | 'sqlite';

export interface ConnectionCredentials {
    type: DatabaseType;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    schema?: string;
    ssl?: boolean;
    filePath?: string;
}

const SECRET_PREFIX = 'extSqlContext.credentials:';

export class CredentialsManager {
    constructor(private readonly context: vscode.ExtensionContext) {}

    private getSecretKey(workspaceId: string): string {
        return `${SECRET_PREFIX}${workspaceId}`;
    }

    async load(workspaceId: string): Promise<ConnectionCredentials | undefined> {
        const raw = await this.context.secrets.get(this.getSecretKey(workspaceId));
        if (!raw) {
            return undefined;
        }

        try {
            const parsed = JSON.parse(raw) as ConnectionCredentials;
            return parsed;
        } catch (error) {
            console.error('Failed to parse stored credentials', error);
            return undefined;
        }
    }

    async save(workspaceId: string, credentials: ConnectionCredentials): Promise<void> {
        await this.context.secrets.store(this.getSecretKey(workspaceId), JSON.stringify(credentials));
    }

    async clear(workspaceId: string): Promise<void> {
        await this.context.secrets.delete(this.getSecretKey(workspaceId));
    }
}
