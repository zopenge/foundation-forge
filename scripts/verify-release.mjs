import { fileURLToPath } from 'node:url';

import { parseReleaseArguments } from './release-arguments.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { runReportedVerification } from './release-recovery.mjs';
import { withReleaseLock } from './release-report.mjs';
import { redactKnownTokens } from './release-redaction.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const argumentsValue = parseReleaseArguments(process.argv.slice(2));
if (argumentsValue.logs || argumentsValue.retry) {
  throw new Error('verify-release does not accept --logs or --retry');
}
if (argumentsValue.mode === undefined) throw new Error('verify-release requires --mode');
const [policy, model] = await Promise.all([
  loadReleasePolicy(repositoryRoot),
  discoverWorkspacePackageModel({ repositoryRoot }),
]);
try {
  await withReleaseLock(repositoryRoot, () => runReportedVerification({
    expectedCommit: argumentsValue.sha,
    mode: argumentsValue.mode,
    model,
    packageNames: argumentsValue.packages,
    policy,
  }));
} catch (error) {
  process.stderr.write(`${redactKnownTokens(error?.message ?? String(error))}\n`);
  process.exitCode = 1;
}
