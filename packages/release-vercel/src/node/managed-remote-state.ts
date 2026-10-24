import { opendir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Execution } from './execution.js';
import type { FrozenSource, ManagedPaths, ManagedState } from './release-context.js';
import { assertPathChain, pathExists, readBoundedJson } from './managed-io.js';
import { readManagedDisposition } from './managed-disposition.js';
import { readRetirementRecord } from './retirement-record.js';
import { parseManagedState } from './managed-state.js';
import { assertHistoricalSource, frozenSource, observeRefsForDisposition, readManagedLocation } from './managed-recovery.js';
import { record, ReleaseError } from './errors.js';
import { assertManagedHistory } from './managed-history.js';

/** 每次新的远端写入前重新观察全部历史未决意图；本地 check 不会抹去它们。 */
export async function assertManagedRemoteSettled(paths: ManagedPaths, execution: Execution,
  intent?: { readonly effect: 'developmentPush' | 'releasePush'; readonly source: FrozenSource }): Promise<'already-current' | undefined> {
  const active = record(await readBoundedJson(paths.statePath));
  const state = parseManagedState(active, active.source as ManagedState['source'], String(active.slotId));
  await assertManagedHistory(paths, state);
  let count = 0, alreadyCurrent = false;
  for (const kind of ['history', 'retired'] as const) {
    const directory = resolve(paths.slotRoot, kind); await assertPathChain(paths.slotRoot, directory);
    if (!await pathExists(directory)) continue;
    for await (const entry of await opendir(directory)) {
      if (++count > 10_000) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'HISTORY_LIMIT' });
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/u.test(entry.name)) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_ENTRY' });
      let state: ManagedState;
      if (kind === 'history') {
        const evidence = await readManagedDisposition(paths, entry.name.slice(0, -5));
        if (!evidence) throw new ReleaseError('SLOT_STATE', { reason: 'HISTORY_MISSING' });
        state = evidence.stopped;
      } else {
        const evidence = await readRetirementRecord(resolve(directory, entry.name), paths);
        if (!evidence?.final) throw new ReleaseError('RECOVERY_REQUIRED', { reason: 'RETIREMENT_INCOMPLETE' });
        const value: unknown = JSON.parse(evidence.snapshot.state), source = record(value).source as ManagedState['source'];
        state = parseManagedState(value, source, evidence.slotId);
      }
      const unresolved = (['developmentPush', 'releasePush'] as const).filter(effect => state.effects[effect] === 'unknown' || state.pendingPush === effect);
      if (unresolved.length === 0) continue;
      const location = await readManagedLocation(paths.sourceRoot, state.source.configPath);
      frozenSource(state.source, location);
      await assertHistoricalSource(state.source, execution.signal);
      const refs = await observeRefsForDisposition(execution, state.source, { owner: 'inactive', processes: 'closed', knownCount: 0 });
      for (const effect of unresolved) {
        const ref = effect === 'developmentPush' ? refs.developmentRef : refs.releaseRef;
        if (!ref || !['candidate', 'superseded'].includes(ref.relation)) throw new ReleaseError('RECOVERY_REQUIRED', {
          reason: 'REMOTE_EFFECT_UNRESOLVED', runId: state.runId, effect, relation: ref?.relation ?? 'unknown', sha: ref?.sha ?? '',
        });
        const branch = effect === 'developmentPush' ? 'developmentBranch' : 'releaseBranch';
        if (intent?.effect === effect && intent.source.sha === state.source.sha && ref.relation === 'candidate'
          && intent.source.config.git[branch] === state.source.config.git[branch]
          && intent.source.config.git.repository === state.source.config.git.repository) alreadyCurrent = true;
      }
    }
  }
  return alreadyCurrent ? 'already-current' : undefined;
}
