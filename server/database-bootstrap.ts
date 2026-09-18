import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { decryptSecret, encryptSecret, readApplicationEncryptionKey } from './secret-storage.js';

export type MySqlConnectionSettings = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
};

const bootstrapPath = resolve(process.env.PAGE_WATCH_BOOTSTRAP_PATH?.trim() || './data/database-bootstrap.json');
const encryptionKey = readApplicationEncryptionKey();

export function normalizeDatabaseSettings(input: Partial<MySqlConnectionSettings>): MySqlConnectionSettings {
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const database = typeof input.database === 'string' ? input.database.trim() : '';
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const port = Number(input.port ?? 3306);
  const connectionLimit = Number(input.connectionLimit ?? 3);
  if (!host || !database || !user || password === '' || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 16) {
    throw new Error('请填写完整的 MySQL 地址、端口、数据库名、账号和密码。');
  }
  return { host, port, database, user, password, connectionLimit };
}

export function environmentDatabaseSettings(): MySqlConnectionSettings | null {
  const password = process.env.MYSQL_PASSWORD;
  if (!process.env.MYSQL_HOST?.trim() || !process.env.MYSQL_DATABASE?.trim() || !process.env.MYSQL_USER?.trim() || password === undefined) return null;
  return normalizeDatabaseSettings({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT ?? 3306), database: process.env.MYSQL_DATABASE, user: process.env.MYSQL_USER, password, connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 3) });
}

export function savedDatabaseSettings(): MySqlConnectionSettings | null {
  try {
    const raw = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as { version?: unknown; ciphertext?: unknown };
    if (raw.version !== 1 || typeof raw.ciphertext !== 'string') throw new Error('数据库引导配置格式无效。');
    return normalizeDatabaseSettings(JSON.parse(decryptSecret(raw.ciphertext, encryptionKey)) as Partial<MySqlConnectionSettings>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function saveDatabaseSettings(input: Partial<MySqlConnectionSettings>) {
  const settings = normalizeDatabaseSettings(input);
  mkdirSync(dirname(bootstrapPath), { recursive: true });
  const temporary = `${bootstrapPath}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, ciphertext: encryptSecret(JSON.stringify(settings), encryptionKey) }), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, bootstrapPath);
  return settings;
}

export const databaseBootstrapFile = bootstrapPath;
