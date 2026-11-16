import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { discoverWorkspacePackageModel } from '../workspace-packages.mjs';

// 保留类型边与字面动态边；非字面加载单列，不能把它们伪装为已解析依赖。
function references(text, name = 'source.ts', { verbatimModuleSyntax = true } = {}) {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const result = [], dynamic = [];
  const add = (node, target, kind) => {
    if (target && ts.isStringLiteralLike(target)) result.push({ specifier: target.text, kind,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    else dynamic.push(node.getText(source));
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!verbatimModuleSyntax && !clause?.name && named && ts.isNamedImports(named)
        && named.elements.length > 0 && named.elements.every(item => item.isTypeOnly));
      add(node, node.moduleSpecifier, onlyTypes ? 'type' : 'value');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause;
      const onlyTypes = node.isTypeOnly || (!verbatimModuleSyntax && named && ts.isNamedExports(named)
        && named.elements.length > 0 && named.elements.every(item => item.isTypeOnly));
      add(node, node.moduleSpecifier, onlyTypes ? 'type' : 'value');
    } else if (ts.isJSDocImportTag(node)) {
      add(node, node.moduleSpecifier, 'type');
    } else if (ts.isImportTypeNode(node)) {
      add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, 'type');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression, node.isTypeOnly ? 'type' : 'value');
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node, node.arguments[0], 'value');
    }
    ts.forEachChild(node, visit);
    for (const doc of node.jsDoc ?? []) visit(doc);
  };
  visit(source);
  return { references: result, dynamic };
}

function components(nodes, edges) {
  const next = new Map(nodes.map(node => [node, []]));
  for (const { from, to } of edges) next.get(from).push(to);
  const indexes = new Map(), lows = new Map(), stack = [], active = new Set(), cycles = [];
  const visit = node => {
    indexes.set(node, indexes.size); lows.set(node, indexes.get(node)); stack.push(node); active.add(node);
    for (const target of next.get(node)) {
      if (!indexes.has(target)) { visit(target); lows.set(node, Math.min(lows.get(node), lows.get(target))); }
      else if (active.has(target)) lows.set(node, Math.min(lows.get(node), indexes.get(target)));
    }
    if (lows.get(node) !== indexes.get(node)) return;
    const group = []; let item;
    do { item = stack.pop(); active.delete(item); group.push(item); } while (item !== node);
    if (group.length > 1 || next.get(node).includes(node)) cycles.push(group.sort());
  };
  for (const node of nodes) if (!indexes.has(node)) visit(node);
  return cycles;
}

test('AST 依赖扫描包含导入、重导出、类型、JSDoc 与动态字面引用', () => {
  const scanned = references(`
    import type { A } from './a.js';
    import { type B } from './b.js';
    import { type C, value } from './c.js';
    export type { D } from './d.js';
    export { type E } from './e.js';
    export * from './f.js';
    type G = import('./g.js').G;
    /** @type {import('./h.js').H} */
    const h = {};
    const i = import('./i.js');
    const j = require('./j.js');
    const k = import(variable);
  `);
  assert.deepEqual(scanned.references.map(({ specifier, kind }) => [specifier, kind]), [
    ['./a.js', 'type'], ['./b.js', 'value'], ['./c.js', 'value'], ['./d.js', 'type'], ['./e.js', 'value'],
    ['./f.js', 'value'], ['./g.js', 'type'], ['./h.js', 'type'], ['./i.js', 'value'], ['./j.js', 'value'],
  ]);
  assert.deepEqual(scanned.dynamic, ['import(variable)']);
});

test('JSDoc @import 的双文件类型环不能漏扫', () => {
  const sources = { a: '/** @import { B } from "b" */\nconst a = 1;', b: '/** @import { A } from "a" */\nconst b = 1;' };
  const edges = Object.entries(sources).flatMap(([from, text]) => references(text).references
    .map(({ specifier, kind }) => ({ from, to: specifier, kind })));
  assert.deepEqual(edges, [{ from: 'a', to: 'b', kind: 'type' }, { from: 'b', to: 'a', kind: 'type' }]);
  assert.deepEqual(components(Object.keys(sources), edges), [['a', 'b']]);
});

