import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import type { GenerationFileRecord, SemanticInputKind, SemanticInputRecord } from './contracts.js';

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const portable = (value: string): string => value.replaceAll('\\', '/');

export interface SemanticSnapshot {
  readonly semanticConfigPath: string | null;
  readonly inputs: readonly SemanticInputRecord[];
  readonly configurationDigest: string;
  readonly digest: string;
}

const insideRoot = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${sep}`);

const relativeToRoot = (root: string, candidate: string): string => {
  const path = portable(relative(root, candidate));
  if (!path || path === '.' || path.startsWith('../') || path === '..' || /^[A-Za-z]:\//u.test(path)) {
    throw Object.assign(new Error('semantic input escapes repository root'), {
      code: 'SEMANTIC_INPUT_OUTSIDE_ROOT', details: { path },
    });
  }
  return path;
};

const recordFile = async (root: string, absolutePath: string, kind: SemanticInputKind): Promise<SemanticInputRecord> => {
  const absolute = resolve(absolutePath);
  if (!insideRoot(root, absolute)) {
    throw Object.assign(new Error('semantic input escapes repository root'), {
      code: 'SEMANTIC_INPUT_OUTSIDE_ROOT', details: { path: portable(absolute) },
    });
  }
  const path = relativeToRoot(root, absolute);
  try {
    const actual = await realpath(absolute);
    if (!insideRoot(root, actual)) {
      throw Object.assign(new Error('semantic input resolves outside repository root'), {
        code: 'SEMANTIC_INPUT_OUTSIDE_ROOT', details: { path },
      });
    }
    const bytes = await readFile(actual);
    return { kind, path, state: 'present', sha256: sha256(bytes), resolvedPath: relativeToRoot(root, actual) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind, path, state: 'missing', sha256: null, resolvedPath: null };
    throw error;
  }
};
const addRecord = (target: Map<string, SemanticInputRecord>, record: SemanticInputRecord): void => {
  target.set(`${record.kind}|${record.path}`, record);
};

const nearestPackageJson = (root: string, absolutePath: string): string | null => {
  let current = dirname(absolutePath);
  while (insideRoot(root, current)) {
    const candidate = join(current, 'package.json');
    if (ts.sys.fileExists(candidate)) return candidate;
    if (current === root) break;
    current = dirname(current);
  }
  return null;
};

const readConfiguration = async (root: string, tsconfigPath: string | undefined): Promise<{
  readonly semanticConfigPath: string | null;
  readonly options: ts.CompilerOptions;
  readonly configFiles: readonly string[];
  readonly projectReferences: readonly string[];
}> => {
  if (tsconfigPath === undefined) return { semanticConfigPath: null, options: {}, configFiles: [], projectReferences: [] };
  const absoluteConfig = resolve(tsconfigPath);
  if (!insideRoot(root, absoluteConfig)) {
    throw Object.assign(new Error('tsconfig escapes repository root'), { code: 'SEMANTIC_INPUT_OUTSIDE_ROOT', details: {} });
  }
  const configFiles = new Set<string>();
  const diagnostics: ts.Diagnostic[] = [];
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => root,
    readDirectory: ts.sys.readDirectory,
    fileExists: ts.sys.fileExists,
    readFile: (path) => {
      const absolute = resolve(path);
      if (insideRoot(root, absolute)) configFiles.add(absolute);
      return ts.sys.readFile(path);
    },
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(absoluteConfig, {}, host);
  if (!parsed || diagnostics.length > 0 || parsed.errors.length > 0) {
    throw Object.assign(new Error('invalid TypeScript configuration'), {
      code: 'INVALID_ARGUMENT', details: { kind: 'tsconfig', errorCount: diagnostics.length + (parsed?.errors.length ?? 0) },
    });
  }
  configFiles.add(absoluteConfig);
  const projectReferences = (parsed.projectReferences ?? []).map((reference) => {
    const path = resolve(reference.path);
    return /\.json$/iu.test(path) ? path : join(path, 'tsconfig.json');
  });
  return {
    semanticConfigPath: relativeToRoot(root, absoluteConfig),
    options: parsed.options,
    configFiles: [...configFiles],
    projectReferences,
  };
};
const moduleSpecifiers = async (root: string, files: readonly GenerationFileRecord[]): Promise<readonly {
  readonly containingFile: string; readonly specifier: string;
}[]> => {
  const values: { containingFile: string; specifier: string }[] = [];
  for (const file of files.filter((item) => /\.(?:[cm]?[jt]sx?)$/iu.test(item.path))) {
    const absolute = resolve(root, file.path);
    const text = await readFile(absolute, 'utf8');
    const preprocessed = ts.preProcessFile(text, true, true);
    for (const imported of preprocessed.importedFiles) {
      values.push({ containingFile: absolute, specifier: imported.fileName });
    }
  }
  return values;
};

export const discoverSemanticInputs = async (options: Readonly<{
  rootDir: string;
  tsconfigPath?: string;
  sourceFiles: readonly GenerationFileRecord[];
}>): Promise<SemanticSnapshot> => {
  const root = await realpath(resolve(options.rootDir));
  const configuration = await readConfiguration(root, options.tsconfigPath);
  const records = new Map<string, SemanticInputRecord>();

  for (const configPath of [...configuration.configFiles, ...configuration.projectReferences]) {
    addRecord(records, await recordFile(root, configPath, 'tsconfig'));
  }
  for (const [name, kind] of [
    ['package.json', 'package-json'],
    ['pnpm-workspace.yaml', 'workspace-manifest'],
    ['pnpm-lock.yaml', 'lockfile'],
  ] as const) {
    addRecord(records, await recordFile(root, join(root, name), kind));
  }
  for (const file of options.sourceFiles) {
    const packagePath = nearestPackageJson(root, resolve(root, file.path));
    if (packagePath) addRecord(records, await recordFile(root, packagePath, 'package-json'));
  }

  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: () => root,
    getDirectories: ts.sys.getDirectories,
    ...(ts.sys.realpath === undefined ? {} : { realpath: ts.sys.realpath }),
  };
  for (const imported of await moduleSpecifiers(root, options.sourceFiles)) {
    const resolution = ts.resolveModuleName(imported.specifier, imported.containingFile, configuration.options, resolutionHost);
    const resolved = resolution.resolvedModule?.resolvedFileName;
    if (resolved) {
      const absoluteTarget = resolve(resolved);
      if (!insideRoot(root, absoluteTarget)) {
        throw Object.assign(new Error('resolved module escapes repository root'), {
          code: 'SEMANTIC_INPUT_OUTSIDE_ROOT', details: { specifier: imported.specifier },
        });
      }
      addRecord(records, await recordFile(root, absoluteTarget, 'module-target'));
      const packagePath = nearestPackageJson(root, absoluteTarget);
      if (packagePath) addRecord(records, await recordFile(root, packagePath, 'package-json'));
      continue;
    }
    const failed = (resolution as typeof resolution & { readonly failedLookupLocations?: readonly string[] }).failedLookupLocations ?? [];
    const underRoot = [...new Set(failed.map((item) => resolve(item)).filter((item) => insideRoot(root, item)))]
      .filter((item) => /\.(?:[cm]?[jt]sx?|json)$/iu.test(item))
      .slice(0, 32);
    for (const missing of underRoot) addRecord(records, await recordFile(root, missing, 'missing-module-target'));
  }

  const inputs = [...records.values()].sort((left, right) => `${left.kind}|${left.path}`.localeCompare(`${right.kind}|${right.path}`));
  const configurationDigest = sha256(JSON.stringify({
    options: configuration.options,
    projectReferences: configuration.projectReferences.map((path) => portable(relative(root, path))).sort(),
  }));
  const digest = sha256(JSON.stringify({ semanticConfigPath: configuration.semanticConfigPath, inputs, configurationDigest }));
  return { semanticConfigPath: configuration.semanticConfigPath, inputs, configurationDigest, digest };
};

export const repositoryInputDigest = (sourceDigest: string, semanticDigest: string): string => sha256(JSON.stringify({
  sourceDigest, semanticDigest,
}));