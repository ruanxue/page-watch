import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'pagewatch-bootstrap-test-'));
const originalEnvironment = { ...process.env };
process.env.PAGE_WATCH_BOOTSTRAP_PATH = join(directory, 'database-bootstrap.json');
const { normalizeDatabaseSettings, environmentDatabaseSettings, savedDatabaseSettings, saveDatabaseSettings, databaseBootstrapFile } = await import('./database-bootstrap.js');
const settings = { host: 'postgres.example', database: 'pagewatch', user: 'test', password: '仅供测试', connectionLimit: 3 };

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (/^(MYSQL_|DATABASE_|DB_DRIVER$)/.test(key)) delete process.env[key];
  rmSync(databaseBootstrapFile, { force: true });
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  rmSync(directory, { recursive: true, force: true });
});

test('连接表单可省略类型，只规范化为 PostgreSQL', () => {
  assert.deepEqual(normalizeDatabaseSettings(settings), { ...settings, driver: 'postgres', port: 5432 });
  assert.throws(() => normalizeDatabaseSettings({ ...settings, driver: 'mysql' } as any), /仅支持 PostgreSQL/);
  assert.throws(() => normalizeDatabaseSettings({ ...settings, driver: 'unknown' } as any), /仅支持 PostgreSQL/);
});

test('环境变量只接受 DATABASE_*，旧驱动值和旧变量均明确报错', () => {
  assert.equal(environmentDatabaseSettings(), null);
  process.env.DATABASE_PORT = '5432';
  assert.equal(environmentDatabaseSettings(), null);
  Object.assign(process.env, { DATABASE_HOST: settings.host, DATABASE_NAME: settings.database, DATABASE_USER: settings.user, DATABASE_PASSWORD: settings.password, DB_DRIVER: 'postgres' });
  assert.equal(environmentDatabaseSettings()?.driver, 'postgres');
  process.env.DB_DRIVER = 'mysql';
  assert.throws(environmentDatabaseSettings, /DB_DRIVER/);
  delete process.env.DB_DRIVER;
  process.env.MYSQL_HOST = '';
  assert.throws(environmentDatabaseSettings, /MYSQL_\*/);
});

test('不完整的环境连接不会静默回落到另一个库', () => {
  process.env.DATABASE_HOST = settings.host;
  assert.throws(environmentDatabaseSettings, /填写完整/);
});

test('现有 PostgreSQL 引导原样读取，保存仍为明确类型的 v2', () => {
  const document = { version: 2, settings: normalizeDatabaseSettings(settings) };
  const text = JSON.stringify(document);
  writeFileSync(databaseBootstrapFile, text);
  assert.deepEqual(savedDatabaseSettings(), document.settings);
  assert.equal(readFileSync(databaseBootstrapFile, 'utf8'), text);
  saveDatabaseSettings(settings);
  assert.deepEqual(JSON.parse(readFileSync(databaseBootstrapFile, 'utf8')), document);
});

test('旧 MySQL、未标明类型和旧加密引导不会被安装表单覆盖', () => {
  for (const document of [
    { version: 2, settings: { ...settings, driver: 'mysql' } },
    { version: 2, settings },
    { version: 1, ciphertext: 'pwenc:v1:不能覆盖' }
  ]) {
    const text = JSON.stringify(document);
    writeFileSync(databaseBootstrapFile, text);
    assert.throws(savedDatabaseSettings, /旧|未标明/);
    assert.throws(() => saveDatabaseSettings(settings), /旧|未标明/);
    assert.equal(readFileSync(databaseBootstrapFile, 'utf8'), text);
  }
});
