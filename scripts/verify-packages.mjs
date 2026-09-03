import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const verificationRoot = resolve(repositoryRoot, '.tmp', 'package-verification');
const expectedVerificationPath = resolve(repositoryRoot, '.tmp', 'package-verification');

if (verificationRoot !== expectedVerificationPath || relative(repositoryRoot, verificationRoot).startsWith('..')) {
  throw new Error('package verification directory escaped the repository');
}

const packageDefinitions = [
  {
    directory: 'packages/peer-network',
    entries: ['.'],
    name: '@openge/forge-peer-network',
  },
  {
    directory: 'packages/peer-network-libp2p',
    entries: ['./node', './browser', './relay'],
    name: '@openge/forge-peer-network-libp2p',
  },
  {
    directory: 'packages/peer-network-websocket',
    entries: ['./client', './hub', './server'],
    name: '@openge/forge-peer-network-websocket',
  },
  {
    directory: 'packages/text-integrity',
    entries: ['.', './node'],
    name: '@openge/forge-text-integrity',
  },
  {
    directory: 'packages/repository-files',
    entries: ['.'],
    name: '@openge/forge-repository-files',
  },
  {
    directory: 'packages/deterministic-json',
    entries: ['.'],
    name: '@openge/forge-deterministic-json',
  },
  {
    directory: 'packages/path-safety',
    entries: ['.', './node'],
    name: '@openge/forge-path-safety',
  },
  {
    directory: 'packages/artifact-integrity',
    entries: ['.', './node'],
    name: '@openge/forge-artifact-integrity',
  },
  {
    directory: 'packages/archive-safety',
    entries: ['.'],
    name: '@openge/forge-archive-safety',
  },
  {
    directory: 'packages/archive-zip',
    entries: ['.'],
    name: '@openge/forge-archive-zip',
  },
  {
    directory: 'packages/json-lines',
    entries: ['.'],
    name: '@openge/forge-json-lines',
  },
  {
    directory: 'packages/server-sent-events',
    entries: ['.'],
    name: '@openge/forge-server-sent-events',
  },
  {
    directory: 'packages/workspace-graph',
    entries: ['.'],
    name: '@openge/forge-workspace-graph',
  },
  {
    directory: 'packages/workspace-checks',
    entries: ['.'],
    name: '@openge/forge-workspace-checks',
  },
  {
    directory: 'packages/workspace-pnpm',
    entries: ['.'],
    name: '@openge/forge-workspace-pnpm',
  },
  {
    directory: 'packages/workspace-checks-pnpm',
    entries: ['.'],
    name: '@openge/forge-workspace-checks-pnpm',
  },
  {
    directory: 'packages/process-control',
    entries: ['.'],
    name: '@openge/forge-process-control',
  },
  {
    directory: 'packages/process-control-node',
    entries: ['.'],
    name: '@openge/forge-process-control-node',
  },
];

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1_024 * 1_024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
};

const pnpmCli = process.env.npm_execpath;
if (pnpmCli === undefined || pnpmCli.length === 0) {
  throw new Error('pack verification must run through pnpm');
}
const runPnpm = (args, options = {}) => run(process.execPath, [pnpmCli, ...args], options);

const assertAbsent = async (relativePath) => {
  try {
    await access(resolve(repositoryRoot, relativePath));
  } catch {
    return;
  }
  throw new Error(`unexpected repository file: ${relativePath}`);
};

