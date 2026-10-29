import assert from 'node:assert/strict';
import test from 'node:test';

if (process.env.FORGE_ISOLATION_AUDIT_WORKER === '1') {
  const boundary = { permissionEnabled: process.permission !== undefined,
    privateWriteAllowed: process.permission?.has('fs.write', process.env.FORGE_CHECK_JOB_TEMP),
    nodeOptionsPresent: !!process.env.NODE_OPTIONS };
  process.stdout.write(`FORGE_AUDIT_WORKER_BOUNDARY ${JSON.stringify(boundary)}\n`);
  assert.deepEqual(boundary, { permissionEnabled: true, privateWriteAllowed: false, nodeOptionsPresent: false });
}

test('隔离审计规范化固定键且拒绝缺失、冲突和非字符串，不记录环境正文', async () => {
  const { auditIsolationEnvironment, isolationEnvironmentNames } = await import('../test-isolation-audit.mjs');
  const expected = Object.fromEntries(isolationEnvironmentNames.map((name, index) => [name, `private-value-${index}`]));
  const upper = Object.fromEntries(Object.entries(expected).map(([name, value]) => [name.toUpperCase(), value]));
  const inspect = actual => auditIsolationEnvironment({ expected, actual, platform: 'win32' });
  const good = inspect(upper);
  assert.equal(good.matches, true);
  assert.equal(good.fields.length, isolationEnvironmentNames.length);
  assert.ok(good.fields.every(field => field.present && field.match && !field.conflict));
  assert.equal(inspect({ ...upper, npm_config_store_dir: expected.npm_config_store_dir }).matches, true);

  const conflict = inspect({ ...upper, npm_config_store_dir: 'secret-other-store' });
  assert.equal(conflict.matches, false);
  assert.equal(conflict.fields.find(field => field.name === 'NPM_CONFIG_STORE_DIR').conflict, true);
  const missing = { ...upper }; delete missing.TEMP;
  assert.equal(inspect(missing).fields.find(field => field.name === 'TEMP').present, false);
  assert.equal(inspect({ ...upper, TEMP: 3 }).matches, false);
  assert.equal(auditIsolationEnvironment({ expected, actual: upper, platform: 'posix' }).matches, false);
  assert.equal(auditIsolationEnvironment({ expected, actual: expected, platform: 'posix' }).matches, true);
  assert.equal(auditIsolationEnvironment({ expected, actual: null, platform: 'win32' }).matches, false);
  assert.equal(auditIsolationEnvironment({ expected: { ...expected, EXTRA_SECRET: 'secret-expected' }, actual: upper, platform: 'win32' }).matches, false);

  const encoded = JSON.stringify([good, conflict, inspect({ ...upper, API_TOKEN: 'secret-token' })]);
  for (const value of [...Object.values(expected), 'secret-other-store', 'secret-token', 'API_TOKEN', 'secret-expected']) assert.equal(encoded.includes(value), false);
});
