import { parse } from 'dotenv';
import { ConnectionCredentials, DatabaseType } from './credentials';

type SupportedEnvKey =
    | 'DB_TYPE'
    | 'DB_HOST'
    | 'DB_PORT'
    | 'DB_USER'
    | 'DB_PASSWORD'
    | 'DB_NAME'
    | 'DB_SCHEMA'
    | 'DB_SSL'
    | 'DB_FILE';

const typeAliases: Record<string, DatabaseType> = {
    mysql: 'mysql',
    mariadb: 'mysql',
    postgres: 'postgres',
    postgresql: 'postgres',
    pg: 'postgres',
    sqlite: 'sqlite',
    sqlite3: 'sqlite'
};

function normalizeType(raw?: string): DatabaseType | undefined {
    if (!raw) {
        return undefined;
    }

    const normalized = raw.trim().toLowerCase();
    return typeAliases[normalized];
}

function toBoolean(value: string | undefined): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())) {
        return true;
    }

    if (['0', 'false', 'no', 'n', 'off'].includes(value.trim().toLowerCase())) {
        return false;
    }

    return undefined;
}

function toNumber(value: string | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function credentialsFromEnv(content: string): ConnectionCredentials | undefined {
    const parsed = parse(content) as Record<SupportedEnvKey, string | undefined>;
    const type = normalizeType(parsed.DB_TYPE);

    if (!type) {
        return undefined;
    }

    if (type === 'sqlite') {
        const filePath = parsed.DB_FILE?.trim();
        if (!filePath) {
            return undefined;
        }

        return {
            type,
            filePath
        };
    }

    const host = parsed.DB_HOST?.trim();
    const database = parsed.DB_NAME?.trim();
    if (!host || !database) {
        return undefined;
    }

    return {
        type,
        host,
        database,
        port: toNumber(parsed.DB_PORT) ?? (type === 'postgres' ? 5432 : 3306),
        user: parsed.DB_USER?.trim(),
        password: parsed.DB_PASSWORD,
        schema: parsed.DB_SCHEMA?.trim(),
        ssl: toBoolean(parsed.DB_SSL)
    };
}

export function credentialsToEnv(credentials: ConnectionCredentials): string {
    const lines: string[] = [];
    lines.push(`DB_TYPE=${credentials.type}`);

    if (credentials.type === 'sqlite') {
        if (credentials.filePath) {
            lines.push(`DB_FILE=${credentials.filePath}`);
        }
        return lines.join('\n');
    }

    if (credentials.host) {
        lines.push(`DB_HOST=${credentials.host}`);
    }

    if (credentials.port) {
        lines.push(`DB_PORT=${credentials.port}`);
    }

    if (credentials.user) {
        lines.push(`DB_USER=${credentials.user}`);
    }

    if (credentials.password) {
        lines.push(`DB_PASSWORD=${credentials.password}`);
    }

    if (credentials.database) {
        lines.push(`DB_NAME=${credentials.database}`);
    }

    if (credentials.schema) {
        lines.push(`DB_SCHEMA=${credentials.schema}`);
    }

    if (credentials.ssl !== undefined) {
        lines.push(`DB_SSL=${credentials.ssl ? 'true' : 'false'}`);
    }

    return lines.join('\n');
}
