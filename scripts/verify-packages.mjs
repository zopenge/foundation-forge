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
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(resolve(consumerRoot, 'package.json'), `${JSON.stringify({
    dependencies,
    name: 'foundation-forge-package-consumer',
    pnpm: {
      overrides: {
        '@openge/forge-peer-network': coreTarballReference,
      },
    },
    private: true,
    type: 'module',
    version: '0.0.0',
  }, null, 2)}\n`, 'utf8');
  await writeFile(resolve(consumerRoot, 'pnpm-workspace.yaml'), [
    'allowBuilds:',
    '  node-datachannel: true',
    '',
    'packageExtensions:',
    '  "react-native-webrtc@*":',
    '    peerDependenciesMeta:',
    '      react-native:',
    '        optional: true',
    '',
  ].join('\n'), 'utf8');
  await writeFile(resolve(consumerRoot, 'verify.mjs'), [
    "await import('@openge/forge-peer-network');",
    "await import('@openge/forge-peer-network-libp2p/node');",
    "await import('@openge/forge-peer-network-libp2p/browser');",
    "await import('@openge/forge-peer-network-libp2p/relay');",
    "await import('@openge/forge-peer-network-websocket/client');",
    "await import('@openge/forge-peer-network-websocket/hub');",
    "await import('@openge/forge-peer-network-websocket/server');",
    "console.log('Clean tarball consumer imported every public entry.');",
    '',
  ].join('\n'), 'utf8');

  runPnpm(['install', '--prefer-offline', '--frozen-lockfile=false'], {
    cwd: consumerRoot,
  });
  return run(process.execPath, ['verify.mjs'], { cwd: consumerRoot });
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
