import { fileURLToPath } from 'node:url';

import { loadReleasePolicy } from './release-policy.mjs';
import { resumeRelease } from './release-recovery.mjs';
import { withReleaseLock } from './release-report.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { redactKnownTokens } from './release-redaction.mjs';
import { parseReleaseAuthenticationArguments } from './release-authentication.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
try {
  const { authMode, args } = parseReleaseAuthenticationArguments(process.argv.slice(2));
  if (args.length !== 2 || args[0] !== '--report' || args[1].startsWith('--')) {
    throw new Error('usage: pnpm release:resume --report <报告路径> [--auth-mode otp|web]');
  }
  const [policy, model] = await Promise.all([loadReleasePolicy(repositoryRoot), discoverWorkspacePackageModel({ repositoryRoot })]);
  await withReleaseLock(repositoryRoot, () => resumeRelease({ model, policy, reportPath: args[1], authMode }));
} catch (error) {
  process.stderr.write(`${redactKnownTokens(error?.message ?? String(error))}\n`);
  process.exitCode = 1;
}