test('named type 的值边分类与实际 TypeScript 输出一致', () => {
  const text = 'import { type B } from "b"; export { type E } from "e";';
  const compilerOptions = { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true };
  const expected = [['b', 'value'], ['e', 'value']];
  const pairs = scanned => scanned.references.map(({ specifier, kind }) => [specifier, kind]);
  assert.deepEqual(pairs(references(ts.transpileModule(text, { compilerOptions }).outputText)), expected);
  assert.deepEqual(pairs(references(text, 'source.ts', compilerOptions)), expected);
  assert.deepEqual(pairs(references(text, 'source.ts', { verbatimModuleSyntax: false })), [['b', 'type'], ['e', 'type']]);
});

test('SCC 检测覆盖单文件自环、混合环及只含类型的环', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'];
  const edges = [['a', 'b', 'type'], ['b', 'a', 'value'], ['c', 'd', 'type'], ['d', 'c', 'type'], ['e', 'e', 'value']]
    .map(([from, to, kind]) => ({ from, to, kind }));
  assert.deepEqual(components(nodes, edges), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(components(nodes, edges.filter(edge => edge.kind === 'value')), [['e']]);
});

const sourceFiles = async directory => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
};

test('所有公共包源码的运行时图、含类型全图和跨包图均无环', async context => {
  const root = resolve(import.meta.dirname, '../..');
  const { packages } = await discoverWorkspacePackageModel({ repositoryRoot: root });
  const owners = new Map(), entries = new Map(), options = new Map();
  for (const pkg of packages) {
    const configPath = resolve(pkg.packageRoot, 'tsconfig.build.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, pkg.packageRoot);
    assert.deepEqual(parsed.errors, []);
    for (const file of await sourceFiles(parsed.options.rootDir)) {
      owners.set(file, pkg.name); options.set(file, parsed.options);
    }
    for (const entry of pkg.exports) {
      const output = resolve(pkg.packageRoot, entry.importTarget);
      entries.set(entry.specifier, resolve(parsed.options.rootDir, relative(parsed.options.outDir, output)).replace(/\.([cm]?)js$/u, '.$1ts'));
    }
  }
  const files = [...owners.keys()].sort(), edges = [], external = [], unresolved = [], dynamic = [];
  for (const from of files) {
    const scanned = references(await readFile(from, 'utf8'), from, options.get(from));
    dynamic.push(...scanned.dynamic.map(expression => ({ from: relative(root, from), expression })));
    for (const reference of scanned.references) {
      const { specifier } = reference;
      let to = entries.get(specifier);
      if (!to && specifier.startsWith('.')) {
        const path = resolve(dirname(from), specifier);
        to = owners.has(path) ? path : path.slice(0, -extname(path).length) + extname(path).replace(/js/u, 'ts');
      }
      if (!to) to = ts.resolveModuleName(specifier, from, options.get(from), ts.sys).resolvedModule?.resolvedFileName;
      if (to && owners.has(resolve(to))) edges.push({ from, to: resolve(to), ...reference });
      else if (specifier.startsWith('.') || packages.some(pkg => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)))
        unresolved.push({ from: relative(root, from), ...reference });
      else external.push(specifier);
    }
  }
  const describe = groups => groups.map(group => ({ files: group.map(file => relative(root, file)),
    edges: edges.filter(edge => group.includes(edge.from) && group.includes(edge.to))
      .map(edge => `${relative(root, edge.from)}:${edge.line} --${edge.kind}--> ${relative(root, edge.to)}`) }));
  const packageEdges = edges.filter(edge => owners.get(edge.from) !== owners.get(edge.to))
    .map(edge => ({ from: owners.get(edge.from), to: owners.get(edge.to) }));
  context.diagnostic(JSON.stringify({ packages: packages.length, files: files.length, edges: edges.length,
    types: edges.filter(edge => edge.kind === 'type').length, crossPackageEdges: packageEdges.length,
    external: [...new Set(external)].sort(), dynamic }));
  assert.deepEqual(unresolved, [], '内部依赖必须全部解析');
  assert.deepEqual(components(packages.map(pkg => pkg.name), packageEdges), [], '跨包依赖不得成环');
  assert.deepEqual(describe(components(files, edges.filter(edge => edge.kind === 'value'))), [], '运行时文件依赖不得成环');
  assert.deepEqual(describe(components(files, edges)), [], '含类型与混合边的文件依赖不得成环');
});
