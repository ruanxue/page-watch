import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { translateSql, withReturning } from './sql-translate.js';

/**
 * PostgreSQL 连接与结果适配。
 *
 * 项目里所有 SQL 都经过 `db.all/get/run`，所以这里把「MySQL 写法 + ? 占位符」
 * 翻译成 PG 能跑的形式，让上层查询尽量不改：
 * - 占位符、反引号、INSERT IGNORE 由 sql-translate 处理；
 * - INSERT 自动补 RETURNING，用来取回自增 id；
 * - affectedRows 用 rowCount 代替。
 */

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
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // 与 MySQL 一样，每个进程保持很小的连接数：容器里有网页服务加执行引擎，
    // 进程一多很容易把 NAS 上的连接数吃满。
    max: config.connectionLimit,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // 统一按 UTC 取时间，项目里时间一律以 ISO 字符串存 VARCHAR，逻辑不依赖时区。
    options: '-c timezone=UTC'
  });
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
