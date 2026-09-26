import assert from 'node:assert/strict';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { resolvePolicies } from '@openge/forge-repository-policy';
import {
  checkPolicyRepository,
  preparePolicyRepository,
  resolvePolicyBundle,
} from '@openge/forge-repository-policy/node';

assert.equal(typeof resolvePolicies, 'function');
assert.equal(typeof checkPolicyRepository, 'function');

const binaries = JSON.parse(
  process.env.PACKAGE_CONSUMER_BINARIES ?? '{}',
);
const binary = binaries['forge-repository-policy'];
if (typeof binary !== 'string') {
  throw new Error('repository-policy binary was not provided');
}

const fixture = join(process.cwd(), 'fixture');
await rm(fixture, { recursive: true, force: true });
await mkdir(join(fixture, '.forge'), { recursive: true });
await mkdir(join(fixture, 'rules'), { recursive: true });
const manifest = {
  schemaVersion: 1,
  factIds: [],
  policies: [{
    id: 'base',
    source: { path: 'rules/base.md' },
    when: { always: true },
    requires: [],
    conflictsWith: [],
    checkIds: ['danger'],
  }],
  checks: [{
    id: 'danger',
    kind: 'package-script',
    packageJson: 'package.json',
    script: 'danger',
  }],
};

const request = {
  schemaVersion: 1,
  contextId: 'consumer',
  scope: { paths: [], complete: true },
  facts: [],
  evidence: [],
};
await writeFile(
  join(fixture, '.forge', 'repository-policy.json'),
  JSON.stringify(manifest),
  'utf8',
);
await writeFile(
  join(fixture, 'rules', 'base.md'),
  'consumer base\n',
  'utf8',
);
await writeFile(
  join(fixture, 'package.json'),
  JSON.stringify({
    scripts: {
      danger: 'node -e "require(\'fs\').writeFileSync(\'side-effect.txt\',\'bad\')"',
    },
  }),
  'utf8',
);

const run = (args, input) => spawnSync(
  process.execPath,
  [binary, ...args],
  {
    cwd: fixture,
    encoding: 'utf8',
    input,
    shell: false,
  },
);
const check = run([
  'check',
  '--root', fixture,
  '--manifest', '.forge/repository-policy.json',
]);
assert.equal(check.status, 0, check.stderr);
assert.equal(JSON.parse(check.stdout).state, 'passed');
await assert.rejects(access(join(fixture, 'side-effect.txt')));

const resolveInline = run([
  'resolve',
  '--root', fixture,
  '--manifest', '.forge/repository-policy.json',
  '--input', '-',
  '--delivery', 'inline',
], JSON.stringify(request));
assert.equal(resolveInline.status, 0, resolveInline.stderr);
const inline = JSON.parse(resolveInline.stdout);
assert.equal(inline.resolution.state, 'ready');
assert.equal(inline.deliveryComplete, true);
assert.equal(inline.documents[0]?.text, 'consumer base\n');
const resolveReferences = run([
  'resolve',
  '--root', fixture,
  '--manifest', '.forge/repository-policy.json',
  '--input', '-',
  '--delivery', 'references',
], JSON.stringify(request));
assert.equal(resolveReferences.status, 2, resolveReferences.stderr);
const references = JSON.parse(resolveReferences.stdout);
assert.equal(references.deliveryComplete, false);
assert.equal(references.documents[0]?.text, null);

const invalid = run([
  'resolve',
  '--root', fixture,
  '--manifest', '.forge/repository-policy.json',
  '--input', '-',
  '--delivery', 'inline',
  '--provider', 'jev',
], JSON.stringify(request));
assert.equal(invalid.status, 1, invalid.stderr);
assert.equal(
  JSON.parse(invalid.stdout).diagnostics[0]?.code,
  'INVALID_ARGUMENT',
);

const prepared = await preparePolicyRepository({
  root: fixture,
  manifestPath: '.forge/repository-policy.json',
  preload: 'policy-sources',
});
assert.equal(prepared.ok, true);
if (!prepared.ok) throw new Error('prepared consumer failed');
await writeFile(join(fixture, 'rules', 'base.md'), 'updated base\n', 'utf8');
const cached = await prepared.repository.resolve(request);
assert.equal(cached.deliveryComplete, true);
assert.equal(cached.documents[0]?.text, 'consumer base\n');
const fresh = await resolvePolicyBundle({
  root: fixture,
  manifestPath: '.forge/repository-policy.json',
  request,
});
assert.equal(fresh.deliveryComplete, true);
assert.equal(fresh.documents[0]?.text, 'updated base\n');
assert.notEqual(cached.bundleDigest, fresh.bundleDigest);
await assert.rejects(access(join(fixture, 'side-effect.txt')));

await rm(fixture, { recursive: true, force: true });
