import { resolve } from 'node:path';

import { configureTrustedPublishers } from './configure-trusted-publishers.mjs';
import { readPackageRegistryMetadata, readReleaseTagCommit, selectReleasePackages, verifyRegistryPackages } from './release-registry.mjs';
import { createPropagationBudget, releaseError } from './release-propagation.mjs';
import { assertResumeBinding, captureReleaseBinding, createReleaseReport, printReleaseSummary,
  readReleaseReport, recordReleaseFailure, writeReleaseReport } from './release-report.mjs';

export const runReportedVerification = async ({ model, policy, mode, packageNames = [], expectedCommit,
  report, verify = verifyRegistryPackages, captureBinding = captureReleaseBinding, budget,
}) => {
  if (!report) {
    const selected = selectReleasePackages(model.packages, mode, packageNames);
    if (selected.targets.length === 0) throw new Error(`no ${mode} package versions were selected for verification`);
    report = createReleaseReport({ binding: await captureBinding(model, policy), mode, expectedCommit, ...selected });
    report.stages.trustedPublisher = 'not-required';
  }
  let stage = 'registry';
  let path = await writeReleaseReport(model.repositoryRoot, report);
  try {
    await verify({ model, policy, mode: report.mode,
      packageNames: report.targets.map(({ name }) => name), expectedCommit: report.expectedCommit, budget,
      verificationRoot: resolve(model.repositoryRoot, '.tmp', 'registry-package-verification'),
      onEvent: async (event) => {
        stage = event.stage;
        if (event.state === 'verified') {
          const target = report.targets.find(({ name }) => name === event.name);
          if (target) target.publish = 'succeeded';
        } else report.stages[event.stage] = event.state;
        path = await writeReleaseReport(model.repositoryRoot, report);
      },
    });
    if (JSON.stringify(await captureBinding(model, policy)) !== JSON.stringify(report.binding)) {
      throw new Error('RELEASE_SOURCE_CHANGED：验证期间源码或环境发生变化');
    }
    if (report.stages.registry !== 'succeeded' || report.stages.consumer !== 'succeeded') {
      throw new Error('RELEASE_VERIFICATION_INCOMPLETE');
    }
    return report;
  } catch (error) {
    recordReleaseFailure(report, stage, error);
    await writeReleaseReport(model.repositoryRoot, report);
    throw error;
  } finally { printReleaseSummary(report, path); }
};

export const resumeRelease = async ({ model, policy, reportPath, authMode = 'otp',
  captureBinding = captureReleaseBinding, readMetadata = readPackageRegistryMetadata,
  configure = configureTrustedPublishers, verify = verifyRegistryPackages, readTag = readReleaseTagCommit,
}) => {
  const report = await readReleaseReport(model.repositoryRoot, reportPath);
  const selected = selectReleasePackages(model.packages, report.mode, report.targets.map(({ name }) => name));
  assertResumeBinding(report, { binding: await captureBinding(model, policy), ...selected });
  const budget = createPropagationBudget({ timeoutMilliseconds: policy.pollTimeoutMilliseconds });
  let stage = 'registry';
  try {
    for (const { name, version } of report.targets) {
      const metadata = await budget.retry(async () => {
        const value = await readMetadata({ name, registry: policy.registry, budget });
        if (!value?.versions?.[version]) throw releaseError('REGISTRY_PENDING', `${name}@${version} 尚不可回读`);
        return value;
      });
      const tag = report.mode === 'stable' ? 'latest' : 'next';
      if (metadata['dist-tags']?.[tag] !== version) throw new Error(`DIST_TAG_CHANGED：${name} 的 ${tag} 已不指向 ${version}`);
      const commit = await readTag({ mode: report.mode, packageValue: { name, version }, repositoryRoot: model.repositoryRoot });
      if (report.expectedCommit !== undefined && commit !== report.expectedCommit) throw new Error(`GIT_TAG_CHANGED：${name}@${version}`);
    }
    if (report.stages.trustedPublisher !== 'not-required') {
      stage = 'trustedPublisher';
      report.stages.trustedPublisher = 'started';
      await writeReleaseReport(model.repositoryRoot, report);
      await configure({ model, policy, packageNames: report.targets.map(({ name }) => name), authMode });
      report.stages.trustedPublisher = 'succeeded';
      await writeReleaseReport(model.repositoryRoot, report);
    }
  } catch (error) {
    recordReleaseFailure(report, stage, error);
    const path = await writeReleaseReport(model.repositoryRoot, report);
    printReleaseSummary(report, path);
    throw error;
  }
  return runReportedVerification({ model, policy, report, verify, captureBinding, budget });
};
