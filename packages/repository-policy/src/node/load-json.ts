import {
  parse,
  visit,
  type ParseError,
} from 'jsonc-parser';

import { readRepositoryBytes } from './read-sources.js';

export interface StrictJsonLoadSuccess {
  readonly ok: true;
  readonly value: unknown;
  readonly utf8Bytes: number;
}

export interface StrictJsonLoadFailure {
  readonly ok: false;
  readonly code: string;
}

export type StrictJsonLoadResult =
  | StrictJsonLoadSuccess
  | StrictJsonLoadFailure;

const decodeJsonText = (
  bytes: Uint8Array,
): string | null => {
  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    return text.includes('\ufffd') ? null : text;
  } catch {
    return null;
  }
};
const hasDuplicateJsonKey = (text: string): boolean => {
  const objectKeys: Set<string>[] = [];
  let duplicate = false;
  visit(
    text,
    {
      onObjectBegin: () => {
        objectKeys.push(new Set());
      },
      onObjectProperty: (property) => {
        const current = objectKeys.at(-1);
        if (current === undefined) return;
        if (current.has(property)) duplicate = true;
        current.add(property);
      },
      onObjectEnd: () => {
        objectKeys.pop();
      },
    },
    {
      disallowComments: true,
      allowTrailingComma: false,
      allowEmptyContent: false,
    },
  );
  return duplicate;
};
export const parseStrictJsonBytes = (
  bytes: Uint8Array,
  maxBytes: number,
): StrictJsonLoadResult => {
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      code: 'INPUT_LIMIT',
    };
  }

  const text = decodeJsonText(bytes);
  if (text === null) {
    return {
      ok: false,
      code: 'INVALID_UTF8',
    };
  }

  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (hasDuplicateJsonKey(text)) {
    return {
      ok: false,
      code: 'DUPLICATE_JSON_KEY',
    };
  }
  if (errors.length > 0 || value === undefined) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
    };
  }

  return {
    ok: true,
    value,
    utf8Bytes: bytes.byteLength,
  };
};

export const loadStrictJsonFile = async (
  root: string,
  logicalPath: string,
  maxBytes: number,
  fieldPath = 'manifestPath',
): Promise<StrictJsonLoadResult> => {
  const source = await readRepositoryBytes(
    root,
    logicalPath,
    maxBytes,
    fieldPath,
  );
  if (!source.ok) {
    return {
      ok: false,
      code: source.diagnostic.code,
    };
  }
  return parseStrictJsonBytes(source.value.bytes, maxBytes);
};
