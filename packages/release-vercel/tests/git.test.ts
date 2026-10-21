import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { normalizeRepository } from '../src/node/git.js';

it('keeps distinct local .git directory names distinct', () => {
  const cwd = resolve(import.meta.dirname, '../../..');
  expect(normalizeRepository('./repo.git', cwd)).not.toBe(normalizeRepository('./repo', cwd));
  expect(normalizeRepository(pathToFileURL(resolve(cwd, 'repo.git')).href, cwd)).toBe(normalizeRepository('./repo.git', cwd));
});
it('keeps non-default network ports distinct', () => {
  const cwd = resolve(import.meta.dirname, '../../..');
  expect(normalizeRepository('https://git.example.invalid:8443/org/repo.git', cwd))
    .not.toBe(normalizeRepository('https://git.example.invalid/org/repo.git', cwd));
});
