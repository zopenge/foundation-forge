import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { validateReleaseConfig } from '../src/node/config.js';
import { isUnstartedRetirementSnapshot } from '../src/node/unstarted-retirement.js';
import { parseRetirementRecord, retirementDigest, sealRetirementRecord } from '../src/node/retirement-record.js';
import type { RetirementHost } from '../src/node/retirement-host.js';

// 自包含的历史协议输入；其中empty与文件身份是合成数据，不冒充真实OS停止证明。
const fixture = (command: 'publish' | 'check' = 'publish') => {
  const root = resolve(import.meta.dirname, '../../../.tmp/unstarted-retirement-fixture');
  const runId = '10000000-0000-4000-8000-000000000001', slotId = '20000000-0000-4000-8000-000000000001';
  const commandId = '30000000-0000-4000-8000-000000000001', nonce = '40000000-0000-4000-8000-000000000001';
  const config = validateReleaseConfig({ schemaVersion: 2,
    source: { mode: 'managed-commit', slotPath: '.tmp/release-slot', maxBytes: 2 ** 31, minFreeBytes: 5 * 2 ** 30,
      sampleIntervalMs: 250, install: { packageManager: 'pnpm' }, prepare: [] },
    git: { remote: 'origin', repository: 'github.com/fixture/repository', developmentBranch: 'dev', releaseBranch: 'main' },
    vercel: { teamId: 'team_fixture', projectId: 'prj_fixture', productionUrl: 'https://fixture.example.invalid' },
    checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }], acceptance: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
    buildInfo: { path: '/build-info.json', revisionField: 'revision' },
    limits: { commandMs: 600000, deploymentMs: 1000, pollMs: 20, requestMs: 1000, maxOutputBytes: 4096 } });
  const source = { root, sha: 'a'.repeat(40), configPath: 'release.config.json', config, configSha256: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    configBlobOid: 'c'.repeat(40), fetchUrl: 'https://github.com/fixture/repository.git' };
  const effects = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  const coordinator = { pid: 1234, startToken: '/Date(1000)/' }, at = '2026-11-09T02:01:28.193Z';
  const state = { schemaVersion: 3, slotId, runId, source, command, coordinator,
    host: { platform: 'win32', hostId: 'd'.repeat(64), uptimeSeconds: 2534.531 }, history: [], stage: 'checkout', status: 'unknown', effects,
    processes: [{ id: commandId, name: 'git', status: 'unknown', descendants: [], observationComplete: false,
      closure: { observedAt: at, exitCode: null, termination: 'termination-failure', requestedTermination: 'abort',
        ownedScope: { scopeId: '50000000-0000-4000-8000-000000000001', binding: `${runId}:${commandId}:${nonce}`,
          observedAt: at, status: 'unknown', reason: 'provider-failed', empty: true } } }] };
  const slotPath = resolve(root, '.tmp/release-slot');
  const report = { schemaVersion: 2, command, ok: false, runId, slotId, sourceRoot: root, executionRoot: resolve(slotPath, 'checkout'),
    configPath: source.configPath, candidateSha: source.sha, configSha256: source.configSha256,
    startedAt: '2026-11-09T01:59:34.909Z', finishedAt: '2026-11-09T02:02:16.596Z', stage: 'checkout', effects, steps: [],
    processes: { status: 'unknown', knownCount: 0 }, error: { code: 'PROCESS_STATE_UNKNOWN', details: { reason: 'CLOSURE_UNPROVEN',
      commandId, step: 'git', termination: 'termination-failure', exitCode: null, identified: false, scopeReason: 'provider-failed', empty: true,
      diagnostics: [{ code: 'COMMAND_SCOPE_FAILED', stage: 'provider' }, { code: 'COMMAND_SCOPE_UNKNOWN' }] } } };
  const receipt = JSON.stringify({ schemaVersion: 2, slotId, source, report });
  return { state: JSON.stringify(state), lock: JSON.stringify({ runId, pid: coordinator.pid, identity: coordinator, token: nonce }),
    owner: JSON.stringify({ schemaVersion: 2, slotId, sourceRoot: root, configPath: source.configPath, repository: config.git.repository,
      sourceIdentity: { dev: '1', ino: '10' }, slotIdentity: { dev: '1', ino: '20' } }),
    anchor: JSON.stringify({ schemaVersion: 2, slotId, sourceRoot: root, configPath: source.configPath, slotPath,
      ...(command === 'publish' ? { latestPublish: { sha: source.sha, runId, configSha256: source.configSha256 } } : {}) }),
    check: command === 'check' ? receipt : null, publish: command === 'publish' ? receipt : null,
    identities: { state: { dev: '1', ino: '30' }, lock: { dev: '1', ino: '31' }, anchor: { dev: '1', ino: '32' }, owner: { dev: '1', ino: '33' } } };
};
type Entry = 'state' | 'lock' | 'owner' | 'anchor' | 'publish';
const mutate = (snapshot: ReturnType<typeof fixture>, entry: Entry, path: string, value: unknown) => {
  const raw: unknown = JSON.parse(snapshot[entry] ?? 'null');
  let selected = raw;
  const parts = path.split('.');
  for (const part of parts.slice(0, -1)) {
    if (!selected || typeof selected !== 'object') throw Error('invalid test mutation path');
    selected = Reflect.get(selected, part) as unknown;
  }
  if (!selected || typeof selected !== 'object') throw Error('invalid test mutation target');
  const key = parts.at(-1) ?? '';
  if (value === undefined) Reflect.deleteProperty(selected, key); else Reflect.set(selected, key, value);
  snapshot[entry] = JSON.stringify(raw);
};

