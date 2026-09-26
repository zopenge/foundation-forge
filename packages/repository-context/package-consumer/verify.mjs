import assert from 'node:assert/strict';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const core = await import('@openge/forge-repository-context');
const nodeApi = await import('@openge/forge-repository-context/node');
const { extractCpp } = await import('@openge/forge-repository-context/adapters/cpp');

const source = {
  corpusId: 'consumer', generationId: 'g1', path: 'src/example.ts', sourceSha256: 'a'.repeat(64),
  normalizedSha256: null, snapshotId: null, lineStart: 1, lineEnd: 1,
};
const corpus = {
  corpusId: 'consumer', generationId: 'g1', corpusState: 'frozen', coverage: 'complete-in-declared-scope',
  entities: [{ id: 'symbol:example', kind: 'symbol', name: 'createExample', owner: null,
    signature: 'function createExample(): void', source, evidenceLevel: 'syntax' }],
  edges: [],
};
assert.deepEqual(core.validateCorpus(corpus), []);
assert.equal(core.searchEntities(corpus, { by: 'symbol', value: 'createExample' }).status, 'ok');
assert.equal(typeof core.selectEvidence, 'function');
assert.equal(typeof core.buildEvidenceUnits, 'function');
const cpp = extractCpp({ path: 'include/example.hpp', text: 'class Example {};', corpusId: 'consumer', generationId: 'g1' });
assert.equal(cpp.readiness, 'ready-for-lexical-evidence');
const fixtureRoot = resolve('.tmp', 'repository-context-consumer');
const indexRoot = resolve(fixtureRoot, '.index');
await rm(fixtureRoot, { recursive: true, force: true });
await mkdir(resolve(fixtureRoot, 'src'), { recursive: true });
await writeFile(resolve(fixtureRoot, 'src', 'example.ts'), [
  'export function createExample(input: string): string {',
  '  return input;',
  '}',
].join('\n') + '\n', 'utf8');
await writeFile(resolve(fixtureRoot, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', strict: true, noEmit: true },
  include: ['src/**/*.ts'],
}, null, 2) + '\n', 'utf8');

const guardPath = resolve(fixtureRoot, 'network-guard.mjs');
await writeFile(guardPath, [
  "import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';",
  "const blocked=()=>{throw new Error('PACKAGE_CONSUMER_NETWORK_FORBIDDEN')};",
  'globalThis.fetch=blocked; http.request=blocked; http.get=blocked; https.request=blocked; https.get=blocked;',
  'net.connect=blocked; net.createConnection=blocked; tls.connect=blocked;',
].join('\n') + '\n', 'utf8');
const binaries = JSON.parse(process.env.PACKAGE_CONSUMER_BINARIES ?? '{}');
const cli = binaries['forge-repository-context'];
assert.equal(typeof cli, 'string');
const guardedEnv = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}` };
const runCli = (args, env = guardedEnv) => {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
};
const common = ['--root', fixtureRoot, '--index', indexRoot];
const built = runCli([
  'build', ...common, '--corpus', 'consumer-cli', '--scope', 'src', '--language', 'typescript',
  '--tsconfig', resolve(fixtureRoot, 'tsconfig.json'),
]);
assert.equal(built.status, 'ok');
assert.equal(runCli(['check', ...common]).corpusState, 'current-verified');
const investigated = runCli([
  'investigate', ...common, '--query', 'createExample', '--scope', 'src/', '--view', 'evidence', '--max-bytes', '4096',
]);
assert.equal(investigated.status, 'ok');
assert.equal(investigated.corpusState, 'current-verified');
assert.equal(investigated.evidence[0]?.wholeFile, true);
assert.deepEqual(investigated.evidence[0]?.deliveredRange, { lineStart: 1, lineEnd: 4 });
assert.equal(investigated.hasMoreEvidence, false);
assert.equal(investigated.internallyTruncated, false);
const cliRead = runCli([
  'read', ...common, '--path', 'src/example.ts', '--line-start', '1', '--line-end', '3', '--max-bytes', '16384',
]);
assert.match(cliRead.texts[0]?.text ?? '', /createExample/u);
let sdkNetworkCalls = 0;
const blockedSdkNetwork = () => { sdkNetworkCalls += 1; throw new Error('PACKAGE_CONSUMER_SDK_NETWORK_FORBIDDEN'); };
const http = (await import('node:http')).default;
const https = (await import('node:https')).default;
const net = (await import('node:net')).default;
const tls = (await import('node:tls')).default;
http.request = blockedSdkNetwork; http.get = blockedSdkNetwork;
https.request = blockedSdkNetwork; https.get = blockedSdkNetwork;
net.connect = blockedSdkNetwork; net.createConnection = blockedSdkNetwork; tls.connect = blockedSdkNetwork;
globalThis.fetch = blockedSdkNetwork;

const generation = await nodeApi.loadCurrentGeneration(indexRoot);
assert.equal((await nodeApi.verifyGenerationCurrent({ rootDir: fixtureRoot, generation })).corpusState, 'current-verified');
const reader = nodeApi.createFileReader({ rootDir: fixtureRoot, corpusId: generation.corpusId, generationId: generation.generationId });
const sdkInvestigator = core.createRepositoryInvestigator({
  corpus: generation.corpus, route: 'investigate', preferredScopes: ['src/'],
  readRanges: (ranges) => nodeApi.readRanges(reader, ranges),
});
assert.equal((await sdkInvestigator.investigate({ query: 'createExample' })).status, 'ok');
const file = generation.files.find((item) => item.path === 'src/example.ts');
assert.ok(file);
const sdkRead = await nodeApi.readRanges(reader, [{
  corpusId: generation.corpusId, generationId: generation.generationId, path: file.path,
  sourceSha256: file.sourceSha256, normalizedSha256: null, snapshotId: null, lineStart: 1, lineEnd: 3,
}]);
assert.match(sdkRead.texts[0]?.text ?? '', /createExample/u);
assert.equal(sdkNetworkCalls, 0);
const consumerRoot = process.env.PACKAGE_CONSUMER_ROOT;
if (process.platform === 'win32' && consumerRoot) {
  const wrapper = resolve(consumerRoot, 'node_modules', '.bin', 'forge-repository-context.cmd');
  await access(wrapper);
  const wrapped = spawnSync(wrapper, ['check', ...common], {
    encoding: 'utf8', windowsHide: true, env: process.env, shell: true,
  });
  assert.equal(wrapped.status, 0, `${wrapped.stdout}\n${wrapped.stderr}`);
  assert.equal(JSON.parse(wrapped.stdout).corpusState, 'current-verified');
}

await rm(fixtureRoot, { recursive: true, force: true });
process.stdout.write('Repository context tarball consumer verified SDK, CLI, offline runtime, and Windows bin boundary.\n');
