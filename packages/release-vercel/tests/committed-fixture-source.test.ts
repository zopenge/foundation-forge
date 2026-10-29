import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { freezeManagedSource } from '../src/node/source.js';
import { managedFixture } from './helpers/managed-fixture.js';
import { committedFixtureSource } from './helpers/committed-fixture-source.js';

const fixtures: Awaited<ReturnType<typeof managedFixture>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.dispose(); });
const fixture = async () => { const f = await managedFixture(); fixtures.push(f); return f; };

it('prepares the same committed input with only the three required Git observations', async () => {
  const f = await fixture(), expected = await freezeManagedSource(f.cwd, 'release.config.json', f.execution);
  const query = vi.spyOn(f.execution, 'git'), stream = vi.spyOn(f.execution, 'streamGit');
  const prepared = await committedFixtureSource(f, f.sha);
  expect(prepared).toEqual(expected);
  expect(query.mock.calls.length + stream.mock.calls.length).toBeLessThanOrEqual(3);
});

it('reads each new commit instead of reusing a prior configuration or mutable fixture object', async () => {
  const f = await fixture(), original = await committedFixtureSource(f, f.sha);
  Object.assign(f.config, { checks: [{ command: 'node', args: ['-e', 'process.stdout.write("next")'] }] });
  await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config));
  const sha = f.commit(), current = await committedFixtureSource(f, sha);
  expect(current).toEqual(await freezeManagedSource(f.cwd, 'release.config.json', f.execution));
  expect(current.sha).not.toBe(original.sha);
  expect(current.configBlobOid).not.toBe(original.configBlobOid);
  expect(current.configSha256).not.toBe(original.configSha256);
  expect(original.config.checks).toEqual([{ command: 'node', args: ['-e', 'process.stdout.write(process.cwd())'] }]);
});
