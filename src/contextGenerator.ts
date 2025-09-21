import * as path from 'path';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { ConnectionConfig, DatabaseSchema, TableColumn, TableInfo } from './types';

export class DatabaseContextGenerator {
  constructor(private readonly config: ConnectionConfig) {}

  async loadSchema(): Promise<DatabaseSchema> {
    switch (this.config.provider) {
      case 'postgres':
        return this.loadPostgresSchema();
      case 'mysql':
        return this.loadMySqlSchema();
      case 'sqlite':
        return this.loadSqliteSchema();
      default:
        throw new Error(`Unsupported provider: ${this.config.provider}`);
    }
  }

  async generateMarkdown(): Promise<string> {
    const schema = await this.loadSchema();
    return renderMarkdown(schema);
  }

  private async loadPostgresSchema(): Promise<DatabaseSchema> {
    const client = new PgClient({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.config.ssl
    });

    await client.connect();

    try {
      const tableResult = await client.query<{
        table_schema: string;
        table_name: string;
        table_type: string;
      }>(
        `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name`
      );

      const columnResult = await client.query<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
      }>(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_schema, table_name, ordinal_position`
      );

      const columnsMap = new Map<string, TableColumn[]>();
      for (const row of columnResult.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        const column: TableColumn = {
          name: row.column_name,
          dataType: row.data_type,
          isNullable: row.is_nullable === 'YES',
          defaultValue: row.column_default
        };
        const existing = columnsMap.get(key) ?? [];
        existing.push(column);
        columnsMap.set(key, existing);
      }

      const tables: TableInfo[] = tableResult.rows.map((row): TableInfo => {
        const key = `${row.table_schema}.${row.table_name}`;
        return {
          name: row.table_name,
          schema: row.table_schema,
          type: row.table_type === 'VIEW' ? 'view' : 'table',
          columns: columnsMap.get(key) ?? []
        };
      });

      return {
        provider: 'postgres',
        database: this.config.database,
        tables
      };
    } finally {
      await client.end();
    }
  }

  private async loadMySqlSchema(): Promise<DatabaseSchema> {
    const connection = await mysql.createConnection({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined
    });

    try {
      const [tableRows] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME, TABLE_TYPE
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME`,
        [this.config.database]
      );

      const [columnRows] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [this.config.database]
      );

      const columnsMap = new Map<string, TableColumn[]>();
      for (const row of columnRows) {
        const key = row.TABLE_NAME as string;
        const column: TableColumn = {
          name: row.COLUMN_NAME as string,
          dataType: row.COLUMN_TYPE as string,
          isNullable: (row.IS_NULLABLE as string) === 'YES',
          defaultValue: (row.COLUMN_DEFAULT as string | null) ?? null
        };
        const existing = columnsMap.get(key) ?? [];
        existing.push(column);
        columnsMap.set(key, existing);
      }

      const tables: TableInfo[] = tableRows.map((row) => {
        const tableName = row.TABLE_NAME as string;
        return {
          name: tableName,
          type: (row.TABLE_TYPE as string) === 'VIEW' ? 'view' : 'table',
          columns: columnsMap.get(tableName) ?? []
        };
      });

      return {
        provider: 'mysql',
        database: this.config.database,
        tables
      };
    } finally {
      await connection.end();
    }
  }

  private async loadSqliteSchema(): Promise<DatabaseSchema> {
    if (!this.config.filePath) {
      throw new Error('SQLite configuration missing database file path.');
    }

    const driver = sqlite3.verbose();
    const db = await open({ filename: this.config.filePath, driver: driver.Database });

    try {
      const tables = await db.all<Array<{ name: string; type: string }>>(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`
      );

      const tableInfos: TableInfo[] = [];
      for (const table of tables) {
        const quoted = quoteSqliteIdentifier(table.name);
        const columns = await db.all<Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }>>(`PRAGMA table_info(${quoted})`);

        const columnInfos: TableColumn[] = columns.map((column) => ({
          name: column.name,
          dataType: column.type,
          isNullable: column.notnull !== 1,
          defaultValue: column.dflt_value
        }));

        tableInfos.push({
          name: table.name,
          type: table.type === 'view' ? 'view' : 'table',
          columns: columnInfos
        });
      }

      return {
        provider: 'sqlite',
        database: path.basename(this.config.filePath),
        tables: tableInfos
      };
    } finally {
      await db.close();
    }
  }
}

export async function testConnection(config: ConnectionConfig): Promise<void> {
  switch (config.provider) {
    case 'postgres': {
      const client = new PgClient({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        ssl: config.ssl
      });
      await client.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        await client.end();
      }
      return;
    }
    case 'mysql': {
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined
      });
      try {
        await connection.execute('SELECT 1');
      } finally {
        await connection.end();
      }
      return;
    }
    case 'sqlite': {
      if (!config.filePath) {
        throw new Error('Не указан путь к файлу SQLite.');
      }
      const driver = sqlite3.verbose();
      const db = await open({ filename: config.filePath, driver: driver.Database, mode: driver.OPEN_READONLY });
      try {
        await db.get('SELECT 1');
      } finally {
        await db.close();
      }
      return;
    }
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

function renderMarkdown(schema: DatabaseSchema): string {
  const lines: string[] = [];
  const nowIso = new Date().toISOString();
  lines.push('# Database Context');
  lines.push('');
  lines.push(`- Provider: **${schema.provider}**`);
  if (schema.database) {
    lines.push(`- Database: **${schema.database}**`);
  }
  lines.push(`- Generated: ${nowIso}`);
  lines.push('');

  for (const table of schema.tables) {
    const qualifiedName = table.schema ? `${table.schema}.${table.name}` : table.name;
    lines.push(`## ${qualifiedName}`);
    lines.push('');
    lines.push(`Type: \`${table.type}\``);
    lines.push('');
    if (table.columns.length === 0) {
      lines.push('_No columns discovered._');
      lines.push('');
      continue;
    }
    lines.push('| Column | Type | Nullable | Default |');
    lines.push('| ------ | ---- | -------- | ------- |');
    for (const column of table.columns) {
      const defaultValue = column.defaultValue ?? '';
      lines.push(
        `| ${column.name} | ${column.dataType} | ${column.isNullable ? 'YES' : 'NO'} | ${escapeMarkdown(defaultValue)} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function escapeMarkdown(value: string): string {
  if (!value) {
    return '';
  }
  return value.replace(/\|/g, '\\|');
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
