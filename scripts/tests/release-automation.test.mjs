import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertReleasePreflight,
  createGitHubReleaseClient,
  filterReleaseLogs,
  selectWorkflowRun,
} from '../github-release.mjs';
import { parseReleaseArguments } from '../release-arguments.mjs';
import { loadReleasePolicy } from '../release-policy.mjs';
import {
  assertReleaseVersionMetadata,
  selectBootstrapCandidates,
  verifyProvenanceAttestation,
  waitForPackageVersion,
} from '../release-registry.mjs';
import {
  ensureTrustedPublisherConfigurations,
  redactSecrets,
} from '../trusted-publishers.mjs';

const createResponse = ({ body = '', json, status = 200 }) => ({
  arrayBuffer: async () => Buffer.from(body),
  json: async () => json,
  ok: status >= 200 && status < 300,
  status,
});

test('derives repository and registry while keeping irreducible release policy centralized', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'foundation-forge-release-policy-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@10.33.2',
    repository: { url: 'git+https://github.com/example/project.git' },
  }));
  await writeFile(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');

  const policy = await loadReleasePolicy(root);

  assert.equal(policy.githubRepository, 'example/project');
  assert.equal(policy.registry, 'https://registry.npmjs.org');
  assert.equal(policy.branch, 'main');
  assert.equal(policy.workflow, 'release.yml');
  assert.equal(policy.environment, 'npm');
  assert.equal(policy.pnpmVersion, '10.33.2');
});

test('parses repeatable package options and explicit retry/log flags', () => {
  assert.deepEqual(parseReleaseArguments([
    '--package', '@example/a',
    '--package', '@example/b',
    '--mode', 'next',
    '--sha', 'abc123',
    '--retry',
    '--logs',
  ]), {
    logs: true,
    mode: 'next',
    packages: ['@example/a', '@example/b'],
    retry: true,
    sha: 'abc123',
  });
  assert.throws(() => parseReleaseArguments(['--package']), /missing value/u);
  assert.throws(() => parseReleaseArguments(['--unknown']), /unknown argument/u);
});

test('reuses matching workflow runs and requires explicit retry after failure', () => {
  const running = { conclusion: null, head_sha: 'abc123', id: 1, status: 'in_progress' };
  assert.deepEqual(selectWorkflowRun([running], { headSha: 'abc123', retry: false }), {
    action: 'reuse',
    run: running,
  });
  const successful = { conclusion: 'success', head_sha: 'abc123', id: 2, status: 'completed' };
  assert.deepEqual(selectWorkflowRun([successful], { headSha: 'abc123', retry: false }), {
    action: 'verify',
    run: successful,
  });
  const failed = { conclusion: 'failure', head_sha: 'abc123', id: 3, status: 'completed' };
  assert.throws(
    () => selectWorkflowRun([failed], { headSha: 'abc123', retry: false }),
    /--retry/u,
  );
  assert.deepEqual(selectWorkflowRun([failed], { headSha: 'abc123', retry: true }), {
    action: 'dispatch',
    previousRun: failed,
  });
  assert.deepEqual(selectWorkflowRun([], { headSha: 'abc123', retry: false }), {
    action: 'dispatch',
    previousRun: undefined,
  });
});

test('lists every release event for status while allowing dispatch-only filtering', async () => {
  const requestedUrls = [];
  const client = createGitHubReleaseClient({
    fetch: async (url) => {
      requestedUrls.push(url);
      return createResponse({ json: { workflow_runs: [] } });
    },
    policy: { githubRepository: 'example/project', workflow: 'release.yml' },
  });

  await client.listRuns();
  await client.listRuns({ event: 'workflow_dispatch' });

  assert.deepEqual(requestedUrls, [
    'https://api.github.com/repos/example/project/actions/workflows/release.yml/runs?per_page=30',
    'https://api.github.com/repos/example/project/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=30',
  ]);
});

test('requires a clean configured branch at the remote commit', () => {
  assert.doesNotThrow(() => assertReleasePreflight({
    branch: 'main',
    configuredBranch: 'main',
    headSha: 'abc123',
    remoteSha: 'abc123',
    status: '',
  }));
  assert.throws(() => assertReleasePreflight({
    branch: 'main',
    configuredBranch: 'main',
    headSha: 'abc123',
    remoteSha: 'abc123',
    status: ' M file',
  }), /clean/u);
  assert.throws(() => assertReleasePreflight({
    branch: 'dev',
    configuredBranch: 'main',
    headSha: 'abc123',
    remoteSha: 'abc123',
    status: '',
  }), /main/u);
  assert.throws(() => assertReleasePreflight({
    branch: 'main',
    configuredBranch: 'main',
    headSha: 'abc123',
    remoteSha: 'different',
    status: '',
  }), /pushed/u);
});

test('filters release logs and redacts credentials', () => {
  assert.equal(filterReleaseLogs([
    'setup noise',
    'Publishing @example/pkg with npm_secret-token',
    'npm error authorization: Bearer abc123',
    'npm error credential github_pat_11AA_secret',
  ].join('\n')), [
    'Publishing @example/pkg with [REDACTED]',
    'npm error authorization: Bearer [REDACTED]',
    'npm error credential [REDACTED]',
  ].join('\n'));
});

