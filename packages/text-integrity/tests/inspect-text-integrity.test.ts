import { TextDecoder } from 'node:util';

import { describe, expect, test } from 'vitest';

import { inspectTextIntegrity } from '../src/index.js';

describe('inspectTextIntegrity', () => {
  test('accepts readable multilingual text and TypeScript nullish syntax', () => {
    expect(inspectTextIntegrity([
      "it('使用配置中的当前模型填充下拉框', () => {})",
      "const greeting = 'こんにちは';",
      'const value = input ?? fallback;',
    ].join('\n'))).toEqual([]);
  });

  test('reports every supported issue code in stable rule order with CRLF lines', () => {
    const replacement = String.fromCodePoint(0xfffd);
    const privateUse = String.fromCodePoint(0xe160);
    const gbkCluster = String.fromCodePoint(0x6d63, 0x8de8, 0x95b0);
    const latin1Cluster = Buffer.from('生成一张图', 'utf8').toString('latin1');
    const issues = inspectTextIntegrity([
      'safe',
      `broken ??? ${replacement} ${privateUse} ${gbkCluster} ${latin1Cluster}`,
    ].join('\r\n'), { filePath: 'fixture.ts' });

    expect(issues.map(({ code, file, line }) => ({ code, file, line }))).toEqual([
      { code: 'question-placeholder', file: 'fixture.ts', line: 2 },
      { code: 'replacement-character', file: 'fixture.ts', line: 2 },
      { code: 'private-use-character', file: 'fixture.ts', line: 2 },
      { code: 'mojibake-token-cluster', file: 'fixture.ts', line: 2 },
      { code: 'latin1-mojibake-cluster', file: 'fixture.ts', line: 2 },
    ]);
  });

  test('detects a common UTF-8 to GBK corruption cluster', () => {
    const corrupted = new TextDecoder('gbk').decode(Buffer.from(
      '禁止新增或保留模块循环引用，必须定位根因并彻底修复。',
      'utf8',
    ));

    expect(inspectTextIntegrity(`// ${corrupted}`, { filePath: 'fixture.ts' }))
      .toContainEqual(expect.objectContaining({ code: 'mojibake-token-cluster' }));
  });

  test('honors the ignore marker and Markdown code-span options', () => {
    expect(inspectTextIntegrity([
      '// ??? check-mojibake-ignore-line',
      'Use `???` as a wildcard.',
    ].join('\n'))).toEqual([]);
    expect(inspectTextIntegrity('// ??? allow-corruption', {
      ignoreLineMarker: 'allow-corruption',
    })).toEqual([]);
    expect(inspectTextIntegrity('Use `???` as a wildcard.', {
      ignoreMarkdownCodeSpans: false,
    })).toEqual([expect.objectContaining({ code: 'question-placeholder' })]);
  });

  test('truncates previews without changing the original file identity', () => {
    const issues = inspectTextIntegrity(`  ${'?'.repeat(200)}  `, { filePath: 'long.md' });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe('long.md');
    expect(issues[0]?.preview).toHaveLength(160);
  });
});
