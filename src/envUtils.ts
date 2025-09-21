import { ConnectionConfig, DatabaseProvider } from './types';

export interface EnvConnectionPayload {
  raw: string;
  config: ConnectionConfig;
}

export function parseEnv(content: string): Record<string, string> {
  const lines = content.split(/\r?\n/);
  const result: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function resolveProvider(env: Record<string, string>): DatabaseProvider {
  const providerValue = env['DB_PROVIDER'] ?? env['DB_TYPE'];
  const normalized = providerValue?.toLowerCase();
  if (normalized === 'postgres' || normalized === 'postgresql' || normalized === 'pg') {
    return 'postgres';
  }
  if (normalized === 'mysql' || normalized === 'mariadb') {
    return 'mysql';
  }
  if (normalized === 'sqlite' || normalized === 'sqlite3') {
    return 'sqlite';
  }
  throw new Error('DB_PROVIDER/DB_TYPE is required and must be one of postgres, mysql or sqlite.');
}

export function connectionFromEnv(content: string): EnvConnectionPayload {
  const env = parseEnv(content);
  const provider = resolveProvider(env);
  const config: ConnectionConfig = { provider };

  if (provider === 'sqlite') {
    const file = env['DB_FILE'] ?? env['SQLITE_FILE'] ?? env['DATABASE_FILE'];
    if (!file) {
      throw new Error('DB_FILE is required for sqlite connections.');
    }
    config.filePath = file;
  } else {
    const host = env['DB_HOST'] ?? env['HOST'];
    const portValue = env['DB_PORT'] ?? env['PORT'];
    const user = env['DB_USER'] ?? env['USER'];
    const password = env['DB_PASSWORD'] ?? env['PASSWORD'];
    const database = env['DB_NAME'] ?? env['DATABASE'];
    const sslValue = env['DB_SSL'] ?? env['SSL'];

    if (!host) {
      throw new Error('DB_HOST is required for postgres/mysql connections.');
    }
    if (!database) {
      throw new Error('DB_NAME is required for postgres/mysql connections.');
    }
    if (!user) {
      throw new Error('DB_USER is required for postgres/mysql connections.');
    }

    config.host = host;
    config.port = portValue ? Number(portValue) : undefined;
    config.user = user;
    config.password = password;
    config.database = database;
    if (sslValue) {
      config.ssl = sslValue === 'true' || sslValue === '1';
    }
  }

  return { raw: content, config };
}

export function connectionToEnv(config: ConnectionConfig): string {
  const baseEntries: [string, string | undefined][] = [];
  baseEntries.push(['DB_TYPE', config.provider]);

  if (config.provider === 'sqlite') {
    baseEntries.push(['DB_FILE', config.filePath]);
  } else {
    baseEntries.push(['DB_HOST', config.host]);
    baseEntries.push(['DB_PORT', config.port ? String(config.port) : undefined]);
    baseEntries.push(['DB_USER', config.user]);
    baseEntries.push(['DB_PASSWORD', config.password]);
    baseEntries.push(['DB_NAME', config.database]);
    if (typeof config.ssl === 'boolean') {
      baseEntries.push(['DB_SSL', config.ssl ? 'true' : 'false']);
    }
  }

  return baseEntries
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${key}=${escapeValue(value)}`)
    .join('\n');
}

function escapeValue(value: string): string {
  if (/\s/.test(value) || value.includes('#') || value.includes('=')) {
    return JSON.stringify(value);
  }
  return value;
}
