import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { git, managedFixture } from './helpers/managed-fixture.js';
import { freezeManagedSource } from '../src/node/source.js';
import { openManagedSlot } from '../src/node/managed-paths.js';
import { createManagedSession } from '../src/node/managed-process.js';
import { runRelease } from '../src/node.js';
import type { ReleaseReport, ReleaseTransport } from '../src/contracts.js';

it('archives a cancelled verification and releases only its stopped scope without changing publish selection', { timeout: 180_000 }, async () => {
  const f = await managedFixture(), controller = new AbortController(); let pending: Promise<ReleaseReport> | undefined;
  try {
    const declared = 'https://github.com/fixture/repository.git';
    git(f.cwd, 'config', `url.${f.remote.replaceAll('\\', '/')}.insteadOf`, declared); git(f.cwd, 'remote', 'set-url', 'origin', declared);
    Object.assign(f.config.git, { repository: 'github.com/fixture/repository' });
    Object.assign(f.config, { acceptance: [{ command: 'node', args: ['-e', 'const fs=require("node:fs");fs.mkdirSync("node_modules",{recursive:true});fs.writeFileSync("node_modules/verify-started","ready");setInterval(()=>{},100)'] }] });
    await writeFile(resolve(f.cwd, 'release.config.json'), JSON.stringify(f.config)); f.commit();
    const source = await freezeManagedSource(f.cwd, 'release.config.json', f.execution), slot = await openManagedSlot(source, f.execution);
    await slot.store.writeAnchor({ schemaVersion: 2, slotId: slot.slotId, slotPath: slot.paths.slotRoot, sourceRoot: source.root, configPath: source.configPath,
      latestPublish: { sha: source.sha, runId: slot.runId, configSha256: source.configSha256 } });
    const session = await createManagedSession(slot, 'publish'); session.state.status = 'closed'; await session.persist();
    const now = new Date().toISOString();
    await slot.store.writeReceipt('publish', { schemaVersion: 2, slotId: slot.slotId, source, report: { schemaVersion: 2, command: 'publish', ok: true,
      runId: slot.runId, slotId: slot.slotId, candidateSha: source.sha, configSha256: source.configSha256, startedAt: now, finishedAt: now,
      steps: [], effects: { developmentPush: 'already-current', releasePush: 'already-current' } } });
    await slot.lock.release();
    git(f.root, 'clone', '--no-local', f.cwd, slot.paths.checkoutRoot); git(slot.paths.checkoutRoot, 'remote', 'set-url', 'origin', declared);
    const receiptPath = resolve(slot.paths.slotRoot, 'latest-publish.json'), before = await readFile(receiptPath);
    const deployment = { id: 'dpl_fixture', projectId: 'prj_fixture', target: 'production', readyState: 'READY', source: 'git',
      gitSource: { type: 'github', repoId: 101, org: 'fixture', repo: 'repository', sha: source.sha, ref: 'main' }, url: 'fixture.vercel.app' };
    const transport: ReleaseTransport = { api: async path => {
      if (path.startsWith('/v9/projects')) return { id: 'prj_fixture', accountId: 'team_fixture', link: { type: 'github', org: 'fixture', repo: 'repository', repoId: 101, productionBranch: 'main', gitCredentialId: 'fixture', deployHooks: [] } };
      if (path.startsWith('/v6/deployments')) return { deployments: [deployment] };
      if (path.startsWith('/v13/deployments')) return deployment;
      if (path.startsWith('/v4/aliases')) return { alias: 'fixture.example.invalid', deploymentId: deployment.id, projectId: deployment.projectId };
      throw new Error('unexpected API');
    }, buildInfo: async () => ({ revision: source.sha }) };
    pending = runRelease({ cwd: f.cwd, command: 'verify', transport, signal: controller.signal });
    const marker = resolve(slot.paths.checkoutRoot, 'node_modules/verify-started'), deadline = Date.now() + 120_000;
    for (;;) {
      try { await readFile(marker); break; } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (Date.now() > deadline) throw new Error('verification marker timeout');
      const early = await Promise.race([pending.then(report => ({ report })), new Promise<undefined>(accept => setTimeout(accept, 100))]);
      if (early) throw new Error(`verification ended before cancellation: ${JSON.stringify(early.report.error)}`);
    }
    controller.abort(); const report = await pending;
    expect(report, JSON.stringify(report.error)).toMatchObject({ ok: false, error: { code: 'CANCELLED' }, processes: { status: 'closed' } });
    await expect(readFile(slot.paths.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const history = JSON.parse(await readFile(resolve(slot.paths.slotRoot, 'history', `${report.runId}.json`), 'utf8'));
    expect(history.outcome).toMatchObject({ ok: false, command: 'verify', error: { code: 'CANCELLED' } });
    expect(await readFile(receiptPath)).toEqual(before);
  } finally { controller.abort(); await pending; await f.dispose(); }
});
