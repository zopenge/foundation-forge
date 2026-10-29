import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { runCleanPackageConsumer } from './package-consumer-runner.mjs';
import { loadPackageVerification } from './package-verification.mjs';
import { createPropagationBudget, fetchRegistryResponse, releaseError } from './release-propagation.mjs';
import { createPublicConsumerEnvironment } from './release-environment.mjs';
import { installRegistryConsumer } from './release-install.mjs';

const packageUrl = (registry, name) => `${registry}/${encodeURIComponent(name)}`;

export const readPackageRegistryMetadata = async ({
  fetch: fetchImplementation = globalThis.fetch,
  name,
  registry,
  budget,
}) => {
  if (budget && budget.remaining() <= 0) throw budget.timeout();
  const response = await fetchImplementation(packageUrl(registry, name), {
    headers: { accept: 'application/json' },
    signal: globalThis.AbortSignal.timeout(Math.min(30_000, budget?.remaining() ?? 30_000)),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw releaseError('REGISTRY_HTTP_ERROR', `npm registry returned ${String(response.status)} for ${name}`, { status: response.status });
  const metadata = await response.json();
  if (metadata == null || typeof metadata !== 'object' || typeof metadata.versions !== 'object') {
    throw new Error(`npm registry returned invalid metadata for ${name}`);
  }
  return metadata;
};

export const selectBootstrapCandidates = (packageStates) => packageStates.flatMap((state) => {
  if (state.metadata !== undefined) return [];
  if (!/^\d+\.\d+\.\d+-rc\.0$/u.test(state.version)) {
    throw new Error(`${state.name}@${state.version} must use rc.0 for bootstrap publishing`);
  }
  return [state.name];
});

export const assertReleaseVersionMetadata = ({ metadata, mode, name, version }) => {
  const versionMetadata = metadata?.versions?.[version];
  if (versionMetadata?.dist?.tarball === undefined || versionMetadata.dist.integrity === undefined) {
    throw new Error(`${name}@${version} is missing from npm registry metadata`);
  }
  const expectedTag = mode === 'stable' ? 'latest' : 'next';
  if (metadata['dist-tags']?.[expectedTag] !== version) {
    throw new Error(`${name}@${version} is not selected by the ${expectedTag} dist-tag`);
  }
  return versionMetadata;
};

const hasExpectedIntegrity = (bytes, integrity) => {
  const separator = integrity.indexOf('-');
  if (separator === -1) return false;
  const algorithm = integrity.slice(0, separator);
  const expected = integrity.slice(separator + 1);
  return createHash(algorithm).update(bytes).digest('base64') === expected;
};

export const waitForPackageVersion = async ({
  fetch: fetchImplementation = globalThis.fetch,
  intervalMilliseconds,
  mode,
  name,
  registry,
  timeoutMilliseconds,
  version,
  budget = createPropagationBudget({ timeoutMilliseconds, intervalMilliseconds }),
}) => {
  return budget.retry(async () => {
    const read = async (url, accept) => {
      const response = await fetchRegistryResponse({ fetch: fetchImplementation, url, accept, budget });
      const metadata = await response.json();
      if (!metadata || !metadata.versions || typeof metadata.versions !== 'object') {
        throw releaseError('REGISTRY_METADATA_INVALID', `${name} 的 registry 元数据无效`);
      }
      if (!metadata.versions[version]) {
        throw releaseError('REGISTRY_PENDING', `${name}@${version} 的元数据尚未就绪`);
      }
      if (mode !== undefined && metadata['dist-tags']?.[mode === 'stable' ? 'latest' : 'next'] !== version) {
        throw releaseError('REGISTRY_PENDING', `${name}@${version} 的 dist-tag 尚未就绪`);
      }
      const versionMetadata = metadata.versions[version];
      if (typeof versionMetadata.dist?.tarball !== 'string' || typeof versionMetadata.dist.integrity !== 'string') {
        throw releaseError('REGISTRY_METADATA_INVALID', `${name}@${version} 缺少 tarball 或 integrity`);
      }
      return { metadata, versionMetadata };
    };
    const full = await read(packageUrl(registry, name), 'application/json');
    const abbreviated = await read(`${registry}/${name.replace('/', '%2F')}`,
      'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*');
    if (abbreviated.versionMetadata.dist.integrity !== full.versionMetadata.dist.integrity) {
      throw releaseError('REGISTRY_INTEGRITY_ERROR', `${name}@${version} 的两种元数据完整性不一致`);
    }
    const response = await fetchRegistryResponse({ fetch: fetchImplementation,
      url: full.versionMetadata.dist.tarball, budget });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!hasExpectedIntegrity(bytes, full.versionMetadata.dist.integrity)) {
      throw releaseError('REGISTRY_INTEGRITY_ERROR', `${name}@${version} 的 tarball 完整性不符`);
    }
    return { ...full, tarballBytes: bytes };
  });
};

const decodePayload = (attestation) => JSON.parse(Buffer.from(
  attestation.bundle.dsseEnvelope.payload,
  'base64',
).toString('utf8'));

export const verifyProvenanceAttestation = ({
  attestations,
  commit,
  integrity,
  name,
  policy,
  version,
}) => {
  const attestation = attestations?.attestations?.find(
    ({ predicateType }) => predicateType === 'https://slsa.dev/provenance/v1',
  );
  if (attestation === undefined) throw new Error(`${name}@${version} has no SLSA provenance attestation`);
  const payload = decodePayload(attestation);
  const subject = payload.subject?.find(({ name: subjectName }) => (
    subjectName === `pkg:npm/${name.replace(/^@/u, '%40')}@${version}`
  ));
  if (subject === undefined) throw new Error(`${name}@${version} provenance subject does not match`);
  const integrityBytes = Buffer.from(integrity.slice(integrity.indexOf('-') + 1), 'base64');
  if (subject.digest?.sha512 !== integrityBytes.toString('hex')) {
    throw new Error(`${name}@${version} provenance digest does not match`);
  }
  const workflow = payload.predicate?.buildDefinition?.externalParameters?.workflow;
  if (workflow?.repository !== `https://github.com/${policy.githubRepository}`) {
    throw new Error(`${name}@${version} provenance repository does not match`);
  }
  if (workflow.path !== `.github/workflows/${policy.workflow}`) {
    throw new Error(`${name}@${version} provenance workflow does not match`);
  }
  if (workflow.ref !== `refs/heads/${policy.branch}`) {
    throw new Error(`${name}@${version} provenance ref does not match`);
  }
  const commits = payload.predicate?.buildDefinition?.resolvedDependencies
    ?.map(({ digest }) => digest?.gitCommit)
    .filter(Boolean) ?? [];
  if (!commits.includes(commit)) throw new Error(`${name}@${version} provenance commit does not match`);
};

const captureGit = (args, repositoryRoot) => {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
};

export const readReleaseTagCommit = ({ mode, packageValue, repositoryRoot }) => {
  const tag = `${packageValue.name}@${packageValue.version}`;
  if (mode === 'bootstrap') {
    const commit = captureGit(['rev-list', '-n', '1', tag], repositoryRoot);
    if (commit === '') throw new Error(`local Git tag ${tag} is missing`);
    return commit;
  }
  const output = captureGit(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], repositoryRoot);
  const commit = output.split(/\s+/u)[0] ?? '';
  if (commit === '') throw new Error(`remote Git tag ${tag} is missing`);
  return commit;
};

