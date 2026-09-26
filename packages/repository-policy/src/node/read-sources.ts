import { calculateBytesIntegritySync } from '@openge/forge-artifact-integrity/node';
import {
  PathSafetyError,
  pathSafetyErrorCodes,
  resolveExistingPathWithinRoot,
  resolvePathWithinRoot,
} from '@openge/forge-path-safety/node';
import type { Buffer } from 'node:buffer';
import {
  lstat,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PolicyDiagnostic, SourceRef } from '../contracts.js';
import { policyDiagnostic as makePolicyDiagnostic } from '../diagnostics.js';
import type { PolicyDocument } from './contracts.js';

export interface SourceReadTestHooks {
  readonly afterFirstRead?: () => Promise<void>;
}

const policyDiagnostic = (
  code: string,
  fieldPath: string,
  policyIds: readonly string[] = [],
  relatedIds: readonly string[] = [],
): PolicyDiagnostic => makePolicyDiagnostic(
  code,
  'error',
  fieldPath,
  policyIds,
  relatedIds,
);

export interface RepositoryFileInfo {
  readonly resolvedPath: string;
  readonly size: number;
}

export interface RepositoryBytes extends RepositoryFileInfo {
  readonly bytes: Uint8Array;
}
export type RepositoryFileInfoResult =
  | { readonly ok: true; readonly value: RepositoryFileInfo }
  | { readonly ok: false; readonly diagnostic: PolicyDiagnostic };

export type RepositoryBytesResult =
  | { readonly ok: true; readonly value: RepositoryBytes }
  | { readonly ok: false; readonly diagnostic: PolicyDiagnostic };

export type SourceReadResult =
  | { readonly ok: true; readonly document: PolicyDocument }
  | { readonly ok: false; readonly diagnostic: PolicyDiagnostic };

const diagnostic = (
  code: string,
  logicalPath: string,
  policyIds: readonly string[] = [],
): PolicyDiagnostic => policyDiagnostic(
  code,
  'source.path',
  policyIds,
  [logicalPath],
);

const isMissingError = (error: unknown): boolean => (
  error instanceof Error
  && 'code' in error
  && (error as NodeJS.ErrnoException).code === 'ENOENT'
);
const checkExactCase = async (
  root: string,
  logicalPath: string,
): Promise<boolean> => {
  const segments = logicalPath.split('/');
  let current = resolve(root);
  for (const segment of segments) {
    const entries = await readdir(current);
    if (!entries.includes(segment)) return false;
    current = resolve(current, segment);
  }
  return true;
};

export const inspectRepositoryFile = async (
  root: string,
  logicalPath: string,
  maxBytes: number,
  fieldPath = 'source.path',
): Promise<RepositoryFileInfoResult> => {
  let lexicalPath: string;
  try {
    lexicalPath = resolvePathWithinRoot(root, logicalPath);
  } catch {
    return {
      ok: false,
      diagnostic: policyDiagnostic(
        'INVALID_PATH',
        fieldPath,
        [],
        [logicalPath],
      ),
    };
  }
  let lexicalMetadata;
  try {
    lexicalMetadata = await lstat(lexicalPath);
  } catch (error) {
    return {
      ok: false,
      diagnostic: policyDiagnostic(
        isMissingError(error) ? 'SOURCE_MISSING' : 'SOURCE_UNREADABLE',
        fieldPath,
        [],
        [logicalPath],
      ),
    };
  }
  if (lexicalMetadata.isDirectory()) {
    return {
      ok: false,
      diagnostic: policyDiagnostic(
        'SOURCE_UNREADABLE',
        fieldPath,
        [],
        [logicalPath],
      ),
    };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await resolveExistingPathWithinRoot(root, logicalPath);
  } catch (error) {
    const code = error instanceof PathSafetyError
      && error.code === pathSafetyErrorCodes.pathEscape
      ? 'SOURCE_OUTSIDE_ROOT'
      : 'SOURCE_UNREADABLE';
    return {
      ok: false,
      diagnostic: policyDiagnostic(code, fieldPath, [], [logicalPath]),
    };
  }

  try {
    if (!(await checkExactCase(root, logicalPath))) {
      return {
        ok: false,
        diagnostic: policyDiagnostic(
          'INVALID_PATH',
          fieldPath,
          [],
          [logicalPath],
        ),
      };
    }
  } catch {
    return {
      ok: false,
      diagnostic: policyDiagnostic(
        'SOURCE_UNREADABLE',
        fieldPath,
        [],
        [logicalPath],
      ),
    };
  }

  let metadata;
  try {
    metadata = await stat(resolvedPath);
  } catch {
    return {
      ok: false,
      diagnostic: policyDiagnostic(
        'SOURCE_UNREADABLE',
        fieldPath,
        [],
        [logicalPath],
      ),
    };
  }
  if (!metadata.isFile()) {
    return {
      ok: false,
      diagnostic: policyDiagnostic(
        'SOURCE_UNREADABLE',
        fieldPath,
        [],
        [logicalPath],
      ),
    };
  }
  if (metadata.size > maxBytes) {
    return {
      ok: false,
      diagnostic: policyDiagnostic(
        'INPUT_LIMIT',
        fieldPath,
        [],
        [logicalPath],
      ),
    };
  }

  return {
    ok: true,
    value: {
      resolvedPath,
      size: metadata.size,
    },
  };
};
export const readRepositoryBytes = async (
  root: string,
  logicalPath: string,
  maxBytes: number,
  fieldPath = 'source.path',
): Promise<RepositoryBytesResult> => {
  const inspected = await inspectRepositoryFile(
    root,
    logicalPath,
    maxBytes,
    fieldPath,
  );
  if (!inspected.ok) return inspected;

  try {
    const bytes = await readFile(inspected.value.resolvedPath);
    if (bytes.byteLength > maxBytes) {
      return {
        ok: false,
        diagnostic: policyDiagnostic(
          'INPUT_LIMIT',
          fieldPath,
          [],
          [logicalPath],
        ),
      };
    }
    return {
      ok: true,
      value: {
        ...inspected.value,
        bytes: Uint8Array.from(bytes),
      },
    };
  } catch {
    return {
      ok: false,
      diagnostic: policyDiagnostic(
        'SOURCE_UNREADABLE',
        fieldPath,
        [],
        [logicalPath],
      ),
    };
  }
};

