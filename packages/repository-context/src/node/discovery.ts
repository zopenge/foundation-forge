import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { RepositoryLanguage, GenerationFileRecord } from './contracts.js';

const ignoredDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  '.tmp',
  'coverage',
  'dist',
  'node_modules',
]);
const secretBasenames = new Set(['.npmrc', '.yarnrc', '.pypirc']);
const privateKeyPattern = /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*private[^/]*\.(?:pem|key)|[^/]*\.p12)$/iu;

const portable = (value: string): string => value.replaceAll('\\', '/');
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export const assertPortableScope = (scope: string): string => {
  const value = portable(scope);
  if (!value || value.startsWith('/') || /^[A-Za-z]:\//u.test(value) || value.split('/').includes('..')) {
    throw Object.assign(new Error('unsafe scope'), { code: 'UNSAFE_PATH', details: { scope } });
  }
  return value.replace(/\/$/u, '');
};

const extensionAllowed = (path: string, languages: readonly RepositoryLanguage[]): boolean => {
  const lower = path.toLowerCase();
  if (languages.includes('typescript') && /\.(?:[cm]?[jt]sx?)$/u.test(lower)) return true;
  return languages.includes('cpp') && /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/u.test(lower);
};

const fileAllowed = (path: string): boolean => {
  const basename = path.split('/').at(-1)?.toLowerCase() ?? '';
  return !secretBasenames.has(basename) && basename !== '.env' && !basename.startsWith('.env.')
    && !privateKeyPattern.test(path);
};

export interface SourceSnapshot {
  readonly files: readonly GenerationFileRecord[];
  readonly digest: string;
}

export const discoverSourceSnapshot = async (
  rootDir: string,
  scopes: readonly string[],
  languages: readonly RepositoryLanguage[],
): Promise<SourceSnapshot> => {
  const absoluteRoot = resolve(rootDir);
  const rootReal = await realpath(absoluteRoot);
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw Object.assign(new Error('symbolic links are not accepted in declared scopes'), {
          code: 'UNSAFE_PATH', details: { path: portable(relative(absoluteRoot, absolute)) },
        });
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = portable(relative(absoluteRoot, absolute));
      if (fileAllowed(path) && extensionAllowed(path, languages)) paths.push(path);
    }
  };
  for (const rawScope of [...new Set(scopes.map(assertPortableScope))].sort()) {
    const absoluteScope = resolve(absoluteRoot, rawScope);
    if (absoluteScope !== absoluteRoot && !absoluteScope.startsWith(`${absoluteRoot}${sep}`)) {
      throw Object.assign(new Error('unsafe scope'), { code: 'UNSAFE_PATH', details: { scope: rawScope } });
    }
    try {
      const scopeReal = await realpath(absoluteScope);
      if (scopeReal !== rootReal && !scopeReal.startsWith(`${rootReal}${sep}`)) {
        throw Object.assign(new Error('scope escapes root'), { code: 'UNSAFE_PATH', details: { scope: rawScope } });
      }
      const metadata = await lstat(scopeReal);
      if (metadata.isDirectory()) await visit(scopeReal);
      else if (metadata.isFile()) {
        const path = portable(relative(absoluteRoot, scopeReal));
        if (fileAllowed(path) && extensionAllowed(path, languages)) paths.push(path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const files = await Promise.all([...new Set(paths)].sort().map(async (path): Promise<GenerationFileRecord> => {
    const bytes = await readFile(resolve(absoluteRoot, path));
    return { path, sourceSha256: sha256(bytes), size: bytes.byteLength };
  }));
  return { files, digest: sha256(JSON.stringify(files)) };
};
