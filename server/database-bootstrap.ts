import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
/** 保存时明确标记数据库类型，避免把旧库地址误认为 PostgreSQL。 */
export type DatabaseConnectionSettings = {
  driver: 'postgres';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
};

type DatabaseBootstrap = { version: 2; settings: DatabaseConnectionSettings };

const bootstrapPath = resolve(process.env.PAGE_WATCH_BOOTSTRAP_PATH?.trim() || './data/database-bootstrap.json');

export function normalizeDatabaseSettings(input: Partial<DatabaseConnectionSettings>): DatabaseConnectionSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('数据库连接配置格式无效。');
  if (input.driver !== undefined && input.driver !== 'postgres') throw new Error('本项目仅支持 PostgreSQL，不再支持 MySQL 或其他数据库。');
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const database = typeof input.database === 'string' ? input.database.trim() : '';
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const port = Number(input.port ?? 5432);
  const connectionLimit = Number(input.connectionLimit ?? 3);
  if (!host || !database || !user || password === '' || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 16) {
    throw new Error('请填写完整的 PostgreSQL 地址、端口、数据库名、账号和密码。');
  }
  return { driver: 'postgres', host, port, database, user, password, connectionLimit };
}

export function environmentDatabaseSettings(): DatabaseConnectionSettings | null {
  const driver = process.env.DB_DRIVER?.trim();
  if (driver && driver !== 'postgres') throw new Error('DB_DRIVER 仅允许 postgres；项目已移除 MySQL 支持，请更新部署配置。');
  if (Object.keys(process.env).some((key) => key.startsWith('MYSQL_'))) throw new Error('检测到已停用的 MYSQL_* 环境变量，请移除并使用 PostgreSQL 的 DATABASE_* 配置。');
  const host = process.env.DATABASE_HOST?.trim();
  const database = process.env.DATABASE_NAME?.trim();
  const user = process.env.DATABASE_USER?.trim();
  const password = process.env.DATABASE_PASSWORD;
  if (!host && !database && !user && !password) return null;
  return normalizeDatabaseSettings({ host, database, user, password,
    port: Number(process.env.DATABASE_PORT ?? 5432), connectionLimit: Number(process.env.DATABASE_CONNECTION_LIMIT ?? 3) });
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
  if (raw.version === 1) throw new Error('旧版数据库引导文件不再受支持，请提供明确的 PostgreSQL 连接配置；原文件未修改。');
  if (raw.version === 2 && raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
    if ((raw.settings as Record<string, unknown>).driver !== 'postgres') throw new Error('引导文件为旧 MySQL 配置或未标明数据库类型，请提供明确的 PostgreSQL 配置；原文件未修改。');
    return { version: 2, settings: normalizeDatabaseSettings(raw.settings as Partial<DatabaseConnectionSettings>) };
  }
  throw new Error(`不支持的数据库引导配置版本 ${String(raw.version)}；文件未修改。`);
}

export function savedDatabaseSettings(): DatabaseConnectionSettings | null {
  return readBootstrapDocument()?.settings ?? null;
}

function writeBootstrapAtomically(document: DatabaseBootstrap) {
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
    // 拿锁后重新验证，防止安装引导覆盖损坏或来源不明的旧配置。
    readBootstrapDocument();
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

/** PostgreSQL 连接以 v2 格式原子保存，密码不写入日志。 */
export function saveDatabaseSettings(input: Partial<DatabaseConnectionSettings>) {
  const settings = normalizeDatabaseSettings(input);
  writeBootstrapAtomically({ version: 2, settings });
  return settings;
}

export const databaseBootstrapFile = bootstrapPath;
