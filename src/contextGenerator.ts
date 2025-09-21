import * as path from 'path';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { ConnectionConfig, DatabaseSchema, TableColumn, TableInfo, ForeignKey } from './types';

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

      // Collect foreign keys
      const fkResult = await client.query<{
        constraint_name: string | null;
        table_schema: string;
        table_name: string;
        column_name: string;
        foreign_table_schema: string;
        foreign_table_name: string;
        foreign_column_name: string;
        update_rule: string | null;
        delete_rule: string | null;
      }>(
        `SELECT
           tc.constraint_name,
           kcu.table_schema,
           kcu.table_name,
           kcu.column_name,
           ccu.table_schema AS foreign_table_schema,
           ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name,
           rc.update_rule,
           rc.delete_rule
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.referential_constraints AS rc
           ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage AS ccu
           ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY'
           AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY kcu.table_schema, kcu.table_name, tc.constraint_name, kcu.ordinal_position`
      );

      const fkMap = new Map<string, ForeignKey[]>();
      for (const row of fkResult.rows) {
        const tableKey = `${row.table_schema}.${row.table_name}`;
        const fkKey = `${tableKey}:${row.constraint_name ?? ''}`;
        let fks = fkMap.get(tableKey);
        if (!fks) {
          fks = [];
          fkMap.set(tableKey, fks);
        }
        let fk = fks.find((x) => x.name === row.constraint_name);
        if (!fk) {
          fk = {
            name: row.constraint_name,
            columns: [],
            referencedTable: { schema: row.foreign_table_schema, name: row.foreign_table_name },
            referencedColumns: [],
            onUpdate: row.update_rule,
            onDelete: row.delete_rule
          };
          fks.push(fk);
        }
        fk.columns.push(row.column_name);
        fk.referencedColumns.push(row.foreign_column_name);
      }

      const tables: TableInfo[] = tableResult.rows.map((row): TableInfo => {
        const key = `${row.table_schema}.${row.table_name}`;
        return {
          name: row.table_name,
          schema: row.table_schema,
          type: row.table_type === 'VIEW' ? 'view' : 'table',
          columns: columnsMap.get(key) ?? [],
          foreignKeys: fkMap.get(key) ?? []
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

      // Foreign keys
      const [fkRows] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT
           kcu.CONSTRAINT_NAME,
           kcu.TABLE_NAME,
           kcu.COLUMN_NAME,
           kcu.REFERENCED_TABLE_NAME,
           kcu.REFERENCED_COLUMN_NAME,
           rc.UPDATE_RULE,
           rc.DELETE_RULE
         FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE kcu.TABLE_SCHEMA = ?
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        [this.config.database]
      );

      const fkMap = new Map<string, ForeignKey[]>();
      for (const row of fkRows) {
        const tableName = row.TABLE_NAME as string;
        let fks = fkMap.get(tableName);
        if (!fks) {
          fks = [];
          fkMap.set(tableName, fks);
        }
        const constraintName = (row.CONSTRAINT_NAME as string) ?? null;
        let fk = fks.find((x) => x.name === constraintName);
        if (!fk) {
          fk = {
            name: constraintName,
            columns: [],
            referencedTable: { name: row.REFERENCED_TABLE_NAME as string },
            referencedColumns: [],
            onUpdate: (row.UPDATE_RULE as string) ?? null,
            onDelete: (row.DELETE_RULE as string) ?? null
          };
          fks.push(fk);
        }
        fk.columns.push(row.COLUMN_NAME as string);
        fk.referencedColumns.push(row.REFERENCED_COLUMN_NAME as string);
      }

      const tables: TableInfo[] = tableRows.map((row) => {
        const tableName = row.TABLE_NAME as string;
        return {
          name: tableName,
          type: (row.TABLE_TYPE as string) === 'VIEW' ? 'view' : 'table',
          columns: columnsMap.get(tableName) ?? [],
          foreignKeys: fkMap.get(tableName) ?? []
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

        // Foreign keys for this table
        const fks = await db.all<Array<{
          id: number;
          seq: number;
          table: string;
          from: string;
          to: string;
          on_update: string | null;
          on_delete: string | null;
        }>>(`PRAGMA foreign_key_list(${quoted})`);

        const fkGrouped = new Map<number, ForeignKey>();
        for (const row of fks) {
          let fk = fkGrouped.get(row.id);
          if (!fk) {
            fk = {
              name: null,
              columns: [],
              referencedTable: { name: row.table },
              referencedColumns: [],
              onUpdate: row.on_update ?? null,
              onDelete: row.on_delete ?? null
            };
            fkGrouped.set(row.id, fk);
          }
          fk.columns.push(row.from);
          fk.referencedColumns.push(row.to);
        }

        tableInfos.push({
          name: table.name,
          type: table.type === 'view' ? 'view' : 'table',
          columns: columnInfos,
          foreignKeys: Array.from(fkGrouped.values())
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
        throw new Error('SQLite file path not specified.');
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

    const fks = table.foreignKeys ?? [];
    if (fks.length > 0) {
      lines.push('Relations:');
      lines.push('');
      lines.push('| Columns | References | On Update | On Delete |');
      lines.push('| ------- | ---------- | --------- | --------- |');
      for (const fk of fks) {
        const cols = fk.columns.join(', ');
        const refCols = fk.referencedColumns.join(', ');
        const refTable = fk.referencedTable.schema
          ? `${fk.referencedTable.schema}.${fk.referencedTable.name}`
          : fk.referencedTable.name;
        const ref = `${refTable} (${refCols})`;
        lines.push(`| ${cols} | ${ref} | ${fk.onUpdate ?? ''} | ${fk.onDelete ?? ''} |`);
      }
      lines.push('');
    }
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
