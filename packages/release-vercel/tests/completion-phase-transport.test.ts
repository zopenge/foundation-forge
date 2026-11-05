import { afterEach, expect, it, vi } from 'vitest';
import { completionPhaseFixture } from './helpers/completion-phase-fixture.js';
import { request } from '../src/node/vercel.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const filesystem = vi.hoisted(() => ({ blocked: false, calls: 0 }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const intercept = <T extends typeof actual.readFile | typeof actual.writeFile>(operation: T) => new Proxy(operation, {
    apply(target, receiver, args) {
      if (filesystem.blocked && /(?:forge-prebuilt|production-proof)\.json$/u.test(String(args[0]))) {
        filesystem.calls++; return new Promise(() => {});
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  return { ...actual, readFile: intercept(actual.readFile), writeFile: intercept(actual.writeFile) };
});
const owned: Awaited<ReturnType<typeof completionPhaseFixture>>[] = [];
afterEach(async () => { filesystem.blocked = false; filesystem.calls = 0; for (const value of owned.splice(0)) await value.dispose(); });

it('serves the frozen phase cloud input without filesystem work inside its real request deadline', async () => {
  const value = await completionPhaseFixture(); owned.push(value);
  filesystem.blocked = true;
  const url = new URL('https://fixture.example.invalid/.well-known/forge-prebuilt.json');
  url.searchParams.set('artifact', value.session.state.prebuilt?.artifactSha256 ?? 'missing');
  const read = () => request(signal => value.transport.buildInfo(url.href, signal), value.config.limits.requestMs, undefined);
  await expect(read()).resolves.toMatchObject({ sourceSha: value.sha, configSha256: value.source.configSha256,
    artifactSha256: value.session.state.prebuilt?.artifactSha256 });
  expect(filesystem.calls).toBe(0);
  const first = await read();
  if (!first || typeof first !== 'object') throw new Error('phase marker required');
  Object.assign(first, { sourceSha: 'f'.repeat(40) });
  await expect(read()).resolves.toMatchObject({ sourceSha: value.sha });
  url.searchParams.set('artifact', 'f'.repeat(64));
  await expect(read()).rejects.toThrow('unexpected phase cloud observation');
  filesystem.blocked = false;
  await writeFile(resolve(value.engine.uploadRoot, '.vercel/output/static/index.html'), 'changed artifact');
  await expect(value.run()).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
  expect(value.session.state.processes).toEqual([]);
});
