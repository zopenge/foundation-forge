import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bindArtifactOperation } from '../src/index.js';

const manifest = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, files: [
  { path: 'index.html', byteLength: 4, sha256: createHash('sha256').update('html').digest('hex'),
    role: 'asset', responseHeaders: { 'content-type': 'text/html', 'cache-control': 'no-cache' } },
  { path: '_headers', byteLength: 7, sha256: createHash('sha256').update('headers').digest('hex'), role: 'control' },
] }));
const manifestSha256 = createHash('sha256').update(manifest).digest('hex');
const intent = () => ({ requestId: 'content-1', content: { manifestSha256 },
  target: { provider: 'fixture', namespace: 'artifacts', endpoint: 'https://publish.invalid' },
  capability: 'deployment-ready' as const, configurationSha256: 'b'.repeat(64),
  inputs: [{ name: 'content-manifest.json', sha256: manifestSha256, byteLength: manifest.byteLength }] });

describe('content-bound artifact operations', () => {
  it('accepts an actual content manifest without Git provenance', async () => {
    const binding = await bindArtifactOperation(intent());
    expect(binding).toMatchObject({ content: { manifestSha256 } });
    expect(binding).not.toHaveProperty('sourceCommit');
    expect(binding).not.toHaveProperty('provenance');
    expect(binding.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('binds optional real Git provenance without replacing content identity', async () => {
    const plain = await bindArtifactOperation(intent());
    const git = await bindArtifactOperation({ ...intent(), provenance: { gitRevision: 'a'.repeat(40) } });
    expect(git.content).toEqual(plain.content);
    expect(git.provenance).toEqual({ gitRevision: 'a'.repeat(40) });
    expect(git.fingerprint).not.toBe(plain.fingerprint);
  });

  it('rejects a legacy Git-only input instead of disguising it as content', async () => {
    const { content: omitted, ...rest } = intent();
    void omitted;
    await expect(Reflect.apply(bindArtifactOperation, undefined, [{ ...rest, sourceCommit: 'a'.repeat(40) }]))
      .rejects.toMatchObject({ code: 'INVALID_BINDING' });
  });

  it('snapshots content and provenance before asynchronous hashing', async () => {
    const input = { ...intent(), provenance: { gitRevision: 'a'.repeat(40) } };
    const pending = bindArtifactOperation(input);
    input.content.manifestSha256 = 'c'.repeat(64);
    input.provenance.gitRevision = 'd'.repeat(40);
    const binding = await pending;
    expect(binding.content.manifestSha256).toBe(manifestSha256);
    expect(binding.provenance?.gitRevision).toBe('a'.repeat(40));
    expect(Object.isFrozen(binding.content)).toBe(true);
    expect(Object.isFrozen(binding.provenance)).toBe(true);
  });
});
