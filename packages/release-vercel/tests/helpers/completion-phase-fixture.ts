import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prebuiltPhaseFixture } from './prebuilt-phase-fixture.js';
import { runCompletion } from '../../src/node/completion.js';
import { assertCompletionInput } from '../../src/node/completion-input.js';
import { record } from '../../src/node/errors.js';

/** 发布为生产阶段输入，completion独自使用真实Native命令与同一实际锁/输入。 */
export async function completionPhaseFixture({ mode = 'ok', jobTimeoutMs, signal }:
  { mode?: string; jobTimeoutMs?: number; signal?: AbortSignal } = {}) {
  const value = await prebuiltPhaseFixture({ withAlias: true, ...(signal ? { signal } : {}), completion: { idempotent: true,
    jobs: [{ command: 'node', args: [resolve(import.meta.dirname, '../../package-consumer/completion-job.mjs'),
      '.tmp/completion-mode.txt', '.tmp/production-proof.json', '.tmp/completion-observations.jsonl'],
      ...(jobTimeoutMs === undefined ? {} : { timeoutMs: jobTimeoutMs }) }] } });
  try {
    const checkout = value.session.execution.cwd, control = resolve(checkout, '.tmp/completion-mode.txt');
    const observations = resolve(checkout, '.tmp/completion-observations.jsonl');
    await mkdir(resolve(checkout, '.tmp'), { recursive: true }); await writeFile(control, mode);
    await value.publish();
    // 云端在此阶段是已验证的固定输入；本地夹具I/O不能混入SDK的真实请求时限。
    // artifact与completion输入仍由生产guard每次新鲜核验，Native进程与预算没有替换。
    const candidate = value.session.state.prebuilt;
    if (!candidate?.deploymentUrl || !candidate.versionAlias?.verified) throw new Error('verified phase candidate required');
    const origins = [value.config.vercel.productionUrl, candidate.deploymentUrl, `https://${candidate.versionAlias.hostname}`];
    const observationUrl = (path: string, origin: string) => {
      const url = new URL(path, origin), marker = path === '/.well-known/forge-prebuilt.json';
      url.searchParams.set(marker ? 'artifact' : 'revision', marker ? candidate.artifactSha256 : candidate.sourceSha);
      return url.href;
    };
    const responses = new Map<string, unknown>();
    for (const origin of origins) for (const path of ['/.well-known/forge-prebuilt.json', value.config.buildInfo.path]) {
      const url = observationUrl(path, origin);
      responses.set(url, structuredClone(await value.transport.buildInfo(url, value.engine.controller.signal)));
    }
    const productionMarker = responses.get(observationUrl('/.well-known/forge-prebuilt.json', value.config.vercel.productionUrl));
    await writeFile(resolve(checkout, '.tmp/production-proof.json'), JSON.stringify({ ...record(productionMarker),
      deploymentId: candidate.deploymentId, productionUrl: value.config.vercel.productionUrl }));
    value.transport.buildInfo = async url => {
      if (!responses.has(url)) throw new Error('unexpected phase cloud observation');
      return structuredClone(responses.get(url));
    };
    const run = (retryCompletion = false) => runCompletion(value.session, { transport: value.transport, retryCompletion }, async () => {
      const binding = value.session.state.completionInput; if (!binding) throw new Error('sealed completion input required');
      await assertCompletionInput(checkout, binding);
    });
    return { ...value, get session() { return value.session; }, run, control,
      counts: async () => ({ ...value.engine.counts(), assignments: value.assignments() }),
      results: async (): Promise<Record<string, unknown>[]> => {
        const text = await readFile(observations, 'utf8').catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error;
        });
        return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      } };
  } catch (error) { await value.dispose(); throw error; }
}
