import type { ReleaseDeployment } from '../contracts.js';
import type { ExecutionContext } from './release-context.js';
import { assertActive, ReleaseError } from './errors.js';
import { fetchAndAssertFastForward } from './git.js';
import { createTransport, VercelVerification } from './vercel.js';

/** 两种来源共用的唯一发布引擎；来源协调层只提供输入和守卫。 */
export async function publishCandidate(context: ExecutionContext, command: 'check' | 'publish' | 'status' | 'verify'): Promise<ReleaseDeployment | undefined> {
  const { execution, config, sha, signal, effects } = context;
  const verify = new VercelVerification(config, context.transport ?? createTransport(execution), signal);
  let result: ReleaseDeployment | undefined;
  const values = { FORGE_RELEASE_COMMAND: command, FORGE_RELEASE_SHA: sha };
  if (command === 'check' || command === 'publish') {
    if (command === 'publish') {
      await context.mutationGuard(); await fetchAndAssertFastForward(execution, config, sha); await verify.project();
    }
    await context.stage('checks');
    for (const [index, check] of config.checks.entries()) await execution.run(`check:${String(index)}`, check, 'CHECK_FAILED', values);
    await context.assertFrozen();
    if (command === 'publish') {
      await context.mutationGuard(); await fetchAndAssertFastForward(execution, config, sha);
      for (const [branch, effect, stage] of [[config.git.developmentBranch, 'developmentPush', 'push-dev'], [config.git.releaseBranch, 'releasePush', 'push-main']] as const) {
        await context.stage(stage); await context.assertFrozen(); assertActive(signal);
        await verify.project();
        if (await context.mutationGuard(effect) === 'already-current') {
          effects[effect] = 'already-current'; await context.checkpoint(); continue;
        }
        effects[effect] = 'unknown'; await context.checkpoint(effect);
        const output = await execution.git(['push', '--porcelain', config.git.remote, `${sha}:refs/heads/${branch}`]);
        effects[effect] = output.split(/\r?\n/u).some(line => line.startsWith('=') && line.includes(`:refs/heads/${branch}\t`)) ? 'already-current' : 'pushed';
        await context.checkpoint();
      }
      await context.stage('deployment'); result = await verify.wait(sha);
    }
  } else {
    await context.stage('deployment'); await verify.project(); result = await verify.find(sha);
    if (!result) throw new ReleaseError('DEPLOYMENT_MISSING');
  }
  if (result && ['publish', 'verify'].includes(command)) {
    await context.stage('acceptance'); await verify.verify(result);
    await context.assertFrozen();
    const acceptanceValues = { ...values, FORGE_RELEASE_URL: config.vercel.productionUrl, FORGE_RELEASE_DEPLOYMENT_ID: result.id };
    for (const [index, check] of config.acceptance.entries()) await execution.run(`acceptance:${String(index)}`, check, 'ACCEPTANCE_FAILED', acceptanceValues);
    await context.assertFrozen();
  }
  return result;
}