const decodeSourceText = (
  bytes: Uint8Array,
): string | null => {
  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return text.includes('\ufffd') ? null : text;
  } catch {
    return null;
  }
};

export const readPolicySource = async (
  root: string,
  source: SourceRef,
  policyIds: readonly string[],
  maxBytes: number,
  hooks: SourceReadTestHooks = {},
  preflight?: RepositoryFileInfo,
): Promise<SourceReadResult> => {
  const inspected = preflight === undefined
    ? await inspectRepositoryFile(
        root,
        source.path,
        maxBytes,
        'source.path',
      )
    : {
        ok: true as const,
        value: preflight,
      };
  if (!inspected.ok) {
    return {
      ok: false,
      diagnostic: {
        ...inspected.diagnostic,
        policyIds,
      },
    };
  }

  // 两次 readFile 各自拥有私有缓冲区；保留真实双读，无需再复制整份规则。
  let firstBytes: Buffer;
  try {
    const bytes = await readFile(
      inspected.value.resolvedPath,
    );
    if (bytes.byteLength > maxBytes) {
      return {
        ok: false,
        diagnostic: policyDiagnostic(
          'INPUT_LIMIT',
          'source.path',
          policyIds,
          [source.path],
        ),
      };
    }
    if (bytes.byteLength !== inspected.value.size) {
      return {
        ok: false,
        diagnostic: diagnostic(
          'SOURCE_CHANGED',
          source.path,
          policyIds,
        ),
      };
    }
    firstBytes = bytes;
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        'SOURCE_UNREADABLE',
        source.path,
        policyIds,
      ),
    };
  }

  await hooks.afterFirstRead?.();

  let currentResolvedPath: string;
  try {
    currentResolvedPath = await resolveExistingPathWithinRoot(
      root,
      source.path,
    );
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        'SOURCE_CHANGED',
        source.path,
        policyIds,
      ),
    };
  }
  if (
    currentResolvedPath
    !== inspected.value.resolvedPath
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'SOURCE_CHANGED',
        source.path,
        policyIds,
      ),
    };
  }

  let secondBytes: Buffer;
  try {
    const bytes = await readFile(
      inspected.value.resolvedPath,
    );
    if (bytes.byteLength > maxBytes) {
      return {
        ok: false,
        diagnostic: diagnostic(
          'SOURCE_CHANGED',
          source.path,
          policyIds,
        ),
      };
    }
    secondBytes = bytes;
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        'SOURCE_CHANGED',
        source.path,
        policyIds,
      ),
    };
  }

  if (!firstBytes.equals(secondBytes)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'SOURCE_CHANGED',
        source.path,
        policyIds,
      ),
    };
  }

  const text = decodeSourceText(secondBytes);
  if (text === null) {
    return {
      ok: false,
      diagnostic: diagnostic(
        'INVALID_UTF8',
        source.path,
        policyIds,
      ),
    };
  }

  const integrity = calculateBytesIntegritySync(
    secondBytes,
  );
  return {
    ok: true,
    document: {
      source,
      policyIds: [...policyIds],
      sha256: integrity.sha256,
      utf8Bytes: integrity.byteLength,
      text,
    },
  };
};
