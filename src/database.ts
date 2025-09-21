import { Client } from 'pg';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ConnectionCredentials } from './credentials';

export interface ColumnSchema {
    name: string;
    dataType: string;
    nullable: boolean;
    defaultValue?: string | null;
    isPrimaryKey?: boolean;
}

export interface TableSchema {
    name: string;
    schema?: string;
    columns: ColumnSchema[];
}

export interface DatabaseSchema {
    tables: TableSchema[];
}

export class DatabaseManager {
    async fetchSchema(credentials: ConnectionCredentials): Promise<DatabaseSchema> {
        switch (credentials.type) {
            case 'postgres':
                return this.fetchPostgresSchema(credentials);
            case 'mysql':
                return this.fetchMySqlSchema(credentials);
            case 'sqlite':
                return this.fetchSqliteSchema(credentials);
            default:
                throw new Error(`Unsupported database type: ${credentials.type}`);
        }
    }

    private async fetchPostgresSchema(credentials: ConnectionCredentials): Promise<DatabaseSchema> {
        if (!credentials.host || !credentials.database) {
            throw new Error('PostgreSQL credentials require host and database name.');
        }

        const client = new Client({
            host: credentials.host,
            port: credentials.port ?? 5432,
            user: credentials.user,
            password: credentials.password,
            database: credentials.database,
            ssl: credentials.ssl ? { rejectUnauthorized: false } : undefined
        });

        await client.connect();

        try {
            const params: string[] = [];
            const schemaFilter = credentials.schema;
            let schemaCondition = "table_schema NOT IN ('information_schema', 'pg_catalog')";
            if (schemaFilter && schemaFilter !== '*') {
                schemaCondition = 'table_schema = $1';
                params.push(schemaFilter);
            }

            const columnQuery = `
                SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE ${schemaCondition}
                ORDER BY table_schema, table_name, ordinal_position
            `;

            const pkQuery = `
                SELECT tc.table_schema, tc.table_name, kc.column_name
                FROM information_schema.table_constraints tc
                INNER JOIN information_schema.key_column_usage kc ON tc.constraint_name = kc.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY' AND ${schemaCondition}
            `;

            const [columnResult, pkResult] = await Promise.all([
                client.query<{
                    table_schema: string;
                    table_name: string;
                    column_name: string;
                    data_type: string;
                    is_nullable: string;
                    column_default: string | null;
                }>(columnQuery, params),
                client.query<{
                    table_schema: string;
                    table_name: string;
                    column_name: string;
                }>(pkQuery, params)
            ]);

            const pkSet = new Set(
                pkResult.rows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`)
            );

            const tablesMap = new Map<string, TableSchema>();
            for (const row of columnResult.rows) {
                const key = `${row.table_schema}.${row.table_name}`;
                if (!tablesMap.has(key)) {
                    tablesMap.set(key, {
                        name: row.table_name,
                        schema: row.table_schema,
                        columns: []
                    });
                }

                const table = tablesMap.get(key)!;
                table.columns.push({
                    name: row.column_name,
                    dataType: row.data_type,
                    nullable: row.is_nullable === 'YES',
                    defaultValue: row.column_default,
                    isPrimaryKey: pkSet.has(`${row.table_schema}.${row.table_name}.${row.column_name}`)
                });
            }

            return { tables: Array.from(tablesMap.values()) };
        } finally {
            await client.end();
        }
    }

    private async fetchMySqlSchema(credentials: ConnectionCredentials): Promise<DatabaseSchema> {
        if (!credentials.host || !credentials.database) {
            throw new Error('MySQL credentials require host and database name.');
        }

        const mysql = await import('mysql2/promise');
        const connection: Connection = await mysql.createConnection({
            host: credentials.host,
            port: credentials.port ?? 3306,
            user: credentials.user,
            password: credentials.password,
            database: credentials.database,
            ssl: credentials.ssl ? { rejectUnauthorized: false } : undefined
        });

        try {
            type ColumnRow = RowDataPacket & {
                TABLE_NAME: string;
                COLUMN_NAME: string;
                COLUMN_TYPE: string;
                IS_NULLABLE: string;
                COLUMN_DEFAULT: string | null;
                COLUMN_KEY: string;
            };

            type PrimaryKeyRow = RowDataPacket & { TABLE_NAME: string; COLUMN_NAME: string };

            const [columns] = await connection.execute<ColumnRow[]>(
                `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = ?
                 ORDER BY TABLE_NAME, ORDINAL_POSITION`,
                [credentials.database]
            );

            const [primaryKeys] = await connection.execute<PrimaryKeyRow[]>(
                `SELECT TABLE_NAME, COLUMN_NAME
                 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                 WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY'`,
                [credentials.database]
            );

            const pkSet = new Set(primaryKeys.map((row) => `${row.TABLE_NAME}.${row.COLUMN_NAME}`));

            const tablesMap = new Map<string, TableSchema>();
            for (const column of columns) {
                if (!tablesMap.has(column.TABLE_NAME)) {
                    tablesMap.set(column.TABLE_NAME, {
                        name: column.TABLE_NAME,
                        columns: []
                    });
                }

                const table = tablesMap.get(column.TABLE_NAME)!;
                table.columns.push({
                    name: column.COLUMN_NAME,
                    dataType: column.COLUMN_TYPE,
                    nullable: column.IS_NULLABLE === 'YES',
                    defaultValue: column.COLUMN_DEFAULT,
                    isPrimaryKey: pkSet.has(`${column.TABLE_NAME}.${column.COLUMN_NAME}`)
                });
            }

            return { tables: Array.from(tablesMap.values()) };
        } finally {
            await connection.end();
        }
    }

    private async fetchSqliteSchema(credentials: ConnectionCredentials): Promise<DatabaseSchema> {
        if (!credentials.filePath) {
            throw new Error('SQLite credentials require a file path.');
        }

        const sqlite3 = await import('sqlite3');
        const sqlite = await import('sqlite');
        const resolvedPath = path.resolve(credentials.filePath);

        try {
            await fs.access(resolvedPath);
        } catch (error) {
            throw new Error(`SQLite database file not found at ${resolvedPath}`);
        }

        const db = await sqlite.open({ filename: resolvedPath, driver: sqlite3.Database });

        try {
            const tables = await db.all<{ name: string }[]>(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
            );

            const results: TableSchema[] = [];
            for (const table of tables) {
                const columns = await db.all<
                    Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>
                >(`PRAGMA table_info(${JSON.stringify(table.name)})`);

                results.push({
                    name: table.name,
                    columns: columns.map((column) => ({
                        name: column.name,
                        dataType: column.type,
                        nullable: column.notnull === 0,
                        defaultValue: column.dflt_value,
                        isPrimaryKey: column.pk !== 0
                    }))
                });
            }

            return { tables: results };
        } finally {
            await db.close();
        }
    }
}
