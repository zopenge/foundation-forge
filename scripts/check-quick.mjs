import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectCheckMode } from './check-mode.mjs';
import { collectWorkspaceFingerprint, collectDistDigests } from './check-fingerprint.mjs';
import { fullCheckRequired } from './check-release-gate.mjs';
import { discoverWorkspacePackageModel } from './workspace-packages.mjs';
import { loadPackageVerification } from './package-verification.mjs';
import { preparePackagesForPacking, verifyDocumentationLinks } from './package-consumer-runner.mjs';
import { createPackageManagerInvocation } from './package-manager-command.mjs';
import { createTestRunContext } from './test-run-context.mjs';
import { runScriptTestSuite } from './run-script-tests.mjs';
import { discoverPackageTestFiles, runWorkspaceQuickTests } from './run-workspace-coverage.mjs';

export const selectQuickPlan = ({ state, fingerprint, packages, scriptFiles }) => {
  if (!state?.files || Array.isArray(state.files) || typeof state.files !== 'object') return { kind: 'full-required' };
  const selection = state.selectionEnvironmentDigest && fingerprint.selectionEnvironmentDigest;
  if (selection && state.selectionEnvironmentDigest !== fingerprint.selectionEnvironmentDigest) return { kind: 'full-required' };
  const mode = selectCheckMode(selection ? { ...state, environmentDigest: state.selectionEnvironmentDigest } : state,
    selection ? { ...fingerprint, environmentDigest: fingerprint.selectionEnvironmentDigest } : fingerprint, packages);
  if (mode.kind === 'full') return { kind: 'full-required' };
  const changed = Object.keys(fingerprint.files).filter(path => state.files[path] !== fingerprint.files[path]);
  const packageNames = mode.kind === 'leaf' ? [mode.packageName] : mode.kind === 'packages' ? mode.packageNames : [];
  const selected = packages.filter(value => packageNames.includes(value.name));
  if (selected.some(value => !Array.isArray(value.quickTests) || !value.quickTests.length)) return { kind: 'full-required' };
  for (const value of selected) {
    const prefix = `${value.directory}/tests/`;
    if (changed.some(path => path.startsWith(`${value.directory}/`)
      && (path.startsWith(prefix) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path))
      && !value.quickTests.includes(path.slice(value.directory.length + 1))))
      return { kind: 'full-required' };
  }
  const scripts = new Set(scriptFiles.filter(path => /^scripts\/tests\/quick-[^/]+\.test\.mjs$/u.test(path)));
  if (scripts.size === 0) return { kind: 'full-required' };
  if (mode.kind === 'script-tests') {
    for (const path of changed) {
      if (path.startsWith('docs/') || path.endsWith('.md')) continue;
      if (!scriptFiles.includes(path)) return { kind: 'full-required' };
      scripts.add(path);
    }
  }
  return { kind: 'quick', packageNames, scriptFiles: [...scripts].sort(),
    tests: Object.fromEntries(selected.map(value => [value.name, value.quickTests])) };
};
export const runQuickCheck = async ({ signal, repositoryRoot = fileURLToPath(new URL('../', import.meta.url)),
  run, createContext = createTestRunContext, collect = collectWorkspaceFingerprint,
  discover = discoverWorkspacePackageModel, loadState, scripts = runScriptTestSuite, tests = runWorkspaceQuickTests,
} = {}) => {
  signal?.throwIfAborted();
  const model = await discover({ repositoryRoot }), fingerprint = await collect(repositoryRoot);
  let state;
  try { state = loadState ? await loadState() : JSON.parse(await readFile(resolve(repositoryRoot, '.tmp/check-cache/state.json'), 'utf8')); }
  catch { throw fullCheckRequired('BASELINE_UNAVAILABLE'); }
  const packages = await Promise.all(model.packages.map(async value => {
    const verification = value.verification ?? await loadPackageVerification(value);
    const all = await discoverPackageTestFiles(value.packageRoot);
    const quickTests = verification.quickTests ?? all;
    if (!quickTests.length || quickTests.some(path => !all.includes(path))) throw fullCheckRequired('QUICK_TEST_MANIFEST_INVALID');
    return { ...value, verification, quickTests, allTestFiles: all };
  }));
  const scriptFiles = (await readdir(resolve(repositoryRoot, 'scripts/tests'))).filter(name => name.endsWith('.test.mjs')).map(name => `scripts/tests/${name}`);
  const plan = selectQuickPlan({ state, fingerprint, packages, scriptFiles });
  if (plan.kind !== 'quick') throw fullCheckRequired('QUICK_SCOPE_UNCERTAIN');
  const selected = packages.filter(value => plan.packageNames.includes(value.name));
  for (const value of selected) {
    // 不在 quick 内重建正在承担监督职责的运行时；约定适配器所属包变化要求 full。
    const adapter = await access(resolve(value.packageRoot, 'test-process-scope.mjs')).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    });
    if (adapter) throw fullCheckRequired('SUPERVISOR_RUNTIME_CHANGED');
  }
  const unaffected = packages.filter(value => !plan.packageNames.includes(value.name));
  const before = await collectDistDigests(unaffected);
  if (unaffected.some(({ name }) => before[name] !== state.distDigests?.[name])) throw fullCheckRequired('DEPENDENCY_OUTPUTS_CHANGED');
  let context;
  const failures = [];
  const execute = async args => {
    signal?.throwIfAborted();
    if (run) return run(args, signal);
    return context.run({ name: `quick ${args.join(' ')}`, ...createPackageManagerInvocation('pnpm', args),
      cwd: repositoryRoot, workers: 1 });
  };
  try {
    context = await createContext({ packages: model.packages, workers: 1, signal });
    await execute(['run', 'lint']); signal?.throwIfAborted();
    if (selected.length) await preparePackagesForPacking({ model: { ...model, packages: selected }, build: async () => {
      for (const { name } of selected) await execute(['--filter', name, 'run', 'build']);
    } });
    for (const { name } of selected) await execute(['--filter', name, 'run', 'typecheck']);
    await scripts(context, { files: plan.scriptFiles });
    if (selected.length) await tests({ packages: selected, context });
    await verifyDocumentationLinks(repositoryRoot);
    if (JSON.stringify(before) !== JSON.stringify(await collectDistDigests(unaffected))) throw fullCheckRequired('DEPENDENCY_OUTPUTS_CHANGED');
    if (JSON.stringify(fingerprint) !== JSON.stringify(await collect(repositoryRoot))) throw fullCheckRequired('INPUTS_CHANGED');
    signal?.throwIfAborted();
  } catch (error) { failures.push(error); try { await context?.cancel(error); } catch (error) { failures.push(error); } }
  finally { try { await context?.finalize(); } catch (error) { failures.push(error); } }
  if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'QUICK_CHECK_FAILED');
  signal?.throwIfAborted();
  const result = { ...plan, full: 'NOT RUN', tarballConsumers: 'NOT RUN', coverage: 'NOT RUN',
    notRun: { packages: unaffected.map(value => value.name), scripts: scriptFiles.filter(path => !plan.scriptFiles.includes(path)),
      tests: Object.fromEntries(packages.map(value => [value.name, value.allTestFiles.filter(path => !plan.tests[value.name]?.includes(path))])) } };
  process.stdout.write(`Quick check passed: ${JSON.stringify(result)}\n`);
  return result;
};
