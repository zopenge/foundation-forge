import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkPolicyRepository } from '../src/node.js';
import { sampleManifest } from './support/sample.js';
import { withPolicyFixture } from './support/node-fixture.js';

const codes = (diagnostics: readonly { readonly code: string }[]) => (
  diagnostics.map((diagnostic) => diagnostic.code)
);

describe('Node repository check', () => {
  it('passes a valid repository without executing declared scripts', async () => {
    await withPolicyFixture(async ({ root, options, write }) => {
      const marker = join(root, 'side-effect.txt');
      const manifest = {
        ...sampleManifest,
        checks: [{
          id: 'danger',
          kind: 'package-script' as const,
          packageJson: 'package.json',
          script: 'danger',
        }],
      };
      await write('.forge/repository-policy.json', JSON.stringify(manifest));
      await write('package.json', JSON.stringify({
        scripts: { danger: 'node -e "require(\'fs\').writeFileSync(\'side-effect.txt\',\'bad\')"' },
      }));
      const report = await checkPolicyRepository(options);
      expect(report.state).toBe('passed');
      expect(report.diagnostics).toEqual([]);
      await expect(import('node:fs/promises').then(({ stat }) => stat(marker))).rejects.toThrow();
    });
  });
  it('rejects duplicate JSON keys instead of last-write-wins', async () => {
    await withPolicyFixture(async ({ options, write }) => {
      const raw = '{"schemaVersion":1,"schemaVersion":1,"factIds":[],"policies":[],"checks":[]}';
      await write('.forge/repository-policy.json', raw);
      const report = await checkPolicyRepository(options);
      expect(codes(report.diagnostics)).toContain('DUPLICATE_JSON_KEY');
    });
  });

  it.each([
    '{"schemaVersion":1,//comment\n"factIds":[],"policies":[],"checks":[]}',
    '{"schemaVersion":1,"factIds":[],"policies":[],"checks":[],}',
  ])('rejects non-strict JSON syntax: %s', async (raw) => {
    await withPolicyFixture(async ({ options, write }) => {
      await write('.forge/repository-policy.json', raw);
      const report = await checkPolicyRepository(options);
      expect(codes(report.diagnostics)).toContain('INVALID_SCHEMA');
    });
  });

  it('rejects invalid UTF-8 in the manifest', async () => {
    await withPolicyFixture(async ({ options, writeBytes }) => {
      await writeBytes('.forge/repository-policy.json', Uint8Array.from([0xff]));
      const report = await checkPolicyRepository(options);
      expect(codes(report.diagnostics)).toContain('INVALID_UTF8');
    });
  });
  it('allows one leading UTF-8 BOM in the manifest', async () => {
    await withPolicyFixture(async ({ options, writeBytes }) => {
      const json = Buffer.from(JSON.stringify(sampleManifest), 'utf8');
      await writeBytes(
        '.forge/repository-policy.json',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json]),
      );
      const report = await checkPolicyRepository(options);
      expect(report.state).toBe('passed');
    });
  });

  it('distinguishes missing manifest and directory-as-file', async () => {
    await withPolicyFixture(async ({ root, options, remove }) => {
      await remove('.forge/repository-policy.json');
      const missing = await checkPolicyRepository(options);
      expect(codes(missing.diagnostics)).toContain('SOURCE_MISSING');

      await mkdir(join(root, '.forge', 'repository-policy.json'), { recursive: true });
      const directory = await checkPolicyRepository(options);
      expect(codes(directory.diagnostics)).toContain('SOURCE_UNREADABLE');
    });
  });

  it('reports a missing policy source', async () => {
    await withPolicyFixture(async ({ options, remove }) => {
      await remove('rules/base.md');
      const report = await checkPolicyRepository(options);
      expect(codes(report.diagnostics)).toContain('SOURCE_MISSING');
    });
  });
  it('reports a directory used as a policy source', async () => {
    await withPolicyFixture(async ({ root, options, remove }) => {
      await remove('rules/base.md');
      await mkdir(join(root, 'rules', 'base.md'));
      const report = await checkPolicyRepository(options);
      expect(codes(report.diagnostics)).toContain('SOURCE_UNREADABLE');
    });
  });

  it('reports a missing package script without running anything', async () => {
    await withPolicyFixture(async ({ options, write }) => {
      const manifest = {
        ...sampleManifest,
        checks: [{
          id: 'lint',
          kind: 'package-script' as const,
          packageJson: 'package.json',
          script: 'lint',
        }],
      };
      await write('.forge/repository-policy.json', JSON.stringify(manifest));
      await write('package.json', JSON.stringify({ scripts: {} }));
      const report = await checkPolicyRepository(options);
      expect(codes(report.diagnostics)).toContain('CHECK_TARGET_MISSING');
    });
  });

  it('enforces manifest byte limits before parsing', async () => {
    await withPolicyFixture(async ({ options }) => {
      const report = await checkPolicyRepository({
        ...options,
        limits: { manifestBytes: 16 },
      });
      expect(codes(report.diagnostics)).toContain('INPUT_LIMIT');
    });
  });

  it('rejects URI manifest paths without treating them as local files', async () => {
    await withPolicyFixture(async ({ options }) => {
      const report = await checkPolicyRepository({
        ...options,
        manifestPath: 'https://example.invalid/policy.json',
      });
      expect(codes(report.diagnostics)).toContain('INVALID_PATH');
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid read limits before source I/O: %s',
    async (manifestBytes) => {
      await withPolicyFixture(async ({ options, remove }) => {
        await remove('.forge/repository-policy.json');
        const report = await checkPolicyRepository({
          ...options,
          limits: { manifestBytes },
        });
        expect(codes(report.diagnostics)).toEqual(['INPUT_LIMIT']);
      });
    },
  );

  it('observes missing-to-existing source transitions on a new check', async () => {
    await withPolicyFixture(async ({ options, remove, write }) => {
      await remove('rules/base.md');
      const missing = await checkPolicyRepository(options);
      expect(codes(missing.diagnostics)).toContain('SOURCE_MISSING');

      await write('rules/base.md', 'base restored\n');
      const restored = await checkPolicyRepository(options);
      expect(restored.state).toBe('passed');
      expect(restored.diagnostics).toEqual([]);
    });
  });

  it('rejects a case alias on case-insensitive filesystems', async () => {
    if (process.platform !== 'win32') return;
    await withPolicyFixture(async ({ options, write }) => {
      const manifest = {
        ...sampleManifest,
        policies: sampleManifest.policies.map((item) => (
          item.id === 'base'
            ? { ...item, source: { path: 'rules/Base.md' } }
            : item
        )),
      };
      await write('.forge/repository-policy.json', JSON.stringify(manifest));
      const report = await checkPolicyRepository(options);
      expect(codes(report.diagnostics)).toContain('INVALID_PATH');
    });
  });
});
