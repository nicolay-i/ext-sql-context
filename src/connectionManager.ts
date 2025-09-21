import * as vscode from 'vscode';
import { connectionFromEnv, connectionToEnv } from './envUtils';
import { ConnectionConfig } from './types';

const SECRET_PREFIX = 'sql-context.connection:';

interface StoredConnectionPayload {
  version: number;
  config: ConnectionConfig;
}

export class ConnectionManager {
  private cache = new Map<string, ConnectionConfig>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getSecretKey(folder: vscode.WorkspaceFolder): string {
    return `${SECRET_PREFIX}${folder.uri.toString()}`;
  }

  async getConnection(folder: vscode.WorkspaceFolder): Promise<ConnectionConfig | undefined> {
    const key = this.getSecretKey(folder);
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    const raw = await this.context.secrets.get(key);
    if (!raw) {
      return undefined;
    }

    try {
      const payload = JSON.parse(raw) as StoredConnectionPayload;
      if (payload && payload.version === 1 && payload.config) {
        this.cache.set(key, payload.config);
        return payload.config;
      }
    } catch (error) {
      console.error('Failed to parse stored connection', error);
    }

    return undefined;
  }

  async saveConnection(folder: vscode.WorkspaceFolder, config: ConnectionConfig): Promise<void> {
    const key = this.getSecretKey(folder);
    const payload: StoredConnectionPayload = { version: 1, config };
    await this.context.secrets.store(key, JSON.stringify(payload));
    this.cache.set(key, config);
  }

  async removeConnection(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = this.getSecretKey(folder);
    await this.context.secrets.delete(key);
    this.cache.delete(key);
  }

  async importFromEnv(folder: vscode.WorkspaceFolder, content: string): Promise<ConnectionConfig> {
    const payload = connectionFromEnv(content);
    await this.saveConnection(folder, payload.config);
    return payload.config;
  }

  async exportToEnv(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const connection = await this.getConnection(folder);
    if (!connection) {
      return undefined;
    }
    return connectionToEnv(connection);
  }
}
