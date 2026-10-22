import { parseArguments } from './cli-arguments.js';
import { ReleaseError } from './node/errors.js';
import { runRelease } from './node/release.js';

export async function runCli(args: readonly string[]): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0] ?? '')) {
    process.stdout.write(`${JSON.stringify({ usage: 'forge-vercel-release <check|publish|status|verify|recover|login> [--cwd DIR] [--config FILE] [--sha SHA]', config: 'release.config.json', sha: 'status/verify only; full 40-character SHA' })}\n`);
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const options = parseArguments(args);
    const report = await runRelease({ ...options, signal: controller.signal, onLoginOutput: text => process.stderr.write(text) });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : report.error?.code === 'ARGUMENT_INVALID' ? 2 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 2, ok: false, error: { code: error instanceof ReleaseError ? error.code : 'IO_FAILED', details: {} } })}\n`);
    process.exitCode = error instanceof ReleaseError && error.code === 'ARGUMENT_INVALID' ? 2 : 1;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
