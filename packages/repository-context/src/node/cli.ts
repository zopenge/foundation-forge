#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createRepositoryInvestigator } from '../investigation/investigator.js';
import { buildRepositoryCorpus } from './build.js';
import type { RepositoryLanguage } from './contracts.js';
import { createFileReader, readRanges, verifyGenerationCurrent } from './reader.js';
import { loadCurrentGeneration } from './store.js';

export interface RepositoryContextCliIo {
  write(value: string): void;
}

const parse = (args: readonly string[]): { readonly command: string; readonly values: ReadonlyMap<string, readonly string[]> } => {
  const [command = '', ...rest] = args;
  const values = new Map<string, string[]>();
  const allowed = new Set(['--root', '--index', '--corpus', '--scope', '--language', '--tsconfig', '--query']);
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index] ?? '';
    const value = rest[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--')) {
      throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { flag } });
    }
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  return { command, values };
};

const one = (values: ReadonlyMap<string, readonly string[]>, name: string, required = true): string | undefined => {
  const found = values.get(name);
  if (found && found.length === 1) return found[0];
  if (!required && found === undefined) return undefined;
  throw Object.assign(new Error('invalid command argument'), { code: 'INVALID_ARGUMENT', details: { field: name } });
};

const many = (values: ReadonlyMap<string, readonly string[]>, name: string): readonly string[] => values.get(name) ?? [];

export const runRepositoryContextCli = async (
  args: readonly string[],
  io: RepositoryContextCliIo = { write: (value) => process.stdout.write(`${value}\n`) },
): Promise<number> => {
  try {
    const parsed = parse(args);
    const rootDir = one(parsed.values, '--root');
    const indexRoot = one(parsed.values, '--index');
    if (!rootDir || !indexRoot) throw Object.assign(new Error('missing path'), { code: 'INVALID_ARGUMENT' });
    if (parsed.command === 'build') {
      const corpusId = one(parsed.values, '--corpus');
      const scopes = many(parsed.values, '--scope');
      const languages = many(parsed.values, '--language');
      if (!corpusId || scopes.length === 0 || languages.some((value) => value !== 'typescript' && value !== 'cpp')) {
        throw Object.assign(new Error('invalid build arguments'), { code: 'INVALID_ARGUMENT' });
      }
      const tsconfigPath = one(parsed.values, '--tsconfig', false);
      const result = await buildRepositoryCorpus({
        rootDir,
        indexRoot,
        corpusId,
        scopes,
        languages: languages as readonly RepositoryLanguage[],
        ...(tsconfigPath === undefined ? {} : { tsconfigPath }),
      });
      io.write(JSON.stringify(result));
      return result.status === 'ok' ? 0 : 1;
    }
    const generation = await loadCurrentGeneration(indexRoot);
    const verification = await verifyGenerationCurrent({ rootDir, generation });
    if (parsed.command === 'check') {
      io.write(JSON.stringify({ status: verification.corpusState === 'current-verified' ? 'ok' : 'stale', ...verification }));
      return verification.corpusState === 'current-verified' ? 0 : 1;
    }
    if (parsed.command === 'investigate') {
      if (verification.corpusState !== 'current-verified') {
        io.write(JSON.stringify({ status: 'error', diagnostics: verification.diagnostics }));
        return 1;
      }
      const query = one(parsed.values, '--query');
      if (!query) throw Object.assign(new Error('missing query'), { code: 'INVALID_ARGUMENT' });
      const reader = createFileReader({ rootDir, corpusId: generation.corpusId, generationId: generation.generationId });
      const investigator = createRepositoryInvestigator({
        corpus: generation.corpus,
        readRanges: (ranges) => readRanges(reader, ranges),
        route: 'investigate-relations',
        preferredScopes: many(parsed.values, '--scope'),
        promoteRelationEndpoints: true,
      });
      const result = await investigator.investigate({ query });
      io.write(JSON.stringify(result));
      return result.status === 'ok' || result.status === 'ambiguous' ? 0 : 1;
    }
    throw Object.assign(new Error('unknown command'), { code: 'INVALID_ARGUMENT', details: { command: parsed.command } });
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    const details = (error as { readonly details?: unknown }).details;
    io.write(JSON.stringify({
      schemaVersion: 1,
      status: 'error',
      diagnostics: [{ code: typeof code === 'string' ? code : 'INTERNAL_ERROR', details: details ?? {} }],
    }));
    return 1;
  }
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runRepositoryContextCli(process.argv.slice(2));
}
