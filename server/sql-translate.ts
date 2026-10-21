/**
 * 把项目里沿用 MySQL 写法的 SQL 翻译成 PostgreSQL 能执行的形式。
 *
 * 只做三件机械且安全的事，其余方言差异（ON CONFLICT 的目标、SUM(条件) 等）
 * 由各处 SQL 显式改写，避免这层"魔法"越积越难调试：
 *
 * 1. 占位符 `?` 按出现顺序改成 `$1, $2 …`，并跳过字符串、标识符与注释；
 * 2. 反引号标识符改成双引号；
 * 3. `INSERT IGNORE INTO` 改成 `INSERT INTO … ON CONFLICT DO NOTHING`。
 *
 * 这个模块不依赖任何数据库驱动，因此可以直接单元测试。
 */

export type TranslatedSql = {
  text: string;
  /** 转换后的参数个数，用于自检占位符与传参是否匹配。 */
  paramCount: number;
};

type State = 'normal' | 'single' | 'double' | 'backtick' | 'lineComment' | 'blockComment';

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
      if (char === '`') { state = 'backtick'; out += '"'; continue; }
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

    if (state === 'backtick') {
      if (char === '`' && next === '`') { out += '"' + '"'; i += 1; continue; }
      if (char === '`') { state = 'normal'; out += '"'; continue; }
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

  return { text: rewriteInsertIgnore(out), paramCount: params };
}

/** `INSERT IGNORE INTO …` → `INSERT INTO …; ON CONFLICT DO NOTHING`（SQL 里都是单条语句）。 */
function rewriteInsertIgnore(sql: string) {
  if (!/^\s*INSERT\s+IGNORE\s+INTO/i.test(sql)) return sql;
  const body = sql.replace(/^(\s*)INSERT\s+IGNORE\s+INTO/i, '$1INSERT INTO');
  const trimmed = body.trimEnd();
  const semicolon = trimmed.endsWith(';') ? ';' : '';
  const head = semicolon ? trimmed.slice(0, -1) : trimmed;
  // 已经有了冲突处理就不再追加，避免重复。
  if (/\bON\s+CONFLICT\b/i.test(head)) return head + semicolon;
  return `${head} ON CONFLICT DO NOTHING${semicolon}`;
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
