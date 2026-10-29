import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { ensureTestTemporaryDirectory } from '../test-temporary-directory.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
for (const mode of ['root-link', 'ancestor-link', 'file', 'create']) {
  test('临时目录纯注入拒绝重解析：' + mode, async () => {
    const root = resolve(repositoryRoot, 'injected-repository'), created = [];
    const target = resolve(root, '.tmp/work/log'), known = new Set(mode === 'create' ? [] : [resolve(root, '.tmp'), resolve(root, '.tmp/work')]);
    const io = {
      realpath: async path => path,
      mkdir: async path => { created.push(path); known.add(path); },
      lstat: async path => {
        if (!known.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        const linked = (mode === 'root-link' && path === resolve(root, '.tmp')) || (mode === 'ancestor-link' && path === resolve(root, '.tmp/work'));
        return { isSymbolicLink: () => linked, isDirectory: () => !linked && mode !== 'file' };
      },
    };
    if (mode === 'create') {
      assert.equal(await ensureTestTemporaryDirectory(root, target, io), target);
      assert.deepEqual(created, [resolve(root, '.tmp'), resolve(root, '.tmp/work'), target]);
    } else {
      await assert.rejects(ensureTestTemporaryDirectory(root, target, io), /plain directory/u);
      assert.deepEqual(created, []);
    }
  });
}

for (const layer of ['root', 'ancestor']) {
  test('原生临时目录 junction 保护独立哨兵：' + layer, async t => {
    const parent = await ensureTestTemporaryDirectory(repositoryRoot, resolve(repositoryRoot, '.tmp/tests'));
    const owned = await mkdtemp(resolve(parent, 'temporary-guard-'));
    const ownedIdentity = await lstat(owned, { bigint: true }), canonicalOwned = await realpath(owned);
    const simulatedRepository = resolve(owned, 'repository'), survivor = resolve(owned, 'survivor');
    let link;
    t.after(async () => {
      if (link) { const item = await lstat(link).catch(error => { if (error.code !== 'ENOENT') throw error; }); if (item) { assert.equal(item.isSymbolicLink(), true); await unlink(link); } }
      const item = await lstat(owned, { bigint: true });
      assert.equal(item.dev, ownedIdentity.dev); assert.equal(item.ino, ownedIdentity.ino);
      assert.equal(await realpath(owned), canonicalOwned);
      await rm(owned, { recursive: true, force: true });
    });
    await mkdir(simulatedRepository); await mkdir(survivor);
    const sentinel = resolve(survivor, 'sentinel');
    await writeFile(sentinel, 'independent fixture; preserve');
    if (layer === 'ancestor') await mkdir(resolve(simulatedRepository, '.tmp'));
    link = resolve(simulatedRepository, layer === 'root' ? '.tmp' : '.tmp/test-work');
    await symlink(survivor, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(ensureTestTemporaryDirectory(simulatedRepository, resolve(simulatedRepository, '.tmp/test-work/new')), /plain directory/u);
    assert.equal(await readFile(sentinel, 'utf8'), 'independent fixture; preserve');
    await assert.rejects(lstat(resolve(survivor, layer === 'root' ? 'test-work' : 'new')), { code: 'ENOENT' });
  });
}
