import { opendir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ManagedHistoryReference, ManagedPaths, ManagedState } from './release-context.js';
import { assertPathChain, pathExists, readBoundedJson } from './managed-io.js';
import { assertMetadataFile, assertMetadataPaths, inspectMetadataFile } from './managed-metadata.js';
import { parseManagedDisposition } from './managed-disposition.js';
import { parseRetirementRecord } from './retirement-record.js';
import { ReleaseError } from './errors.js';

export const historyFileLimit = 8_388_608;
/** 新活动状态绑定已有历史的内容与文件身份；清单缺失不能被理解为没有旧意图。 */
export async function captureManagedHistory(paths: ManagedPaths): Promise<ManagedHistoryReference[]> {
  await assertMetadataPaths(paths);
  const result: ManagedHistoryReference[] = [];
  for (const kind of ['history', 'retired'] as const) {
    const directory = resolve(paths.slotRoot, kind); await assertPathChain(paths.slotRoot, directory);
    if (!await pathExists(directory)) continue;
    for await (const entry of await opendir(directory)) {
      if (result.length >= 10_000) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_LIMIT' });
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/u.test(entry.name)) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_ENTRY' });
      const name = `${kind}/${entry.name}`, path = resolve(paths.slotRoot, name), file = await inspectMetadataFile(path, historyFileLimit);
      if (!file) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_MISSING' });
      const value = await readBoundedJson(path, historyFileLimit);
      const evidence = kind === 'history' ? parseManagedDisposition(value) : parseRetirementRecord(value);
      if (`${evidence.runId}.json` !== entry.name) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_NAME' });
      await assertMetadataFile(path, file, historyFileLimit); result.push({ path: name, file });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function assertManagedHistory(paths: ManagedPaths, state: ManagedState): Promise<void> {
  await assertMetadataPaths(paths);
  if (state.schemaVersion === 2) return;
  if (!state.history) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_BINDING_MISSING' });
  for (const entry of state.history) {
    const path = resolve(paths.slotRoot, entry.path); await assertPathChain(paths.slotRoot, path);
    await assertMetadataFile(path, entry.file, historyFileLimit);
  }
}