it.each(['publish', 'check'] as const)('recognizes the complete unbound first-Git failure snapshot for %s without changing its bytes', command => {
  const snapshot = fixture(command), before = JSON.stringify(snapshot);
  expect(isUnstartedRetirementSnapshot(snapshot)).toBe(true);
  expect(JSON.stringify(snapshot)).toBe(before);
});

const identity = { pid: 1235, startToken: '/Date(1001)/' };
const cases: Array<[string, Entry, string, unknown]> = [
  ['old protocol', 'state', 'schemaVersion', 2], ['unknown host', 'state', 'host', undefined],
  ['unsupported host proof', 'state', 'host.platform', 'linux'], ['later stage', 'state', 'stage', 'install'],
  ['live state', 'state', 'status', 'running'], ['verification attempt', 'state', 'command', 'verify'],
  ['recorded PID', 'state', 'processes.0.pid', 1235], ['bound identity', 'state', 'processes.0.identity', identity],
  ['bound scope', 'state', 'processes.0.scope', { scopeId: '50000000-0000-4000-8000-000000000001', binding: 'bound' }],
  ['native bound identity', 'state', 'processes.0.closure.ownedScope.rootIdentity', identity],
  ['descendant', 'state', 'processes.0.descendants', [identity]], ['batch', 'state', 'processes.0.kind', 'checkout-observation'],
  ['batch observations', 'state', 'processes.0.observations', []], ['terminal', 'state', 'processes.0.terminalSha256', 'e'.repeat(64)],
  ['contradictory witness', 'state', 'processes.0.notStarted', { schemaVersion: 1 }],
  ['observed command', 'state', 'processes.0.observationComplete', true], ['different command', 'state', 'processes.0.name', 'install'],
  ['normal exit', 'state', 'processes.0.closure.exitCode', 0], ['timeout', 'state', 'processes.0.closure.termination', 'timeout'],
  ['nonempty scope', 'state', 'processes.0.closure.ownedScope.empty', false], ['unknown empty', 'state', 'processes.0.closure.ownedScope.empty', undefined],
  ['different reason', 'state', 'processes.0.closure.ownedScope.reason', 'owner-lost'],
  ['wrong binding', 'state', 'processes.0.closure.ownedScope.binding', '60000000-0000-4000-8000-000000000001:30000000-0000-4000-8000-000000000001:40000000-0000-4000-8000-000000000001'],
  ['push intent', 'state', 'pendingPush', {}], ['deployment intent', 'state', 'prebuilt', {}],
  ['completion intent', 'state', 'completion', {}], ['completion input', 'state', 'completionInput', {}],
  ['remote effect', 'state', 'effects.developmentPush', 'unknown'], ['cloud effect', 'state', 'effects.deploymentCreate', 'accepted'],
  ['wrong receipt run', 'publish', 'report.runId', '60000000-0000-4000-8000-000000000001'],
  ['wrong receipt slot', 'publish', 'report.slotId', '60000000-0000-4000-8000-000000000001'],
  ['wrong receipt operation', 'publish', 'report.command', 'check'], ['successful report', 'publish', 'report.ok', true],
  ['wrong source', 'publish', 'source.root', 'other'], ['wrong candidate', 'publish', 'report.candidateSha', 'f'.repeat(40)],
  ['wrong error command', 'publish', 'report.error.details.commandId', '60000000-0000-4000-8000-000000000001'],
  ['identified report', 'publish', 'report.error.details.identified', true], ['report effect', 'publish', 'report.effects.releasePush', 'pushed'],
  ['report deployment', 'publish', 'report.deployment', {}], ['missing provider failure', 'publish', 'report.error.details.diagnostics', []],
  ['wrong lock', 'lock', 'runId', '60000000-0000-4000-8000-000000000001'], ['wrong owner', 'owner', 'slotId', '60000000-0000-4000-8000-000000000001'],
  ['wrong anchor', 'anchor', 'latestPublish.runId', '60000000-0000-4000-8000-000000000001'],
];
it.each(cases)('rejects %s instead of interpreting unknown as safe to abandon', (_name, entry, path, value) => {
  const snapshot = fixture(); mutate(snapshot, entry, path, value);
  expect(isUnstartedRetirementSnapshot(snapshot)).toBe(false);
});
it('rejects a second command, missing receipt and malformed snapshot', () => {
  const snapshot = fixture(), state = JSON.parse(snapshot.state) as { processes: unknown[] };
  state.processes.push(structuredClone(state.processes[0])); snapshot.state = JSON.stringify(state);
  expect(isUnstartedRetirementSnapshot(snapshot)).toBe(false);
  const missing = fixture(); missing.publish = null; expect(isUnstartedRetirementSnapshot(missing)).toBe(false);
  const broken = fixture(); broken.state = '{'; expect(isUnstartedRetirementSnapshot(broken)).toBe(false);
});

