#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { policyDiagnostic } from '../diagnostics.js';
import { validateResolveRequest } from '../request.js';
import { resolvePolicyBundle } from './bundle.js';
import { checkPolicyRepository } from './check.js';
import { defaultNodePolicyReadLimits } from './contracts.js';
import {
  loadStrictJsonFile,
  parseStrictJsonBytes,
} from './load-json.js';
import {
  presentPolicyBundle,
  type DeliveryMode,
} from './present.js';

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MIN_MAX_OUTPUT_BYTES = 1024;

export interface RepositoryPolicyCliIo {
  readStdin(): Promise<Uint8Array>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}
interface ParsedCli {
  readonly command: 'check' | 'resolve';
  readonly values: ReadonlyMap<string, string>;
}

const cliError = (
  code: string,
  fieldPath: string,
  relatedIds: readonly string[] = [],
): Record<string, unknown> => ({
  schemaVersion: 1,
  status: 'error',
  deliveryComplete: false,
  documents: [],
  diagnostics: [
    policyDiagnostic(
      code,
      'error',
      fieldPath,
      [],
      relatedIds,
    ),
  ],
});

const writeJson = (
  io: RepositoryPolicyCliIo,
  value: unknown,
): void => {
  io.writeStdout(`${JSON.stringify(value)}\n`);
};

const invalidArgument = (
  io: RepositoryPolicyCliIo,
  fieldPath: string,
  relatedIds: readonly string[] = [],
): number => {
  writeJson(io, cliError(
    'INVALID_ARGUMENT',
    fieldPath,
    relatedIds,
  ));
  return 1;
};
const allowedFlags = (
  command: 'check' | 'resolve',
): ReadonlySet<string> => (
  command === 'check'
    ? new Set(['--root', '--manifest'])
    : new Set([
        '--root',
        '--manifest',
        '--input',
        '--delivery',
        '--max-output-bytes',
      ])
);

const parseCli = (
  args: readonly string[],
): ParsedCli | null => {
  const [commandValue, ...rest] = args;
  if (
    commandValue !== 'check'
    && commandValue !== 'resolve'
  ) {
    return null;
  }
  if (rest.length % 2 !== 0) return null;

  const allowed = allowedFlags(commandValue);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      flag === undefined
      || value === undefined
      || !allowed.has(flag)
      || values.has(flag)
      || value.startsWith('--')
    ) {
      return null;
    }
    values.set(flag, value);
  }
  return {
    command: commandValue,
    values,
  };
};
const requiredValue = (
  parsed: ParsedCli,
  name: string,
): string | null => {
  const value = parsed.values.get(name);
  return value === undefined || value.length === 0
    ? null
    : value;
};

const parseOutputBudget = (
  value: string | undefined,
): number | null => {
  if (value === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  if (!/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return (
    Number.isSafeInteger(parsed)
    && parsed >= MIN_MAX_OUTPUT_BYTES
  )
    ? parsed
    : null;
};

const defaultIo = (): RepositoryPolicyCliIo => ({
  readStdin: async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(
        typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Uint8Array.from(chunk),
      );
    }
    const total = chunks.reduce(
      (sum, chunk) => sum + chunk.byteLength,
      0,
    );
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  },
  writeStdout: (value) => {
    process.stdout.write(value);
  },
  writeStderr: (value) => {
    process.stderr.write(value);
  },
});
const loadRequest = async (
  root: string,
  input: string,
  io: RepositoryPolicyCliIo,
): Promise<
  | { readonly ok: true; readonly value: ReturnType<typeof validateResolveRequest> & { readonly ok: true } }
  | { readonly ok: false; readonly code: string; readonly diagnostics?: unknown }
> => {
  const loaded = input === '-'
    ? parseStrictJsonBytes(
        await io.readStdin(),
        defaultNodePolicyReadLimits.requestBytes,
      )
    : await loadStrictJsonFile(
        root,
        input,
        defaultNodePolicyReadLimits.requestBytes,
        'input',
      );

  if (!loaded.ok) {
    return {
      ok: false,
      code: loaded.code,
    };
  }
  const validated = validateResolveRequest(loaded.value);
  if (!validated.ok) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      diagnostics: validated.diagnostics,
    };
  }
  return {
    ok: true,
    value: validated,
  };
};

export const isRepositoryPolicyCliEntry = (
  entry: string | undefined,
  moduleUrl: string,
  realpath: (value: string) => string = realpathSync,
): boolean => {
  if (entry === undefined) return false;
  try {
    return realpath(entry) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
};
export const runRepositoryPolicyCli = async (
  args: readonly string[],
  io: RepositoryPolicyCliIo = defaultIo(),
): Promise<number> => {
  const parsed = parseCli(args);
  if (parsed === null) {
    return invalidArgument(io, 'arguments');
  }

  const root = requiredValue(parsed, '--root');
  const manifestPath = requiredValue(parsed, '--manifest');
  if (root === null || manifestPath === null) {
    return invalidArgument(io, 'arguments');
  }

  if (parsed.command === 'check') {
    const report = await checkPolicyRepository({
      root,
      manifestPath,
    });
    writeJson(io, report);
    return report.state === 'passed'
      ? 0
      : report.state === 'incomplete'
        ? 2
        : 1;
  }

  const input = requiredValue(parsed, '--input');
  const deliveryValue = requiredValue(parsed, '--delivery');
  const maxOutputBytes = parseOutputBudget(
    parsed.values.get('--max-output-bytes'),
  );
  if (
    input === null
    || (deliveryValue !== 'inline' && deliveryValue !== 'references')
    || maxOutputBytes === null
  ) {
    return invalidArgument(io, 'arguments');
  }
  const request = await loadRequest(
    root,
    input,
    io,
  );
  if (!request.ok) {
    if (Array.isArray(request.diagnostics)) {
      writeJson(io, {
        schemaVersion: 1,
        status: 'error',
        deliveryComplete: false,
        documents: [],
        diagnostics: request.diagnostics,
      });
    } else {
      writeJson(io, cliError(
        request.code,
        'input',
        [input],
      ));
    }
    return 1;
  }

  const bundle = await resolvePolicyBundle({
    root,
    manifestPath,
    request: request.value.value,
  });
  const presented = presentPolicyBundle(
    bundle,
    deliveryValue as DeliveryMode,
    maxOutputBytes,
  );
  io.writeStdout(`${presented.json}\n`);
  return presented.exitCode;
};

if (isRepositoryPolicyCliEntry(
  process.argv[1],
  import.meta.url,
)) {
  process.exitCode = await runRepositoryPolicyCli(
    process.argv.slice(2),
  );
}
