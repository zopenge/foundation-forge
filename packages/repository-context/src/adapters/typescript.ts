import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { Diagnostic, Edge, Entity, SourceRef } from '../core/contracts.js';
import type { ExtractionResult } from './contracts.js';

export interface TypeScriptExtractionOptions {
  readonly rootDir: string;
  readonly tsconfigPath: string;
  readonly files: readonly string[];
  readonly corpusId: string;
  readonly generationId: string;
}

export interface TypeScriptExtractionResult extends ExtractionResult {
  readonly readiness: 'ready' | 'rejected';
  readonly configurationDigest: string;
}

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const portable = (value: string): string => value.replaceAll('\\', '/');

const sourceRef = (options: TypeScriptExtractionOptions, path: string, digest: string,
  sourceFile: ts.SourceFile, node: ts.Node): SourceRef => {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { corpusId: options.corpusId, generationId: options.generationId, path, sourceSha256: digest,
    normalizedSha256: null, snapshotId: null, lineStart: start, lineEnd: end };
};
const declarationName = (node: ts.Node): string | null => {
  if ('name' in node) {
    const name = (node as ts.NamedDeclaration).name;
    if (name && ts.isIdentifier(name)) return name.text;
    if (name && ts.isStringLiteral(name)) return name.text;
  }
  return null;
};

const ownerName = (node: ts.Node): string | null => {
  let current = node.parent;
  while (current) {
    const name = declarationName(current);
    if (name) return name;
    current = current.parent;
  }
  return null;
};

const isDeclaration = (node: ts.Node): boolean => ts.isFunctionDeclaration(node)
  || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
  || ts.isEnumDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
  || ts.isVariableDeclaration(node);

const signatureFor = (node: ts.Node, sourceFile: ts.SourceFile): string | null => {
  const text = node.getText(sourceFile).split(/\r?\n/u)[0]?.trim() ?? '';
  return text.length > 0 ? text.slice(0, 512) : null;
};

const parseConfiguration = async (path: string): Promise<{ options: ts.CompilerOptions; digest: string; diagnostics: readonly Diagnostic[] }> => {
  const text = await readFile(path, 'utf8');
  const raw = ts.readConfigFile(path, ts.sys.readFile);
  if (raw.error) return { options: {}, digest: sha256(text), diagnostics: [{ code: 'INVALID_ARGUMENT', details: { kind: 'tsconfig' } }] };
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, resolve(path, '..'));
  const options = { ...parsed.options, allowJs: true, checkJs: false, noEmit: true };
  const diagnostics = parsed.errors.length > 0
    ? [{ code: 'INVALID_ARGUMENT', details: { kind: 'tsconfig', errorCount: parsed.errors.length } }]
    : [];
  return { options, digest: sha256(`${text}\n${JSON.stringify(options)}`), diagnostics };
};
export const extractTypeScript = async (options: TypeScriptExtractionOptions): Promise<TypeScriptExtractionResult> => {
  const configuration = await parseConfiguration(options.tsconfigPath);
  if (configuration.diagnostics.length > 0) return { readiness: 'rejected', entities: [], edges: [], diagnostics: configuration.diagnostics,
    configurationDigest: configuration.digest };
  if (options.files.length === 0) return { readiness: 'rejected', entities: [], edges: [],
    diagnostics: [{ code: 'EMPTY_INPUT_SET', details: {} }], configurationDigest: configuration.digest };
  const absoluteFiles = options.files.map((path) => resolve(options.rootDir, path));
  const program = ts.createProgram({ rootNames: absoluteFiles, options: configuration.options });
  const allowed = new Map<string, string>();
  for (const path of options.files) allowed.set(portable(resolve(options.rootDir, path)).toLowerCase(), portable(path));
  const digests = new Map<string, string>();
  await Promise.all(options.files.map(async (path) => {
    const bytes = await readFile(resolve(options.rootDir, path));
    digests.set(portable(path), sha256(bytes));
  }));
  const entities: Entity[] = [];
  const edges: Edge[] = [];
  const fileIds = new Map<string, string>();

  for (const sourceFile of program.getSourceFiles()) {
    const path = allowed.get(portable(sourceFile.fileName).toLowerCase());
    if (!path) continue;
    const digest = digests.get(path);
    if (!digest) continue;
    const fileId = `file:${path}`;
    fileIds.set(portable(sourceFile.fileName).toLowerCase(), fileId);
    entities.push({ id: fileId, kind: 'file', name: path.split('/').at(-1) ?? path, owner: null,
      signature: null, source: { corpusId: options.corpusId, generationId: options.generationId, path,
        sourceSha256: digest, normalizedSha256: null, snapshotId: null, lineStart: 1,
        lineEnd: sourceFile.getLineAndCharacterOfPosition(sourceFile.end).line + 1 }, evidenceLevel: 'literal-path' });
  }
  for (const sourceFile of program.getSourceFiles()) {
    const path = allowed.get(portable(sourceFile.fileName).toLowerCase());
    if (!path) continue;
    const digest = digests.get(path);
    if (!digest) continue;
    const visit = (node: ts.Node): void => {
      if (isDeclaration(node)) {
        const name = declarationName(node);
        if (name) {
          entities.push({ id: `symbol:${path}:${name}:${node.getStart(sourceFile)}`, kind: 'symbol', name,
            owner: ownerName(node), signature: signatureFor(node, sourceFile),
            source: sourceRef(options, path, digest, sourceFile, node), evidenceLevel: 'syntax' });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    for (const statement of sourceFile.statements) {
      const isImport = ts.isImportDeclaration(statement);
      const isReexport = ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined;
      if (!isImport && !isReexport) continue;
      const specifierNode = isImport ? statement.moduleSpecifier : statement.moduleSpecifier;
      if (!specifierNode || !ts.isStringLiteral(specifierNode)) continue;
      const resolved = ts.resolveModuleName(specifierNode.text, sourceFile.fileName, configuration.options, ts.sys).resolvedModule;
      const targetId = resolved ? fileIds.get(portable(resolved.resolvedFileName).toLowerCase()) ?? null : null;
      edges.push({ from: `file:${path}`, to: targetId, kind: isImport ? 'imports' : 're-exports',
        resolution: targetId ? 'resolved' : 'unresolved', evidence: sourceRef(options, path, digest, sourceFile, statement),
        evidenceLevel: targetId ? 'typechecker' : 'syntax', configurationDigest: configuration.digest });
    }
  }

  if (entities.length === 0) return { readiness: 'rejected', entities: [], edges: [],
    diagnostics: [{ code: 'EMPTY_EXTRACTION', details: { fileCount: options.files.length } }],
    configurationDigest: configuration.digest };
  return { readiness: 'ready', entities, edges, diagnostics: [], configurationDigest: configuration.digest };
};
