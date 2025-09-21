export type DatabaseProvider = 'mysql' | 'postgres' | 'sqlite';

export interface ConnectionConfig {
  provider: DatabaseProvider;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  filePath?: string;
  ssl?: boolean;
}

export interface TableColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue?: string | null;
  description?: string | null;
}

export interface TableInfo {
  name: string;
  schema?: string;
  type: 'table' | 'view';
  columns: TableColumn[];
}

export interface DatabaseSchema {
  provider: DatabaseProvider;
  database?: string;
  tables: TableInfo[];
}