test('configures only missing trusted publishers and verifies the result', async () => {
  const configurations = new Map([
    ['@example/configured', [{ environment: 'npm', file: 'release.yml', repository: 'example/project', type: 'github' }]],
    ['@example/missing', []],
  ]);
  const configured = [];

  const result = await ensureTrustedPublisherConfigurations({
    configure: async (name) => {
      configured.push(name);
      configurations.set(name, [{ environment: 'npm', file: 'release.yml', repository: 'example/project', type: 'github' }]);
    },
    expected: { environment: 'npm', file: 'release.yml', repository: 'example/project' },
    listConfigurations: async (name) => configurations.get(name),
    packageNames: ['@example/configured', '@example/missing'],
  });

  assert.deepEqual(configured, ['@example/missing']);
  assert.deepEqual(result, [
    { action: 'unchanged', name: '@example/configured' },
    { action: 'configured', name: '@example/missing' },
  ]);
});

test('redacts OTP values from npm failures', () => {
  assert.equal(
    redactSecrets('npm rejected otp 123456 and token npm_secret', ['123456']),
    'npm rejected otp [REDACTED] and token [REDACTED]',
  );
});

test('accepts bootstrap latest behavior and enforces next tags for workflow releases', () => {
  const version = '0.1.0-rc.0';
  const metadata = {
    'dist-tags': { latest: version, next: version },
    versions: { [version]: { dist: { integrity: 'sha512-value', tarball: 'https://registry.npmjs.org/package.tgz' } } },
  };
  assert.doesNotThrow(() => assertReleaseVersionMetadata({ metadata, mode: 'bootstrap', name: '@example/pkg', version }));
  assert.doesNotThrow(() => assertReleaseVersionMetadata({ metadata, mode: 'next', name: '@example/pkg', version }));
  metadata['dist-tags'].next = '0.1.0-rc.1';
  assert.throws(
    () => assertReleaseVersionMetadata({ metadata, mode: 'next', name: '@example/pkg', version }),
    /next dist-tag/u,
  );
});

test('selects only brand-new rc.0 packages for bootstrap follow-up', () => {
  assert.deepEqual(selectBootstrapCandidates([
    { metadata: undefined, name: '@example/new', version: '0.1.0-rc.0' },
    { metadata: { versions: { '0.1.0': {} } }, name: '@example/existing', version: '0.2.0-rc.0' },
  ]), ['@example/new']);
  assert.throws(() => selectBootstrapCandidates([
    { metadata: undefined, name: '@example/invalid', version: '0.1.0-rc.1' },
  ]), /rc\.0/u);
});

test('waits for both registry metadata and the tarball to become available', async () => {
  let metadataAttempts = 0;
  let tarballAttempts = 0;
  const metadata = {
    'dist-tags': { next: '1.0.0-rc.1' },
    versions: {
      '1.0.0-rc.1': {
        dist: {
          integrity: `sha512-${createHash('sha512').update('test').digest('base64')}`,
          tarball: 'https://registry.npmjs.org/package.tgz',
        },
      },
    },
  };
  const result = await waitForPackageVersion({
    fetch: async (url) => {
      if (url.endsWith('package.tgz')) {
        tarballAttempts += 1;
        return tarballAttempts === 1
          ? createResponse({ status: 404 })
          : createResponse({ body: 'test' });
      }
      metadataAttempts += 1;
      return metadataAttempts === 1
        ? createResponse({ status: 404 })
        : createResponse({ json: metadata });
    },
    intervalMilliseconds: 0,
    mode: 'next',
    name: '@example/pkg',
    registry: 'https://registry.npmjs.org',
    timeoutMilliseconds: 100,
    version: '1.0.0-rc.1',
  });

  assert.equal(result.versionMetadata.dist.tarball, 'https://registry.npmjs.org/package.tgz');
  assert.equal(metadataAttempts, 3);
  assert.equal(tarballAttempts, 2);
});

test('validates provenance package, digest, repository, workflow, ref, and commit', () => {
  const payload = {
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            path: '.github/workflows/release.yml',
            ref: 'refs/heads/main',
            repository: 'https://github.com/example/project',
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: 'abc123' } }],
      },
    },
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{
      digest: { sha512: '74657374' },
      name: 'pkg:npm/%40example/pkg@1.0.0-rc.1',
    }],
  };
  const attestations = {
    attestations: [{
      predicateType: payload.predicateType,
      bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString('base64') } },
    }],
  };

  assert.doesNotThrow(() => verifyProvenanceAttestation({
    attestations,
    commit: 'abc123',
    integrity: 'sha512-dGVzdA==',
    name: '@example/pkg',
    policy: { branch: 'main', githubRepository: 'example/project', workflow: 'release.yml' },
    version: '1.0.0-rc.1',
  }));
  assert.throws(() => verifyProvenanceAttestation({
    attestations,
    commit: 'different',
    integrity: 'sha512-dGVzdA==',
    name: '@example/pkg',
    policy: { branch: 'main', githubRepository: 'example/project', workflow: 'release.yml' },
    version: '1.0.0-rc.1',
  }), /commit/u);
});
