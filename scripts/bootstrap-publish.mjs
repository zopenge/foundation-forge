import { fileURLToPath } from 'node:url';
import { runBootstrapRelease } from './release-bootstrap.mjs';
import { loadReleasePolicy } from './release-policy.mjs';
import { withReleaseLock } from './release-report.mjs';
import { redactKnownTokens } from './release-redaction.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { parseReleaseAuthenticationArguments } from './release-authentication.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
try {
  const { authMode, args } = parseReleaseAuthenticationArguments(process.argv.slice(2));
  if (args.length > 0) throw new Error(`unknown argument: ${args[0]}`);
  const [policy, model] = await Promise.all([
    loadReleasePolicy(repositoryRoot),
    discoverWorkspacePackageModel({ repositoryRoot }),
  ]);
  await withReleaseLock(repositoryRoot, () => runBootstrapRelease({ model, policy, authMode }));
} catch (error) {
  process.stderr.write(`${redactKnownTokens(error?.message ?? String(error))}\n`);
  process.exitCode = 1;
}
