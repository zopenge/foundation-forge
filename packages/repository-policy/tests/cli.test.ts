import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  runRepositoryPolicyCli,
  type RepositoryPolicyCliIo,
} from '../src/node/cli.js';
import { sampleRequest } from './support/sample.js';
import { withPolicyFixture } from './support/node-fixture.js';

const readyRequest = {
  ...sampleRequest,
  facts: [{
    id: 'api-impact',
    state: 'false',
    basis: 'verified',
    contextId: 'fixture-1',
    evidenceIds: ['e1'],
  }],
  evidence: [{
    id: 'e1',
    contextId: 'fixture-1',
    sourceId: 'source-1',
    digest: 'sha256:fixture',
  }],
} as const;

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
const runCli = async (
  args: readonly string[],
  stdin = new Uint8Array(),
): Promise<CliResult> => {
  let stdout = '';
  let stderr = '';
  const io: RepositoryPolicyCliIo = {
    readStdin: async () => stdin,
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  };
  const exitCode = await runRepositoryPolicyCli(args, io);
  return { exitCode, stdout, stderr };
};

const resolveArgs = (
  root: string,
  input: string,
  delivery: 'inline' | 'references' = 'inline',
): readonly string[] => [
  'resolve',
  '--root', root,
  '--manifest', '.forge/repository-policy.json',
  '--input', input,
  '--delivery', delivery,
];

describe('repository policy CLI', () => {
  it('emits one parseable JSON check result on stdout', async () => {
    await withPolicyFixture(async ({ root }) => {
      const result = await runCli([
        'check',
        '--root', root,
        '--manifest', '.forge/repository-policy.json',
      ]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).state).toBe('passed');
      expect(result.stderr).toBe('');
    });
  });
  it.each([
    ['unknown flag', ['check', '--root', 'missing', '--manifest', 'x', '--wat', 'x']],
    ['duplicate flag', ['check', '--root', 'a', '--root', 'b', '--manifest', 'x']],
    ['provider flag', ['resolve', '--root', 'x', '--manifest', 'm', '--input', '-', '--delivery', 'inline', '--provider', 'jev']],
    ['small output budget', ['resolve', '--root', 'x', '--manifest', 'm', '--input', '-', '--delivery', 'inline', '--max-output-bytes', '1023']],
  ] as const)('rejects %s before source or stdin I/O', async (_name, args) => {
    let stdinRead = false;
    let stdout = '';
    const exitCode = await runRepositoryPolicyCli(args, {
      readStdin: async () => {
        stdinRead = true;
        throw new Error('stdin must not be read');
      },
      writeStdout: (value) => {
        stdout += value;
      },
      writeStderr: () => {},
    });
    expect(exitCode).toBe(1);
    expect(stdinRead).toBe(false);
    expect(JSON.parse(stdout).diagnostics[0].code).toBe('INVALID_ARGUMENT');
  });

  it('returns exit 1 for a non-repository/missing manifest input', async () => {
    const root = await mkdtemp(join(process.cwd(), '.tmp-cli-missing-'));
    try {
      const result = await runCli([
        'check',
        '--root', root,
        '--manifest', '.forge/repository-policy.json',
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).diagnostics[0].code).toBe('SOURCE_MISSING');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('resolves a ready request from stdin with exit 0 and inline text', async () => {
    await withPolicyFixture(async ({ root }) => {
      const stdin = Buffer.from(JSON.stringify(readyRequest), 'utf8');
      const result = await runCli(resolveArgs(root, '-'), stdin);
      const parsed = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(parsed.resolution.state).toBe('ready');
      expect(parsed.deliveryComplete).toBe(true);
      expect(parsed.documents.every((item: { text: string | null }) => item.text !== null)).toBe(true);
    });
  });

  it('returns exit 2 for needs-context even when inline delivery is complete', async () => {
    await withPolicyFixture(async ({ root }) => {
      const stdin = Buffer.from(JSON.stringify(sampleRequest), 'utf8');
      const result = await runCli(resolveArgs(root, '-'), stdin);
      const parsed = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(2);
      expect(parsed.resolution.state).toBe('needs-context');
      expect(parsed.deliveryComplete).toBe(true);
    });
  });

  it('returns references-only output with exit 2 and no source text', async () => {
    await withPolicyFixture(async ({ root }) => {
      const stdin = Buffer.from(JSON.stringify(readyRequest), 'utf8');
      const result = await runCli(resolveArgs(root, '-', 'references'), stdin);
      const parsed = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(2);
      expect(parsed.deliveryComplete).toBe(false);
      expect(parsed.documents.every((item: { text: string | null }) => item.text === null)).toBe(true);
      expect(parsed.documents.every((item: { sha256: string }) => /^[0-9a-f]{64}$/u.test(item.sha256))).toBe(true);
    });
  });
  it('loads a strict request file from inside root', async () => {
    await withPolicyFixture(async ({ root, write }) => {
      await write('request.json', JSON.stringify(readyRequest));
      const result = await runCli(resolveArgs(root, 'request.json'));
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).resolution.state).toBe('ready');
    });
  });

  it('rejects duplicate request JSON keys', async () => {
    await withPolicyFixture(async ({ root, write }) => {
      await write(
        'request.json',
        '{"schemaVersion":1,"schemaVersion":1,"contextId":"x","scope":{"paths":[],"complete":false},"facts":[],"evidence":[]}',
      );
      const result = await runCli(resolveArgs(root, 'request.json'));
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).diagnostics[0].code).toBe('DUPLICATE_JSON_KEY');
    });
  });

  it('enforces the final UTF-8 wire budget without truncating JSON', async () => {
    await withPolicyFixture(async ({ root, write }) => {
      await write('rules/base.md', '中'.repeat(600));
      const stdin = Buffer.from(JSON.stringify(readyRequest), 'utf8');
      const args = [
        ...resolveArgs(root, '-'),
        '--max-output-bytes', '1024',
      ];
      const result = await runCli(args, stdin);
      const parsed = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(2);
      expect(parsed.deliveryComplete).toBe(false);
      expect(parsed.diagnostics[0].code).toBe('OUTPUT_BUDGET_EXCEEDED');
      expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(1024);
    });
  });
  it('rejects invalid stdin JSON without source delivery', async () => {
    await withPolicyFixture(async ({ root }) => {
      const result = await runCli(
        resolveArgs(root, '-'),
        Buffer.from('{"schemaVersion":1,}', 'utf8'),
      );
      const parsed = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(parsed.diagnostics[0].code).toBe('INVALID_SCHEMA');
      expect(parsed.documents ?? []).toEqual([]);
    });
  });
});
