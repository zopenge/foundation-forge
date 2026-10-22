import { spawnSync } from 'node:child_process';

import { parseOneTimePassword, readMaskedOneTimePassword } from './bootstrap-otp.mjs';
import { configureTrustedPublishers } from './configure-trusted-publishers.mjs';
import { readReleaseGitState } from './github-release.mjs';
import { publishIfNeeded } from './publish-if-needed.mjs';
import { assertBootstrapReleasePlan, createReleasePlan } from './release-plan.mjs';
import { runReportedVerification } from './release-recovery.mjs';
import { readPackageRegistryMetadata, selectBootstrapCandidates, selectReleasePackages, waitForPackageVersion } from './release-registry.mjs';
import { createPropagationBudget } from './release-propagation.mjs';
import { captureReleaseBinding, createReleaseReport, printReleaseSummary, recordReleaseFailure, writeReleaseReport } from './release-report.mjs';

const readLocalTag = ({ name, version, repositoryRoot }) => {
  const options = { cwd: repositoryRoot, encoding: 'utf8', shell: false, windowsHide: true };
  const ref = `refs/tags/${name}@${version}`;
  const exists = spawnSync('git', ['show-ref', '--verify', '--quiet', ref], options);
  if (exists.status === 1) return undefined;
  if (exists.status !== 0) throw new Error('BOOTSTRAP_TAG_READ_FAILED');
  const result = spawnSync('git', ['rev-parse', `${ref}^{commit}`], options);
  if (result.status !== 0) throw new Error('BOOTSTRAP_TAG_READ_FAILED');
  return result.stdout.trim();
};

const verifyPublishedTags = async ({ model, plan, headSha, readTag }) => {
  for (const { name, version, needsPublish } of plan) {
    const commit = await readTag({ name, version, repositoryRoot: model.repositoryRoot });
    if (!needsPublish && !commit) throw new Error(`Published version ${name}@${version} is missing Git tag`);
    if (needsPublish && commit !== undefined && commit !== headSha) {
      throw new Error(`BOOTSTRAP_TAG_CONFLICT：${name}@${version} 的既有 tag 不指向发布源码`);
    }
  }
};

export const runBootstrapRelease = async ({ model, policy,
  readMetadata = readPackageRegistryMetadata, readState = readReleaseGitState,
  verifyTags = verifyPublishedTags, captureBinding = captureReleaseBinding,
  readOtp = async () => process.env.NPM_CONFIG_OTP === undefined ? readMaskedOneTimePassword() : parseOneTimePassword(process.env.NPM_CONFIG_OTP),
  publish = publishIfNeeded, configure = configureTrustedPublishers, verify = runReportedVerification,
  waitForRegistry = waitForPackageVersion,
  readTag = readLocalTag,
}) => {
  const states = await Promise.all(model.packages.map(async ({ name, version }) => ({
    name, version, metadata: await readMetadata({ name, registry: policy.registry }),
  })));
  const plan = createReleasePlan(states.map((state) => ({ ...state, versions: new Set(Object.keys(state.metadata?.versions ?? {})) })));
  assertBootstrapReleasePlan(plan);
  const names = selectBootstrapCandidates(states);
  if (names.length === 0) {
    process.stdout.write('没有首次发布候选；如之前存在失败，请使用对应报告续验。\n');
    return;
  }
  await readState(model.repositoryRoot, policy.branch);
  const binding = await captureBinding(model, policy);
  await verifyTags({ model, plan, headSha: binding.commit, readTag });
  const report = createReleaseReport({ binding, expectedCommit: binding.commit, mode: 'bootstrap', kind: 'bootstrap',
    ...selectReleasePackages(model.packages, 'bootstrap', names),
  });
  let path = await writeReleaseReport(model.repositoryRoot, report);
  let stage = 'publish';
  let budget;
  try {
    const otp = await readOtp();
    await readState(model.repositoryRoot, policy.branch);
    if (JSON.stringify(await captureBinding(model, policy)) !== JSON.stringify(binding)) throw new Error('RELEASE_SOURCE_CHANGED');
    await publish({ model, policy, tag: 'next', bootstrap: true, expectedNames: names,
      environment: { ...process.env, NPM_CONFIG_OTP: otp },
      onPublishState: async ({ name }, state) => {
        const target = report.targets.find((value) => value.name === name);
        if (!target) throw new Error('BOOTSTRAP_TARGETS_CHANGED');
        target.publish = state;
        path = await writeReleaseReport(model.repositoryRoot, report);
      },
    });
    if (report.targets.some(({ publish: state }) => state !== 'succeeded')) throw new Error('PUBLISH_UNCONFIRMED');
    budget = createPropagationBudget({ timeoutMilliseconds: policy.pollTimeoutMilliseconds });
    stage = 'registry';
    report.stages.registry = 'started';
    await writeReleaseReport(model.repositoryRoot, report);
    for (const target of report.targets) await waitForRegistry({ ...target,
      registry: policy.registry, mode: 'bootstrap', budget,
    });
    stage = 'trustedPublisher';
    report.stages.trustedPublisher = 'started';
    await writeReleaseReport(model.repositoryRoot, report);
    await configure({ model, policy, packageNames: names });
    report.stages.trustedPublisher = 'succeeded';
    await writeReleaseReport(model.repositoryRoot, report);
  } catch (error) {
    recordReleaseFailure(report, stage, error);
    await writeReleaseReport(model.repositoryRoot, report);
    printReleaseSummary(report, path);
    throw error;
  }
  return verify({ model, policy, report, captureBinding, budget });
};
