import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface TemporaryRepository {
  readonly rootDir: string;
  readonly indexRoot: string;
  readonly tsconfigPath: string;
  cleanup(): Promise<void>;
}

export const createTemporaryRepository = async (): Promise<TemporaryRepository> => {
  const rootDir = join(repositoryRoot, '.tmp', 'tests', `repository-${randomUUID()}`);
  const indexRoot = join(rootDir, '.tmp', 'repository-context');
  const tsconfigPath = join(rootDir, 'tsconfig.json');
  await mkdir(join(rootDir, 'src'), { recursive: true });
  await Promise.all([writeFile(join(rootDir, 'src', 'session.ts'), [
    "import { decode } from './decode.js';",
    'export function createSession(input: string): string {',
    '  return decode(input);',
    '}',
  ].join('\n'), 'utf8'), writeFile(join(rootDir, 'src', 'decode.ts'), [
    'export function decode(input: string): string {',
    "  if (input.length === 0) throw new Error('invalid');",
    '  return input;',
    '}',
  ].join('\n'), 'utf8'), writeFile(tsconfigPath, `${JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2023',
      strict: true,
      noEmit: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2)}\n`, 'utf8')]);
  return {
    rootDir,
    indexRoot,
    tsconfigPath,
    cleanup: async () => rm(rootDir, { recursive: true, force: true }),
  };
};
