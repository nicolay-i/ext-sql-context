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

export interface ForeignKey {
  name?: string | null;
  columns: string[];
  referencedTable: { schema?: string; name: string };
  referencedColumns: string[];
  onUpdate?: string | null;
  onDelete?: string | null;
}

export interface TableInfo {
  name: string;
  schema?: string;
  type: 'table' | 'view';
  columns: TableColumn[];
  foreignKeys?: ForeignKey[];
}

export interface DatabaseSchema {
  provider: DatabaseProvider;
  database?: string;
  tables: TableInfo[];
}
