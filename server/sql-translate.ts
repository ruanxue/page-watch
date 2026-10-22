/**
 * 将参数占位符 `?` 按顺序改成 PostgreSQL 的 `$1, $2 …`。
 * 跳过字符串、双引号标识符与注释；SQL 本身统一使用 PostgreSQL 语法。
 *
 * 这个模块不依赖任何数据库驱动，因此可以直接单元测试。
 */

export type TranslatedSql = {
  text: string;
  /** 转换后的参数个数，用于自检占位符与传参是否匹配。 */
  paramCount: number;
};

type State = 'normal' | 'single' | 'double' | 'lineComment' | 'blockComment';

export function translateSql(sql: string): TranslatedSql {
  let out = '';
  let state: State = 'normal';
  let params = 0;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === 'normal') {
      if (char === "'") { state = 'single'; out += char; continue; }
      if (char === '"') { state = 'double'; out += char; continue; }
      if (char === '-' && next === '-') { state = 'lineComment'; out += char + next; i += 1; continue; }
      if (char === '/' && next === '*') { state = 'blockComment'; out += char + next; i += 1; continue; }
      if (char === '?') { params += 1; out += `$${params}`; continue; }
      out += char;
      continue;
    }

    if (state === 'single') {
      // SQL 用两个单引号表示一个单引号，遇到成对的一起输出，不提前结束。
      if (char === "'" && next === "'") { out += char + next; i += 1; continue; }
      if (char === "'") state = 'normal';
      out += char;
      continue;
    }

    if (state === 'double') {
      if (char === '"' && next === '"') { out += char + next; i += 1; continue; }
      if (char === '"') state = 'normal';
      out += char;
      continue;
    }

    if (state === 'lineComment') {
      if (char === '\n') state = 'normal';
      out += char;
      continue;
    }

    // blockComment
    if (char === '*' && next === '/') { state = 'normal'; out += char + next; i += 1; continue; }
    out += char;
  }

  return { text: out, paramCount: params };
}

/** `run()` 需要拿回自增 id：给 INSERT 补上 `RETURNING *`（已有 RETURNING 则不动）。 */
export function withReturning(sql: string) {
  if (!/^\s*INSERT\s+INTO/i.test(sql)) return sql;
  if (/\bRETURNING\b/i.test(sql)) return sql;
  const trimmed = sql.trimEnd();
  const semicolon = trimmed.endsWith(';') ? ';' : '';
  const head = semicolon ? trimmed.slice(0, -1) : trimmed;
  return `${head} RETURNING *${semicolon}`;
}
