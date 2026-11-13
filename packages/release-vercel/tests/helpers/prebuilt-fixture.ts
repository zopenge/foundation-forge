import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureTestTemporaryDirectory } from '../../../../scripts/test-temporary-directory.mjs';
import type { PrebuiltReleaseState, ReleaseReport, ReleaseTransport } from '../../src/contracts.js';
import type { ExecutionContext } from '../../src/node/release-context.js';
import { Execution } from '../../src/node/execution.js';
import { assertActive, ReleaseError } from '../../src/node/errors.js';
import { prebuiltConfiguration } from './prebuilt-configuration.js';

/** 真实文件系统与发布引擎；仅替换不会在普通测试中授权的云端和 CLI 写入边界。 */
export async function prebuiltFixture({ sha = 'a'.repeat(40), config = prebuiltConfiguration(), root: callerRoot,
  deployment = { id: 'dpl_candidate', hostname: 'candidate.vercel.app' } }:
  { sha?: string; config?: ReturnType<typeof prebuiltConfiguration>; root?: string;
    deployment?: { id: string; hostname: string } } = {}) {
  const repository = resolve(import.meta.dirname, '../../../..');
  const base = await ensureTestTemporaryDirectory(repository, resolve(repository, 'tmp/prebuilt-tests'));
  const root = callerRoot ? await ensureTestTemporaryDirectory(repository, callerRoot) : await mkdtemp(resolve(base, 'r-'));
  const dispose = async () => { if (!callerRoot) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); };
  const trace: string[] = [], snapshots: PrebuiltReleaseState[] = [];
  const output = resolve(root, '.vercel/output'), uploadRoot = resolve(root, 'state/forge-vercel-release/prebuilt');
  const controller = new AbortController();
  const effects: ReleaseReport['effects'] = { developmentPush: 'not-attempted', releasePush: 'not-attempted' };
  const hooks: {
    run?: (name: string, values?: Readonly<Record<string, string>>) => void | Promise<void>;
    frozen?: () => void | Promise<void>;
    api?: (path: string, response: Record<string, unknown>) => unknown;
    marker?: (value: unknown) => unknown;
    promote?: (signal: AbortSignal) => void | Promise<void>;
    save?: () => void | Promise<void>;
    created?: () => void | Promise<void>;
  } = {};
  let creates = 0, promotions = 0, aliased = false;
  class BoundaryExecution extends Execution {
    override async git(): Promise<string> { throw new Error('prebuilt publication must not execute Git mutations or Git integration probes'); }
    override async streamGit(): Promise<void> { throw new Error('prebuilt publication must not execute Git streams'); }
    override async run(name: string, check: Parameters<Execution['run']>[1], code: Parameters<Execution['run']>[2],
      values?: Readonly<Record<string, string>>, signal = controller.signal): Promise<string> {
      if (name !== 'prebuilt-create') {
        const ordinary = /^(check|acceptance):(\d+)$/u.exec(name), admission = /^admission:(create|version-alias|promote):(\d+)$/u.exec(name);
        const expected = ordinary ? (ordinary[1] === 'check' ? config.checks : config.acceptance)[Number(ordinary[2])]
          : admission ? config.delivery.admission[Number(admission[2])] : undefined;
        const expectedCode = ordinary ? ordinary[1] === 'check' ? 'CHECK_FAILED' : 'ACCEPTANCE_FAILED' : 'ADMISSION_FAILED';
        if (!expected || JSON.stringify(check) !== JSON.stringify(expected) || code !== expectedCode) throw new Error('unexpected phase command');
      }
      assertActive(signal); trace.push(`run:${name}`); await hooks.run?.(name, values);
      if (name === 'prebuilt-create') {
        const args = check.args ?? [];
        const configuration = args[args.indexOf('--global-config') + 1];
        if (!args.includes('--global-config') || !configuration || values?.XDG_CACHE_HOME !== configuration
          || values.APPDATA !== configuration || values.LOCALAPPDATA !== configuration) throw new Error('prebuilt CLI configuration must be private');
        if (JSON.parse(await readFile(resolve(configuration, 'config.json'), 'utf8')).currentTeam !== 'team_fixture') throw new Error('wrong private CLI team');
        const expected = ['deploy', '--prebuilt', '--archive=tgz', '--prod', '--skip-domain', '--no-wait', '--json', '--non-interactive',
          '--project', 'prj_fixture', '--scope', 'team_fixture'];
        if (this.cwd !== uploadRoot || JSON.stringify(args.slice(-expected.length)) !== JSON.stringify(expected) || code !== 'VERCEL_API') {
          throw new Error(`unexpected staging invocation: ${JSON.stringify({ cwd: this.cwd, args, code })}`);
        }
        creates++;
        await hooks.created?.();
        return JSON.stringify({ status: 'ok', deployment: { id: deployment.id, url: `https://${deployment.hostname}`, target: 'production', readyState: 'QUEUED' } });
      }
      return '';
    }
  }
  const executionAt = (cwd: string) => new BoundaryExecution(cwd, config, controller.signal, []);
  const transport: ReleaseTransport = {
    api: async path => {
      trace.push(`api:${path}`);
      let response: Record<string, unknown>;
      if (path.startsWith('/v9/projects/')) response = { id: 'prj_fixture', accountId: 'team_fixture', link: null,
        ...(aliased ? { lastAliasRequest: { type: 'promote', jobStatus: 'succeeded', toDeploymentId: deployment.id } } : {}) };
      else if (path.startsWith('/v13/deployments/')) response = { id: deployment.id, projectId: 'prj_fixture', ownerId: 'team_fixture',
        target: 'production', readyState: 'READY', source: 'cli', url: deployment.hostname, meta: { githubCommitSha: 'b'.repeat(40) } };
      else if (path.startsWith('/v4/aliases/')) {
        if (!aliased) throw new ReleaseError('ALIAS_MISMATCH');
        response = { alias: 'fixture.example.invalid', projectId: 'prj_fixture', deploymentId: deployment.id };
      } else throw new Error(`unexpected API path: ${path}`);
      return hooks.api ? hooks.api(path, response) : response;
    },
    buildInfo: async url => {
      trace.push(`read:${new URL(url).hostname}`);
      const marker = JSON.parse(await readFile(resolve(uploadRoot, '.vercel/output/static/.well-known/forge-prebuilt.json'), 'utf8')) as unknown;
      return new URL(url).pathname === '/.well-known/forge-prebuilt.json' ? hooks.marker?.(marker) ?? marker : { revision: sha };
    },
    promote: async (_id, signal) => { promotions++; trace.push('promote'); await hooks.promote?.(signal); assertActive(signal); aliased = true; },
  };
  const prebuilt: NonNullable<ExecutionContext['prebuilt']> = {
    state: undefined,
    reserve: async () => {},
    executionAt,
    save: async value => { await hooks.save?.(); prebuilt.state = structuredClone(value); snapshots.push(structuredClone(value)); },
  };
  const context: ExecutionContext = { execution: executionAt(root), config, sha, signal: controller.signal, transport, effects, prebuilt,
    assertFrozen: async () => { assertActive(controller.signal); await hooks.frozen?.(); },
    mutationGuard: async () => { trace.push('guard'); }, stage: async value => { trace.push(`stage:${value}`); }, checkpoint: async () => {} };
  try {
    await mkdir(resolve(output, 'static'), { recursive: true });
    await writeFile(resolve(output, 'config.json'), '{"version":3}');
    await writeFile(resolve(output, 'static/index.html'), '<h1>candidate</h1>');
    return { root, output, uploadRoot, config, sha, trace, context, prebuilt, hooks, snapshots, effects, controller,
      counts: () => ({ creates, promotions }), dispose };
  } catch (error) { await dispose(); throw error; }
}
