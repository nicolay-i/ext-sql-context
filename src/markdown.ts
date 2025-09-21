import { ConnectionCredentials } from './credentials';
import { ColumnSchema, DatabaseSchema, TableSchema } from './database';

function escapeMarkdown(value: string | null | undefined): string {
    if (value === undefined || value === null) {
        return '';
    }
    return value.replace(/\|/g, '\\|');
}

function formatTableHeader(table: TableSchema): string {
    const schemaPrefix = table.schema ? `${table.schema}.` : '';
    return `### ${schemaPrefix}${table.name}`;
}

function formatColumnRow(column: ColumnSchema): string {
    const primaryKey = column.isPrimaryKey ? 'Yes' : '';
    const nullable = column.nullable ? 'Yes' : 'No';
    const defaultValue = column.defaultValue === undefined || column.defaultValue === null
        ? ''
        : escapeMarkdown(String(column.defaultValue));

    return `| ${escapeMarkdown(column.name)} | ${escapeMarkdown(column.dataType)} | ${nullable} | ${defaultValue} | ${primaryKey} |`;
}

export function buildMarkdownContext(credentials: ConnectionCredentials, schema: DatabaseSchema): string {
    const lines: string[] = [];
    lines.push('# Database Context');
    lines.push('');
    lines.push('## Connection');
    lines.push('');
    lines.push(`- Type: ${credentials.type}`);

    if (credentials.type === 'sqlite') {
        lines.push(`- File: ${credentials.filePath ?? ''}`);
    } else {
        lines.push(`- Host: ${credentials.host ?? ''}`);
        lines.push(`- Port: ${credentials.port ?? ''}`);
        lines.push(`- Database: ${credentials.database ?? ''}`);
        if (credentials.schema) {
            lines.push(`- Schema: ${credentials.schema}`);
        }
        if (credentials.ssl !== undefined) {
            lines.push(`- SSL: ${credentials.ssl ? 'enabled' : 'disabled'}`);
        }
    }

    lines.push('');
    lines.push('## Tables');
    lines.push('');

    if (schema.tables.length === 0) {
        lines.push('No tables found.');
        return lines.join('\n');
    }

    for (const table of schema.tables) {
        lines.push(formatTableHeader(table));
        lines.push('');
        lines.push('| Column | Type | Nullable | Default | Primary Key |');
        lines.push('| --- | --- | --- | --- | --- |');
        for (const column of table.columns) {
            lines.push(formatColumnRow(column));
        }
        lines.push('');
    }

    return lines.join('\n');
}
