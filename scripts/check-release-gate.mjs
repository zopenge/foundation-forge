import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectWorkspaceFingerprint, collectDistDigests, collectTarballDigests } from './check-fingerprint.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

export const fullCheckRequired = reason => Object.assign(new Error('FULL_CHECK_REQUIRED'), {
  code: 'FULL_CHECK_REQUIRED', details: { reason },
});
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const assertFullReceipt = ({ state, current, distDigests, tarballDigests }) => {
  if (state?.validation?.schemaVersion !== 1 || state.validation.kind !== 'full') throw fullCheckRequired('FULL_RECEIPT_MISSING');
  if (!current || !Object.entries(current).every(([key, value]) => same(state[key], value))) throw fullCheckRequired('INPUTS_CHANGED');
  if (!distDigests || !tarballDigests || !same(state.distDigests, distDigests) || !same(state.tarballDigests, tarballDigests))
    throw fullCheckRequired('OUTPUTS_CHANGED');
};
// 发布前独立核对真实文件；普通 quick 结果不能作为此入口的凭证。
export const assertFullCheckReceipt = async (repositoryRoot) => {
  try {
    const cache = resolve(repositoryRoot, '.tmp/check-cache');
    const state = JSON.parse(await readFile(resolve(cache, 'state.json'), 'utf8'));
    if (state?.validation?.schemaVersion !== 1 || state.validation.kind !== 'full') throw fullCheckRequired('FULL_RECEIPT_MISSING');
    const model = await discoverWorkspacePackageModel({ repositoryRoot });
    const current = await collectWorkspaceFingerprint(repositoryRoot);
    assertFullReceipt({ state, current, distDigests: await collectDistDigests(model.packages),
      tarballDigests: await collectTarballDigests(model.packages, resolve(cache, 'packs')) });
  } catch (error) {
    if (error?.code === 'FULL_CHECK_REQUIRED') throw error;
    throw fullCheckRequired('FULL_RECEIPT_UNAVAILABLE');
  }
};