const archive = (snapshot = fixture()) => {
  const state = JSON.parse(snapshot.state) as { runId: string; slotId: string; host: RetirementHost };
  return sealRetirementRecord({ schemaVersion: 1, kind: 'interrupted-run-retirement', runId: state.runId, slotId: state.slotId,
    snapshot, snapshotSha256: retirementDigest(snapshot), origin: 'recorded-run-host', host: state.host,
    preparedAt: '2026-11-09T08:10:00.000Z', final: { host: { ...state.host, uptimeSeconds: state.host.uptimeSeconds + 100 },
      retiredAt: '2026-11-09T08:11:00.000Z', cessation: 'recorded-empty-unstarted-scope',
      observation: { owner: 'inactive', processes: 'unknown', observedAt: '2026-11-09T08:11:00.000Z',
        developmentRef: { sha: '', relation: 'unknown' }, releaseRef: { sha: '', relation: 'unknown' } } } });
};
it('validates a same-boot archive from its complete original failure snapshot and explicit cessation', () => {
  const value = archive();
  expect(parseRetirementRecord(value)).toEqual(value);
  expect(value.final?.cessation).toBe('recorded-empty-unstarted-scope');
});
it('retains the old subsequent-boot archive rule when no new cessation tag exists', () => {
  const value = archive();
  if (!value.final) throw Error('fixture final missing');
  Reflect.deleteProperty(value.final, 'cessation');
  expect(() => parseRetirementRecord(sealRetirementRecord(value))).toThrowError(expect.objectContaining({ code: 'SLOT_STATE' }));
  Reflect.set(value.final.host, 'uptimeSeconds', 1);
  expect(parseRetirementRecord(sealRetirementRecord(value)).final?.host.uptimeSeconds).toBe(1);
});
it.each(['unknown-tag', 'operator-origin', 'host-mismatch', 'snapshot-host-mismatch', 'wrong-receipt', 'bound-root', 'wrong-run', 'wrong-slot'])(
  'rejects a checksum-consistent but ineligible abandonment archive: %s', kind => {
    const snapshot = fixture();
    if (kind === 'wrong-receipt') mutate(snapshot, 'publish', 'report.runId', '60000000-0000-4000-8000-000000000001');
    if (kind === 'bound-root') mutate(snapshot, 'state', 'processes.0.closure.ownedScope.rootIdentity', identity);
    const value = archive(snapshot);
    if (!value.final) throw Error('fixture final missing');
    if (kind === 'unknown-tag') {
      Reflect.set(value.final, 'cessation', 'operator-reset'); Reflect.set(value.final.host, 'uptimeSeconds', 1);
    }
    if (kind === 'wrong-run') Reflect.set(value, 'runId', '60000000-0000-4000-8000-000000000001');
    if (kind === 'wrong-slot') Reflect.set(value, 'slotId', '60000000-0000-4000-8000-000000000001');
    if (kind === 'operator-origin') Reflect.set(value, 'origin', 'operator-confirmed-origin');
    if (kind === 'host-mismatch') Reflect.set(value.final.host, 'hostId', 'e'.repeat(64));
    if (kind === 'snapshot-host-mismatch') {
      Reflect.set(value.host, 'hostId', 'e'.repeat(64)); Reflect.set(value.final.host, 'hostId', 'e'.repeat(64));
    }
    expect(() => parseRetirementRecord(sealRetirementRecord(value))).toThrowError(expect.objectContaining({ code: 'SLOT_STATE' }));
  });
