import { Pool, types as pgTypes, type PoolClient, type QueryResultRow } from 'pg';
import { translateSql, withReturning } from './sql-translate.js';

/**
 * PostgreSQL 连接与结果适配。
 *
 * 项目里所有 SQL 都经过 `db.all/get/run`：
 * - 由 sql-translate 转换参数占位符；
 * - INSERT 自动补 RETURNING，用来取回自增 id；
 * - affectedRows 用 rowCount 代替。
 */

/**
 * BIGINT（含 COUNT(*)）统一按数字解析，供业务计数与进度比较使用。
 * 本项目里的 BIGINT 均小于安全整数上限；DECIMAL 继续保留字符串精度。
 */
pgTypes.setTypeParser(pgTypes.builtins.INT8, (value: string) => Number(value));

export type PostgresConnectionSettings = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
};

export type PgRunResult = { changes: number; lastInsertRowid: number };

export type PgDatabaseClient = {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<PgRunResult>;
};

type Runner = Pool | PoolClient;

export function createPostgresPool(config: PostgresConnectionSettings) {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // 每个进程保持很小的连接数：容器里有网页服务加执行引擎，
    // 进程一多很容易把 NAS 上的连接数吃满。
    max: config.connectionLimit,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // 统一按 UTC 取时间，项目里时间一律以 ISO 字符串存 VARCHAR，逻辑不依赖时区。
    options: '-c timezone=UTC'
  });
  let lastConnectionErrorAt = 0;
  const reportConnectionError = (error: Error & { code?: string }) => {
    // pg 会自动移除出错的空闲连接；这里只记录安全的错误码，不能输出含凭据的 client。
    if (Date.now() - lastConnectionErrorAt < 60_000) return;
    lastConnectionErrorAt = Date.now();
    const code = /^[A-Z0-9_]{1,32}$/.test(error.code ?? '') ? error.code : '连接中断';
    console.warn(`PostgreSQL 连接已断开（${code}），后续请求将重新连接。`);
  };
  pool.on('error', reportConnectionError);
  // 事务在两条语句之间也可能断线，此时连接已借出，pool 的空闲错误监听不会触发。
  pool.on('connect', (client) => client.on('error', reportConnectionError));
  return pool;
}

export function pgClientFor(runner: Runner): PgDatabaseClient {
  return {
    async all<T>(sql: string, params: unknown[] = []) {
      const { text } = translateSql(sql);
      const result = await runner.query(text, params);
      return result.rows as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const { text } = translateSql(sql);
      const result = await runner.query(text, params);
      return result.rows[0] as T | undefined;
    },
    async run(sql: string, params: unknown[] = []) {
      const translated = translateSql(sql);
      // INSERT 需要拿回自增 id；UPDATE / DELETE 直接用 rowCount。
      const text = withReturning(translated.text);
      const result = await runner.query(text, params);
      const firstRow = result.rows[0] as QueryResultRow | undefined;
      const insertedId = firstRow && 'id' in firstRow ? Number((firstRow as { id: unknown }).id) : 0;
      return { changes: result.rowCount ?? 0, lastInsertRowid: Number.isFinite(insertedId) ? insertedId : 0 };
    }
  };
}
