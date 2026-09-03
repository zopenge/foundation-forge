import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  createWorkspaceGraph,
  type WorkspaceDependency,
  type WorkspaceDependencyKind,
  type WorkspaceGraph,
  type WorkspacePackage,
} from '@openge/forge-workspace-graph';
import { glob } from 'tinyglobby';
import { parse } from 'yaml';

import { workspacePnpmErrorCodes, type ReadPnpmWorkspaceOptions } from './contracts.js';
import { WorkspacePnpmError } from './errors.js';

const dependencyKinds = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const satisfies readonly WorkspaceDependencyKind[];

export async function readPnpmWorkspace(
  options: ReadPnpmWorkspaceOptions,
): Promise<WorkspaceGraph> {
  const cwd = resolve(options.cwd);
  const workspacePath = options.workspaceFile === undefined
    ? resolve(cwd, 'pnpm-workspace.yaml')
    : isAbsolute(options.workspaceFile)
      ? options.workspaceFile
      : resolve(cwd, options.workspaceFile);
  const workspaceSource = await readRequiredFile(
    workspacePath,
    workspacePnpmErrorCodes.workspaceFileNotFound,
  );
  let workspaceValue: unknown;
  try {
    workspaceValue = parse(workspaceSource);
  } catch (error) {
    throw new WorkspacePnpmError(
      workspacePnpmErrorCodes.invalidWorkspaceManifest,
      { path: workspacePath },
      error,
    );
  }
  const patterns = readWorkspacePatterns(workspaceValue, workspacePath);
  const directories = await glob(patterns, {
    absolute: true,
    cwd,
    expandDirectories: false,
    followSymbolicLinks: false,
    onlyDirectories: true,
  });
  const packages = await Promise.all(directories.toSorted().map((directory) => (
    readWorkspacePackage(cwd, directory)
  )));
  return createWorkspaceGraph(packages);
}

async function readWorkspacePackage(cwd: string, directory: string): Promise<WorkspacePackage> {
  const manifestPath = resolve(directory, 'package.json');
  const source = await readRequiredFile(
    manifestPath,
    workspacePnpmErrorCodes.packageManifestMissing,
  );
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new WorkspacePnpmError(
      workspacePnpmErrorCodes.invalidPackageManifest,
      { path: manifestPath },
      error,
    );
  }
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0) {
    throw new WorkspacePnpmError(workspacePnpmErrorCodes.invalidPackageManifest, {
      path: manifestPath,
    });
  }
  const dependencies: WorkspaceDependency[] = [];
  for (const kind of dependencyKinds) {
    const section = value[kind];
    if (section === undefined) {
      continue;
    }
    if (!isRecord(section)) {
      throw new WorkspacePnpmError(workspacePnpmErrorCodes.invalidPackageManifest, {
        path: manifestPath,
        section: kind,
      });
    }
    for (const [name, specifier] of Object.entries(section)) {
      if (typeof specifier !== 'string') {
        throw new WorkspacePnpmError(workspacePnpmErrorCodes.invalidPackageManifest, {
          dependencyName: name,
          path: manifestPath,
          section: kind,
        });
      }
      dependencies.push({ kind, name, specifier });
    }
  }
  return {
    dependencies,
    name: value.name,
    relativeDirectory: relative(cwd, directory).replaceAll('\\', '/'),
  };
}

function readWorkspacePatterns(value: unknown, path: string): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value.packages)) {
    throw new WorkspacePnpmError(workspacePnpmErrorCodes.invalidWorkspaceManifest, { path });
  }
  const patterns: string[] = [];
  for (const pattern of value.packages) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new WorkspacePnpmError(workspacePnpmErrorCodes.invalidWorkspaceManifest, { path });
    }
    patterns.push(pattern);
  }
  return patterns;
}

async function readRequiredFile(
  path: string,
  missingCode: typeof workspacePnpmErrorCodes.workspaceFileNotFound
    | typeof workspacePnpmErrorCodes.packageManifestMissing,
): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new WorkspacePnpmError(missingCode, { path }, error);
    }
    throw error;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