const verifyRepositoryHygiene = async () => {
  for (const lockfile of ['package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    await assertAbsent(lockfile);
  }

  const npmrc = await readFile(resolve(repositoryRoot, '.npmrc'), 'utf8');
  const forbiddenAuthenticationPatterns = [
    /_authToken\s*=/iu,
    /_auth\s*=/iu,
    /password\s*=/iu,
    /username\s*=/iu,
  ];
  if (forbiddenAuthenticationPatterns.some((pattern) => pattern.test(npmrc))) {
    throw new Error('root .npmrc contains authentication material');
  }

  const workflowDirectory = resolve(repositoryRoot, '.github', 'workflows');
  const workflowNames = await readdir(workflowDirectory);
  const tokenIdentifier = 'NPM' + '_TOKEN';
  for (const workflowName of workflowNames) {
    const workflow = await readFile(resolve(workflowDirectory, workflowName), 'utf8');
    if (workflow.includes(tokenIdentifier)) {
      throw new Error(`${workflowName} configures a long-lived npm token`);
    }
  }
};

const verifyDocumentationLinks = async () => {
  const markdownPaths = [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'docs/architecture/boundaries.md',
    ...packageDefinitions.map((definition) => `${definition.directory}/README.md`),
  ];
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/gu;
  for (const markdownPath of markdownPaths) {
    const source = await readFile(resolve(repositoryRoot, markdownPath), 'utf8');
    for (const match of source.matchAll(markdownLink)) {
      const target = match[1]?.split('#')[0] ?? '';
      if (
        target.length === 0
        || target.startsWith('https://')
        || target.startsWith('http://')
        || target.startsWith('mailto:')
      ) {
        continue;
      }
      try {
        await access(resolve(repositoryRoot, dirname(markdownPath), decodeURIComponent(target)));
      } catch {
        throw new Error(`${markdownPath} links to missing local target: ${target}`);
      }
    }
  }
};

const verifyManifest = async (definition) => {
  const path = resolve(repositoryRoot, definition.directory, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const expectedRepositoryUrl = 'git+https://github.com/zopenge/foundation-forge.git';
  if (manifest.name !== definition.name) {
    throw new Error(`${definition.directory} has an unexpected package name`);
  }
  if (manifest.private === true || manifest.publishConfig?.access !== 'public') {
    throw new Error(`${definition.name} is not configured as a public package`);
  }
  if (manifest.repository?.url !== expectedRepositoryUrl) {
    throw new Error(`${definition.name} repository URL is not trusted-publishing compatible`);
  }
  if (manifest.repository?.directory !== definition.directory) {
    throw new Error(`${definition.name} repository directory is incorrect`);
  }
  if (manifest.engines?.node !== '>=22.14.0') {
    throw new Error(`${definition.name} has an unexpected Node.js engine range`);
  }
  if (manifest.sideEffects !== false) {
    throw new Error(`${definition.name} must declare sideEffects false`);
  }
  const actualEntries = Object.keys(manifest.exports ?? {}).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify([...definition.entries].sort())) {
    throw new Error(`${definition.name} has unexpected public entries`);
  }
};

const verifyBrowserBoundary = async () => {
  const browserFiles = [
    'packages/peer-network-libp2p/src/browser.ts',
    'packages/peer-network-websocket/src/client.ts',
    'packages/peer-network-websocket/src/hub.ts',
    'packages/peer-network-websocket/src/protocol.ts',
    'packages/peer-network-websocket/src/rendezvous-hub.ts',
    'packages/text-integrity/src/contracts.ts',
    'packages/text-integrity/src/index.ts',
    'packages/text-integrity/src/inspection.ts',
    'packages/deterministic-json/src/contracts.ts',
    'packages/deterministic-json/src/errors.ts',
    'packages/deterministic-json/src/index.ts',
    'packages/deterministic-json/src/sorting.ts',
    'packages/deterministic-json/src/stringify.ts',
    'packages/deterministic-json/src/validation.ts',
    'packages/path-safety/src/contracts.ts',
    'packages/path-safety/src/errors.ts',
    'packages/path-safety/src/index.ts',
    'packages/path-safety/src/portable-path.ts',
    'packages/artifact-integrity/src/bytes.ts',
    'packages/artifact-integrity/src/contracts.ts',
    'packages/artifact-integrity/src/digest.ts',
    'packages/artifact-integrity/src/errors.ts',
    'packages/artifact-integrity/src/index.ts',
    'packages/archive-safety/src/contracts.ts',
    'packages/archive-safety/src/entry-path.ts',
    'packages/archive-safety/src/errors.ts',
    'packages/archive-safety/src/index.ts',
    'packages/archive-safety/src/limits.ts',
    'packages/archive-zip/src/central-directory.ts',
    'packages/archive-zip/src/codec.ts',
    'packages/archive-zip/src/contracts.ts',
    'packages/archive-zip/src/errors.ts',
    'packages/archive-zip/src/index.ts',
    'packages/json-lines/src/codec.ts',
    'packages/json-lines/src/contracts.ts',
    'packages/json-lines/src/decoder.ts',
    'packages/json-lines/src/errors.ts',
    'packages/json-lines/src/index.ts',
    'packages/process-control/src/contracts.ts',
    'packages/process-control/src/errors.ts',
    'packages/process-control/src/index.ts',
    'packages/process-control/src/listeners.ts',
    'packages/server-sent-events/src/contracts.ts',
    'packages/server-sent-events/src/decoder.ts',
    'packages/server-sent-events/src/encoder.ts',
    'packages/server-sent-events/src/errors.ts',
    'packages/server-sent-events/src/index.ts',
    'packages/workspace-graph/src/contracts.ts',
    'packages/workspace-graph/src/errors.ts',
    'packages/workspace-graph/src/graph.ts',
    'packages/workspace-graph/src/index.ts',
    'packages/workspace-checks/src/contracts.ts',
    'packages/workspace-checks/src/errors.ts',
    'packages/workspace-checks/src/index.ts',
    'packages/workspace-checks/src/package-cycle-check.ts',
    'packages/workspace-checks/src/run.ts',
  ];
  const forbidden = [/from ['"]node:/u, /from ['"]ws['"]/u, /\.\/server\.js/u];
  for (const relativePath of browserFiles) {
    const source = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
    if (forbidden.some((pattern) => pattern.test(source))) {
      throw new Error(`${relativePath} crosses the browser package boundary`);
    }
  }
};

const listTarballFiles = (tarballPath) => run('tar', ['-tzf', tarballPath]).split(/\r?\n/u).filter(Boolean);

const verifyTarball = (tarballPath) => {
  const entries = listTarballFiles(tarballPath);
  const required = ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/NOTICE'];
  for (const path of required) {
    if (!entries.includes(path)) {
      throw new Error(`${tarballPath} is missing ${path}`);
    }
  }
  const unexpected = entries.filter((path) => (
    !required.includes(path)
    && !path.startsWith('package/dist/')
  ));
  if (unexpected.length > 0) {
    throw new Error(`${tarballPath} contains unexpected files: ${unexpected.join(', ')}`);
  }

  const packedManifest = run('tar', ['-xOf', tarballPath, 'package/package.json']);
  if (packedManifest.includes('workspace:')) {
    throw new Error(`${tarballPath} contains unresolved workspace dependencies`);
  }
  return entries;
};

const createConsumer = async (tarballs) => {
  const consumerRoot = resolve(verificationRoot, 'consumer');
  const dependencyEntries = packageDefinitions.map((definition) => {
    const tarball = tarballs.get(definition.name);
    if (tarball === undefined) {
      throw new Error(`missing tarball for ${definition.name}`);
    }
    return [definition.name, `file:${relative(consumerRoot, tarball).replaceAll('\\', '/')}`];
  });
  const dependencies = Object.fromEntries(dependencyEntries);
  const coreTarballReference = dependencies['@openge/forge-peer-network'];
  if (typeof coreTarballReference !== 'string') {
    throw new Error('missing Core tarball dependency');
  }
  const repositoryFilesTarballReference = dependencies['@openge/forge-repository-files'];
  if (typeof repositoryFilesTarballReference !== 'string') {
    throw new Error('missing Repository Files tarball dependency');
  }
  const pathSafetyTarballReference = dependencies['@openge/forge-path-safety'];
  if (typeof pathSafetyTarballReference !== 'string') {
    throw new Error('missing Path Safety tarball dependency');
  }
  const workspaceGraphTarballReference = dependencies['@openge/forge-workspace-graph'];
  if (typeof workspaceGraphTarballReference !== 'string') {
    throw new Error('missing Workspace Graph tarball dependency');
  }
  const workspaceChecksTarballReference = dependencies['@openge/forge-workspace-checks'];
  if (typeof workspaceChecksTarballReference !== 'string') {
    throw new Error('missing Workspace Checks tarball dependency');
  }
  const workspaceChecksPnpmTarballReference = dependencies['@openge/forge-workspace-checks-pnpm'];
  if (typeof workspaceChecksPnpmTarballReference !== 'string') {
    throw new Error('missing Workspace Checks pnpm tarball dependency');
  }
  const processControlTarballReference = dependencies['@openge/forge-process-control'];
  if (typeof processControlTarballReference !== 'string') {
    throw new Error('missing Process Control tarball dependency');
  }
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, 'package.json'), `${JSON.stringify({
    dependencies,
    name: 'foundation-forge-package-consumer',
    private: true,
    type: 'module',
    version: '0.0.0',
  }, null, 2)}\n`, 'utf8');
  await writeFile(resolve(consumerRoot, 'pnpm-workspace.yaml'), [
    'packages: []',
    '',
    'allowBuilds:',
    '  node-datachannel: true',
    '',
    'overrides:',
    `  "@openge/forge-peer-network": "${coreTarballReference}"`,
    `  "@openge/forge-repository-files": "${repositoryFilesTarballReference}"`,
    `  "@openge/forge-path-safety": "${pathSafetyTarballReference}"`,
    `  "@openge/forge-workspace-graph": "${workspaceGraphTarballReference}"`,
    `  "@openge/forge-workspace-checks": "${workspaceChecksTarballReference}"`,
    `  "@openge/forge-workspace-checks-pnpm": "${workspaceChecksPnpmTarballReference}"`,
    `  "@openge/forge-process-control": "${processControlTarballReference}"`,
    '',
    'packageExtensions:',
    '  "react-native-webrtc@*":',
    '    peerDependenciesMeta:',
    '      react-native:',
    '        optional: true',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(consumerRoot, '.npmrc'), [
    'node-linker=hoisted',
    'package-import-method=copy',
    'registry=https://registry.npmjs.org/',
    '@openge:registry=https://registry.npmjs.org/',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(consumerRoot, '.gitignore'), 'node_modules/\n', 'utf8');
  await writeFile(resolve(consumerRoot, 'verify.mjs'), [
    "await import('@openge/forge-peer-network');",
    "await import('@openge/forge-peer-network-libp2p/node');",
    "await import('@openge/forge-peer-network-libp2p/browser');",
    "await import('@openge/forge-peer-network-libp2p/relay');",
    "await import('@openge/forge-peer-network-websocket/client');",
    "await import('@openge/forge-peer-network-websocket/hub');",
    "await import('@openge/forge-peer-network-websocket/server');",
    "const { inspectTextIntegrity } = await import('@openge/forge-text-integrity');",
    "await import('@openge/forge-text-integrity/node');",
    "if (inspectTextIntegrity('broken ???').length !== 1) throw new Error('text inspection failed');", // check-mojibake-ignore-line
    "const { listRepositoryFiles } = await import('@openge/forge-repository-files');",
    "const { stringifyDeterministicJson } = await import('@openge/forge-deterministic-json');",
    "const { validatePortableRelativePath } = await import('@openge/forge-path-safety');",
    "const { resolvePathWithinRoot } = await import('@openge/forge-path-safety/node');",
    "const { calculateBytesIntegrity } = await import('@openge/forge-artifact-integrity');",
    "const { calculateBytesIntegritySync } = await import('@openge/forge-artifact-integrity/node');",
    "const { inspectArchiveEntries } = await import('@openge/forge-archive-safety');",
    "const { decodeZipArchive, encodeZipArchive } = await import('@openge/forge-archive-zip');",
    "const { parseJsonLines } = await import('@openge/forge-json-lines');",
    "const { createServerSentEventDecoder } = await import('@openge/forge-server-sent-events');",
    "const { createWorkspaceGraph, sortWorkspacePackages } = await import('@openge/forge-workspace-graph');",
    "const { createPackageCycleCheck, runWorkspaceChecks } = await import('@openge/forge-workspace-checks');",
    "const { readPnpmWorkspace } = await import('@openge/forge-workspace-pnpm');",
    "const { checkPnpmWorkspace } = await import('@openge/forge-workspace-checks-pnpm');",
    "const { selectTcpListeners } = await import('@openge/forge-process-control');",
    "await import('@openge/forge-process-control-node');",
    "if (stringifyDeterministicJson({ b: 2, a: 1 }) !== '{\"a\":1,\"b\":2}') throw new Error('deterministic JSON failed');",
    "if (validatePortableRelativePath('assets/file.bin') !== 'assets/file.bin') throw new Error('portable path validation failed');",
    "if (!resolvePathWithinRoot(process.cwd(), 'assets/file.bin').endsWith('assets\\\\file.bin') && !resolvePathWithinRoot(process.cwd(), 'assets/file.bin').endsWith('assets/file.bin')) throw new Error('root containment failed');",
    "if ((await calculateBytesIntegrity(new TextEncoder().encode('abc'))).byteLength !== 3) throw new Error('artifact integrity failed');",
    "if (calculateBytesIntegritySync(new TextEncoder().encode('abc')).byteLength !== 3) throw new Error('synchronous artifact integrity failed');",
    "if (inspectArchiveEntries([{ path: 'a.bin', kind: 'file', uncompressedBytes: 3 }]).expandedBytes !== 3) throw new Error('archive safety failed');",
    "const zip = encodeZipArchive([{ bytes: new TextEncoder().encode('a'), kind: 'file', path: 'a.txt' }], { compression: 'store' });",
    "if (new TextDecoder().decode(decodeZipArchive(zip).entries[0].bytes) !== 'a') throw new Error('ZIP archive failed');",
    "if (parseJsonLines('{\"a\":1}\\n').length !== 1) throw new Error('JSON Lines failed');",
    "const eventDecoder = createServerSentEventDecoder();",
    "if (eventDecoder.push(new TextEncoder().encode('data: ok\\n\\n'))[0]?.data !== 'ok') throw new Error('SSE failed');",
    "const workspaceGraph = createWorkspaceGraph([{ name: 'a', relativeDirectory: 'a', dependencies: [] }]);",
    "if (sortWorkspacePackages(workspaceGraph, { dependencyKinds: ['dependencies'] })[0] !== 'a') throw new Error('workspace graph failed');",
    "if (!runWorkspaceChecks(workspaceGraph, [createPackageCycleCheck()]).passed) throw new Error('workspace checks failed');",
    "if ((await readPnpmWorkspace({ cwd: process.cwd() })).packages.length !== 0) throw new Error('pnpm workspace failed');",
    "if (!(await checkPnpmWorkspace({ cwd: process.cwd() })).passed) throw new Error('pnpm workspace checks failed');",
    "if (selectTcpListeners([], { ports: [3000] }).length !== 0) throw new Error('process control failed');",
    "if (!(await listRepositoryFiles({ cwd: process.cwd() })).includes('fixture.ts')) throw new Error('repository discovery failed');",
    "console.log('Clean tarball consumer imported every public entry.');",
    '',
  ].join('\n'), 'utf8');

  run('git', ['init', '--quiet'], { cwd: consumerRoot });
  const fixturePath = resolve(consumerRoot, 'fixture.ts');
  await writeFile(fixturePath, 'broken ???\n', 'utf8'); // check-mojibake-ignore-line
  run('git', ['add', '.gitignore', 'fixture.ts'], { cwd: consumerRoot });
  runPnpm(['install', '--prefer-offline', '--frozen-lockfile=false'], {
    cwd: consumerRoot,
  });
  const importOutput = run(process.execPath, ['verify.mjs'], { cwd: consumerRoot });
  const cliPath = resolve(
    consumerRoot,
    'node_modules',
    '@openge',
    'forge-text-integrity',
    'dist',
    'cli.js',
  );
  const cliResult = spawnSync(process.execPath, [cliPath, 'fixture.ts'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (cliResult.status !== 1 || !cliResult.stderr.includes('question-placeholder')) {
    throw new Error([
      'text integrity CLI fixture did not report the expected issue',
      `status: ${String(cliResult.status)}`,
      `error: ${String(cliResult.error ?? '')}`,
      `stdout: ${cliResult.stdout}`,
      `stderr: ${cliResult.stderr}`,
    ].join('\n'));
  }
  const cleanWorkspacePath = resolve(consumerRoot, 'workspace-checks-clean');
  await mkdir(resolve(cleanWorkspacePath, 'packages', 'a'), { recursive: true });
  await writeFile(resolve(cleanWorkspacePath, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf8');
  await writeFile(resolve(cleanWorkspacePath, 'packages', 'a', 'package.json'), JSON.stringify({
    name: 'a',
  }), 'utf8');
  const cycleWorkspacePath = resolve(consumerRoot, 'workspace-checks-cycle');
  await mkdir(resolve(cycleWorkspacePath, 'packages', 'a'), { recursive: true });
  await mkdir(resolve(cycleWorkspacePath, 'packages', 'b'), { recursive: true });
  await writeFile(resolve(cycleWorkspacePath, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf8');
  await writeFile(resolve(cycleWorkspacePath, 'packages', 'a', 'package.json'), JSON.stringify({
    dependencies: { b: 'workspace:*' },
    name: 'a',
  }), 'utf8');
  await writeFile(resolve(cycleWorkspacePath, 'packages', 'b', 'package.json'), JSON.stringify({
    dependencies: { a: 'workspace:*' },
    name: 'b',
  }), 'utf8');
  const cleanWorkspaceOutput = runPnpm([
    'exec',
    'forge-workspace-checks',
    '--cwd', cleanWorkspacePath,
    '--check', 'package-cycles',
  ], { cwd: consumerRoot });
  if (!cleanWorkspaceOutput.includes('Workspace checks passed.')) {
    throw new Error('workspace checks CLI clean fixture did not write the expected stdout');
  }
  const cycleWorkspaceResult = spawnSync(process.execPath, [pnpmCli, 'exec', 'forge-workspace-checks', '--cwd', cycleWorkspacePath, '--check', 'package-cycles'], {
    cwd: consumerRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (cycleWorkspaceResult.status !== 1 || cycleWorkspaceResult.stdout.length !== 0 || !cycleWorkspaceResult.stderr.includes('a -> b -> a')) {
    throw new Error('workspace checks CLI cycle fixture did not report the expected stderr');
  }
  return `${importOutput}\nClean tarball consumer executed CLI fixtures.`;
};

await rm(verificationRoot, { force: true, recursive: true });
try {
  await verifyRepositoryHygiene();
  await verifyDocumentationLinks();
  await verifyBrowserBoundary();
  for (const definition of packageDefinitions) {
    await verifyManifest(definition);
  }

  const packDirectory = resolve(verificationRoot, 'packs');
  await mkdir(packDirectory, { recursive: true });
  const tarballs = new Map();
  for (const definition of packageDefinitions) {
    const before = new Set(await readdir(packDirectory));
    runPnpm(['--filter', definition.name, 'pack', '--pack-destination', packDirectory]);
    const created = (await readdir(packDirectory)).filter((name) => !before.has(name));
    if (created.length !== 1) {
      throw new Error(`${definition.name} produced ${String(created.length)} tarballs`);
    }
    const tarballPath = resolve(packDirectory, created[0]);
    tarballs.set(definition.name, tarballPath);
    const entries = verifyTarball(tarballPath);
    console.log(`${definition.name}: verified ${String(entries.length)} packed files`);
  }

  console.log(await createConsumer(tarballs));
} finally {
  await rm(verificationRoot, { force: true, recursive: true });
}