const releaseCandidates = (packages, mode, selectedNames) => {
  if (selectedNames.length > 0) {
    const byName = new Map(packages.map((value) => [value.name, value]));
    return selectedNames.map((name) => {
      const value = byName.get(name);
      if (value === undefined) throw new Error(`unknown workspace package: ${name}`);
      return value;
    });
  }
  if (mode === 'bootstrap') throw new Error('bootstrap verification requires at least one --package');
  const prerelease = /-/u;
  return packages.filter(({ version }) => mode === 'next'
    ? prerelease.test(version)
    : !prerelease.test(version));
};

export const selectReleasePackages = (packages, mode, selectedNames = []) => {
  const targets = releaseCandidates(packages, mode, [...new Set(selectedNames)]);
  const byName = new Map(packages.map((value) => [value.name, value]));
  const names = new Set();
  const visit = (name) => {
    if (names.has(name)) return;
    const value = byName.get(name);
    if (!value) throw new Error(`unknown workspace dependency: ${name}`);
    names.add(name);
    for (const dependency of value.workspaceDependencies) visit(dependency);
  };
  for (const { name } of targets) visit(name);
  return { targets, packages: packages.filter(({ name }) => names.has(name)) };
};

export const verifyRegistryPackages = async ({
  expectedCommit,
  fetch: fetchImplementation = globalThis.fetch,
  mode,
  model,
  packageNames = [],
  policy,
  verificationRoot,
  onEvent = async () => {},
  resolveCommit = readReleaseTagCommit,
  budget = createPropagationBudget({ timeoutMilliseconds: policy.pollTimeoutMilliseconds }),
}) => {
  const { targets, packages } = selectReleasePackages(model.packages, mode, packageNames);
  if (targets.length === 0) throw new Error(`no ${mode} package versions were selected for verification`);
  const inside = relative(resolve(model.repositoryRoot, '.tmp'), verificationRoot);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('unsafe registry verification directory');
  await mkdir(verificationRoot, { recursive: true });
  const actual = relative(await realpath(resolve(model.repositoryRoot, '.tmp')), await realpath(verificationRoot));
  if (!actual || actual.startsWith('..') || isAbsolute(actual)) throw new Error('unsafe registry verification symlink');
  await rm(verificationRoot, { force: true, recursive: true });
  await mkdir(verificationRoot, { recursive: true });
  try {
    await onEvent({ stage: 'registry', state: 'started' });
    for (const packageValue of packages) {
      packageValue.verification = await loadPackageVerification(packageValue);
    }
    for (const packageValue of packages) {
      const isTarget = targets.some(({ name }) => name === packageValue.name);
      const result = await waitForPackageVersion({
        fetch: fetchImplementation,
        budget,
        mode: isTarget ? mode : undefined,
        name: packageValue.name,
        registry: policy.registry,
        timeoutMilliseconds: policy.pollTimeoutMilliseconds,
        version: packageValue.version,
      });
      if (!isTarget) continue;
      const tagCommit = await resolveCommit({ mode, packageValue, repositoryRoot: model.repositoryRoot });
      if (expectedCommit !== undefined && tagCommit !== expectedCommit) {
        throw new Error(`${packageValue.name}@${packageValue.version} Git tag points to a different commit`);
      }
      if (mode !== 'bootstrap') {
        const attestationUrl = result.versionMetadata.dist.attestations?.url;
        if (typeof attestationUrl !== 'string') {
          throw new Error(`${packageValue.name}@${packageValue.version} has no provenance URL`);
        }
        const response = await budget.retry(() => fetchRegistryResponse({ fetch: fetchImplementation,
          url: attestationUrl, accept: 'application/json', budget }));
        verifyProvenanceAttestation({
          attestations: await response.json(),
          commit: tagCommit,
          integrity: result.versionMetadata.dist.integrity,
          name: packageValue.name,
          policy,
          version: packageValue.version,
        });
      }
      await onEvent({ stage: 'registry', state: 'verified', name: packageValue.name });
      process.stdout.write(`Registry 元数据、tarball 和来源检查通过：${packageValue.name}@${packageValue.version}。\n`);
    }
    await onEvent({ stage: 'registry', state: 'succeeded' });
    const references = new Map(packages.map(({ name, version }) => [name, version]));
    const consumerRoot = resolve(verificationRoot, 'consumer');
    const emptyConfig = resolve(verificationRoot, 'empty.npmrc');
    await writeFile(emptyConfig, '', 'utf8');
    const env = createPublicConsumerEnvironment(process.env, emptyConfig);
    await onEvent({ stage: 'consumer', state: 'started' });
    process.stdout.write(`${await runCleanPackageConsumer({ consumerRoot,
      model: { ...model, packages }, references, env,
      install: ({ cwd }) => installRegistryConsumer({ cwd, env, budget,
        confirmedNames: new Set(packages.map(({ name }) => name)),
        onRetry: ({ attempt, waitMilliseconds, error }) => process.stdout.write(
          `消费者安装等待传播：${error.code}，第 ${String(attempt)} 次重试将在 ${String(waitMilliseconds / 1_000)} 秒后执行。\n`),
      }),
    })}\n`);
    await onEvent({ stage: 'consumer', state: 'succeeded' });
    return targets;
  } finally {
    await rm(verificationRoot, { force: true, recursive: true });
  }
};
