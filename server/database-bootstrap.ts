import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { decryptSecret, isEncryptedSecret, readOptionalLegacyApplicationEncryptionKey } from './secret-storage.js';

export type MySqlConnectionSettings = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
};

type DatabaseBootstrapV2 = { version: 2; settings: MySqlConnectionSettings };
type DatabaseBootstrapV1 = { version: 1; ciphertext: string };
type DatabaseBootstrap = DatabaseBootstrapV1 | DatabaseBootstrapV2;

const bootstrapPath = resolve(process.env.PAGE_WATCH_BOOTSTRAP_PATH?.trim() || './data/database-bootstrap.json');

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

function readBootstrapDocument(): DatabaseBootstrap | null {
  let content: string;
  try { content = readFileSync(bootstrapPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let document: unknown;
  try { document = JSON.parse(content); }
  catch { throw new Error('数据库引导配置 JSON 格式无效；文件未修改。'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('数据库引导配置格式无效；文件未修改。');
  const raw = document as Record<string, unknown>;
  if (raw.version === 1 && typeof raw.ciphertext === 'string') return raw as DatabaseBootstrapV1;
  if (raw.version === 2 && raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) return raw as DatabaseBootstrapV2;
  throw new Error(`不支持的数据库引导配置版本 ${String(raw.version)}；文件未修改。`);
}

export function databaseBootstrapNeedsMigration() {
  return readBootstrapDocument()?.version === 1;
}

function decryptLegacyDatabaseSettings(raw: DatabaseBootstrapV1) {
  if (!isEncryptedSecret(raw.ciphertext)) throw new Error('旧版数据库引导配置不是受支持的 pwenc:v1 密文；文件未修改。');
  const key = readOptionalLegacyApplicationEncryptionKey();
  if (!key) throw new Error('数据库引导文件仍是旧版 pwenc:v1 密文，但未找到原 APP_ENCRYPTION_KEY 或 data/app-encryption-key。请恢复旧密钥后重启；未修改文件或数据库。');
  try {
    return normalizeDatabaseSettings(JSON.parse(decryptSecret(raw.ciphertext, key)) as Partial<MySqlConnectionSettings>);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('旧版数据库引导密文无法解析；请核对原 APP_ENCRYPTION_KEY，文件未修改。');
    throw error;
  } finally {
    key.fill(0);
  }
}

/** Read bootstrap settings and, for v1, its ciphertext from one file snapshot. */
export function databaseBootstrapForStartup() {
  const raw = readBootstrapDocument();
  if (!raw) return null;
  if (raw.version === 1) return { ciphertext: raw.ciphertext, settings: decryptLegacyDatabaseSettings(raw) };
  return { ciphertext: null, settings: normalizeDatabaseSettings(raw.settings) };
}

export function savedDatabaseSettings(): MySqlConnectionSettings | null {
  return databaseBootstrapForStartup()?.settings ?? null;
}

function writeBootstrapAtomically(document: DatabaseBootstrap, expectedLegacyCiphertext?: string) {
  mkdirSync(dirname(bootstrapPath), { recursive: true });
  const lockPath = `${bootstrapPath}.lock`;
  let lockDescriptor: number | undefined;
  let ownsLock = false;
  const temporary = resolve(dirname(bootstrapPath), `.${basename(bootstrapPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let descriptor: number | undefined;
  try {
    try { lockDescriptor = openSync(lockPath, 'wx', 0o600); ownsLock = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`数据库引导文件锁仍存在（${lockPath}）。请先停止所有 Page Watch 实例；确认没有升级或写入正在运行后，删除此锁文件再重试。`);
      throw error;
    }
    if (expectedLegacyCiphertext !== undefined) {
      const current = readBootstrapDocument();
      if (current?.version !== 1 || current.ciphertext !== expectedLegacyCiphertext) {
        throw new Error('数据库引导文件在迁移期间已变化；为避免覆盖新配置，未写入 v2 文件。请停止旧版实例并重启新版完成迁移。');
      }
    }
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, bootstrapPath);
    chmodSync(bootstrapPath, 0o600);
    if (process.platform !== 'win32') {
      const directoryDescriptor = openSync(dirname(bootstrapPath), 'r');
      try { fsyncSync(directoryDescriptor); }
      finally { closeSync(directoryDescriptor); }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    if (ownsLock) {
      try { unlinkSync(lockPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

/** V2 intentionally stores the MySQL connection in plaintext for new installs. */
export function saveDatabaseSettings(input: Partial<MySqlConnectionSettings>) {
  const settings = normalizeDatabaseSettings(input);
  writeBootstrapAtomically({ version: 2, settings });
  return settings;
}

export function migrateLegacyDatabaseSettingsToPlaintext(input: Partial<MySqlConnectionSettings>, expectedCiphertext: string) {
  const settings = normalizeDatabaseSettings(input);
  writeBootstrapAtomically({ version: 2, settings }, expectedCiphertext);
  return settings;
}

export const databaseBootstrapFile = bootstrapPath;
