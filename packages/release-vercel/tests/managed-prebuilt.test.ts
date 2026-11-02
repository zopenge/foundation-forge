import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRelease } from '../src/node.js';
import { managedFixture } from './helpers/managed-fixture.js';

const build = 'const f=require("node:fs");f.mkdirSync(".vercel/output/static",{recursive:true});f.writeFileSync(".vercel/output/config.json",JSON.stringify({version:3}));f.writeFileSync(".vercel/output/static/index.html","candidate");';

describe('managed prebuilt lifecycle', () => {
  it('freezes a real committed build in the existing fixed slot and closes every owned process without cloud writes', async () => {
    const fixture = await managedFixture();
    try {
      if (fixture.config.source.mode !== 'managed-commit') throw new Error('managed source required');
      const config = { ...fixture.config, delivery: { mode: 'prebuilt', maxFiles: 100, maxBytes: 1_048_576,
        concurrencyControl: { mode: 'external-serialization', scope: 'fixture-project' },
        admission: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] },
      source: { ...fixture.config.source, prepare: [{ command: 'node', args: ['-e', build] }] } };
      await writeFile(resolve(fixture.cwd, 'release.config.json'), JSON.stringify(config));
      await writeFile(resolve(fixture.cwd, '.gitignore'), '.tmp/\nnode_modules/\n.vercel/\n');
      const sha = fixture.commit();
      const transport = { api: async () => { throw new Error('check must not use the cloud'); },
        buildInfo: async () => { throw new Error('check must not use the cloud'); } };
      const result = await runRelease({ command: 'check', cwd: fixture.cwd, transport });
      expect(result).toMatchObject({ ok: true, candidateSha: sha, processes: { status: 'closed' },
        prebuilt: { sourceSha: sha, fileCount: 2, createEffect: 'not-attempted', promoteEffect: 'not-attempted' } });
      const state = JSON.parse(await readFile(resolve(fixture.cwd, '.tmp/release-slot/state.json'), 'utf8'));
      expect(state.prebuilt).toEqual(result.prebuilt);
      expect(state.processes.every((item: { status: string }) => item.status === 'closed')).toBe(true);
      expect(fixture.ref('dev')).toBe(fixture.initial); expect(fixture.ref('main')).toBe(fixture.initial);
      const again = await runRelease({ command: 'check', cwd: fixture.cwd, transport });
      expect(again.ok).toBe(true); expect(again.prebuilt?.artifactSha256).toBe(result.prebuilt?.artifactSha256);
    } finally { await fixture.dispose(); }
  }, 180_000);
});
