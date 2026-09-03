import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { runCleanPackageConsumer } from './package-consumer-runner.mjs';
import { loadPackageVerification } from './package-verification.mjs';

const packageUrl = (registry, name) => `${registry}/${encodeURIComponent(name)}`;

export const readPackageRegistryMetadata = async ({
  fetch: fetchImplementation = globalThis.fetch,
  name,
  registry,
}) => {
  const response = await fetchImplementation(packageUrl(registry, name), {
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry returned ${String(response.status)} for ${name}`);
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
}) => {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const response = await fetchImplementation(packageUrl(registry, name), {
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        const metadata = await response.json();
        const versionMetadata = assertReleaseVersionMetadata({ metadata, mode, name, version });
        const tarballResponse = await fetchImplementation(versionMetadata.dist.tarball);
        if (tarballResponse.ok) {
          const bytes = Buffer.from(await tarballResponse.arrayBuffer());
          if (hasExpectedIntegrity(bytes, versionMetadata.dist.integrity)) {
            return { metadata, tarballBytes: bytes, versionMetadata };
          }
          lastError = new Error(`${name}@${version} tarball integrity does not match registry metadata`);
        } else {
          lastError = new Error(`${name}@${version} tarball returned ${String(tarballResponse.status)}`);
        }
      } else {
        lastError = new Error(`${name}@${version} metadata returned ${String(response.status)}`);
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) break;
    await delay(intervalMilliseconds);
  }
  throw new Error(`${name}@${version} did not finish propagating before the registry timeout`, {
    cause: lastError,
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
};

const resolveTagCommit = ({ mode, packageValue, repositoryRoot }) => {
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

export const verifyRegistryPackages = async ({
  expectedCommit,
  fetch: fetchImplementation = globalThis.fetch,
  mode,
  model,
  packageNames = [],
  policy,
  verificationRoot,
}) => {
  const targets = releaseCandidates(model.packages, mode, packageNames);
  if (targets.length === 0) throw new Error(`no ${mode} package versions were selected for verification`);
  await rm(verificationRoot, { force: true, recursive: true });
  await mkdir(verificationRoot, { recursive: true });
  try {
    for (const packageValue of model.packages) {
      packageValue.verification = await loadPackageVerification(packageValue);
    }
    for (const packageValue of targets) {
      const result = await waitForPackageVersion({
        fetch: fetchImplementation,
        intervalMilliseconds: policy.pollIntervalMilliseconds,
        mode,
        name: packageValue.name,
        registry: policy.registry,
        timeoutMilliseconds: policy.pollTimeoutMilliseconds,
        version: packageValue.version,
      });
      const tagCommit = resolveTagCommit({ mode, packageValue, repositoryRoot: model.repositoryRoot });
      if (expectedCommit !== undefined && tagCommit !== expectedCommit) {
        throw new Error(`${packageValue.name}@${packageValue.version} Git tag points to a different commit`);
      }
      if (mode !== 'bootstrap') {
        const attestationUrl = result.versionMetadata.dist.attestations?.url;
        if (typeof attestationUrl !== 'string') {
          throw new Error(`${packageValue.name}@${packageValue.version} has no provenance URL`);
        }
        const response = await fetchImplementation(attestationUrl, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(`${packageValue.name}@${packageValue.version} provenance returned ${String(response.status)}`);
        }
        verifyProvenanceAttestation({
          attestations: await response.json(),
          commit: tagCommit,
          integrity: result.versionMetadata.dist.integrity,
          name: packageValue.name,
          policy,
          version: packageValue.version,
        });
      }
      process.stdout.write(`Verified registry release ${packageValue.name}@${packageValue.version}.\n`);
    }
    const references = new Map(model.packages.map(({ name, version }) => [name, version]));
    const consumerRoot = resolve(verificationRoot, 'consumer');
    process.stdout.write(`${await runCleanPackageConsumer({ consumerRoot, model, references })}\n`);
    return targets;
  } finally {
    await rm(verificationRoot, { force: true, recursive: true });
  }
};
