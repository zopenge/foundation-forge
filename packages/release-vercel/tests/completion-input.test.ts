import { cp, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureCompletionInput, assertCompletionInput } from '../src/node/completion-input.js';
import { assertRecordedPrebuiltArtifact, freezePrebuiltArtifact } from '../src/node/prebuilt-artifact.js';
import { prebuiltFixture } from './helpers/prebuilt-fixture.js';

const fixtures: Awaited<ReturnType<typeof prebuiltFixture>>[] = [];
afterEach(async () => { for (const value of fixtures.splice(0)) await value.dispose(); });
async function fixture() {
  const value = await prebuiltFixture(); fixtures.push(value);
  // 组件只检查真实目录/封存文件身份；不把最小.git目录冒充真实提交。
  await mkdir(resolve(value.root, '.git'));
  const artifact = await freezePrebuiltArtifact(value.root, value.config, value.sha, undefined, async () => {});
  const recorded = { sourceSha: artifact.sourceSha, configSha256: artifact.configSha256, artifactSha256: artifact.artifactSha256,
    fileCount: artifact.files.length + artifact.links.length, byteLength: artifact.byteLength,
    createEffect: 'accepted' as const, promoteEffect: 'accepted' as const, deploymentId: 'dpl_candidate', deploymentUrl: 'https://candidate.vercel.app',
    acceptanceVerified: true, promotionVerified: true };
  return { ...value, recorded };
}
it('retains exact input directory and sealed manifest identities without creating new output', async () => {
  const value = await fixture(), input = await captureCompletionInput(value.root);
  await expect(assertCompletionInput(value.root, input)).resolves.toBeUndefined();
  const before = await readFile(resolve(value.uploadRoot, '.vercel/forge-artifact.json'));
  await assertCompletionInput(value.root, input);
  expect(await readFile(resolve(value.uploadRoot, '.vercel/forge-artifact.json'))).toEqual(before);
});
it.each(['output', '.git'])('rejects an identical-content replacement of the original %s directory', async entry => {
  const value = await fixture(), input = await captureCompletionInput(value.root);
  const path = entry === 'output' ? value.output : resolve(value.root, '.git'), original = `${path}-old`;
  const before = await lstat(path, { bigint: true });
  await rename(path, original); await cp(original, path, { recursive: true });
  expect((await lstat(path, { bigint: true })).ino).not.toBe(before.ino);
  await expect(assertRecordedPrebuiltArtifact(value.root, value.config, value.recorded)).resolves.toBeUndefined();
  await expect(assertCompletionInput(value.root, input)).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
});
it('rejects a resealed manifest even when its parsed artifact content remains equal', async () => {
  const value = await fixture(), input = await captureCompletionInput(value.root);
  const path = resolve(value.uploadRoot, '.vercel/forge-artifact.json');
  await writeFile(path, `${await readFile(path, 'utf8')}\n`);
  await expect(assertRecordedPrebuiltArtifact(value.root, value.config, value.recorded)).resolves.toBeUndefined();
  await expect(assertCompletionInput(value.root, input)).rejects.toMatchObject({ code: 'ARTIFACT_CHANGED' });
});
