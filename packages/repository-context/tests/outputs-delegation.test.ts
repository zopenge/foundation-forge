import { afterEach, expect, test, vi } from 'vitest';
import * as generatedArtifacts from '@openge/forge-generated-artifacts';
import { compareRepositoryContextOutputs } from '../src/index.js';

afterEach(() => { vi.restoreAllMocks(); });

test('通用比较委托给生成物契约，同时保留领域诊断', () => {
  const compare = vi.spyOn(generatedArtifacts, 'compareGeneratedArtifactSnapshot');
  expect(compareRepositoryContextOutputs({
    expected: { stable: 'a\nb\n', changed: 'old', absent: 'required' },
    current: { stable: 'a\rb\r\n', changed: 'new', extra: '' },
  })).toEqual({ ok: false, missing: ['absent'], stale: ['changed'], unexpected: ['extra'] });
  expect(compare).toHaveBeenCalledOnce();
});

test('输出键是领域标识符，不套用文件系统路径限制', () => {
  const expected = Object.freeze(Object.fromEntries([
    ['', 'same'], ['..', 'wanted'], ['C:\\fixtures\\output.json', 'x\n'],
    ['/fixtures/output.json', 'missing'], ['__proto__', 'owned'], ['A', 'upper'], ['a', 'lower'],
  ]));
  const current = Object.freeze(Object.fromEntries([
    ['', 'same'], ['..', 'changed'], ['C:\\fixtures\\output.json', 'x\r\n'],
    ['__proto__', 'owned'], ['A', 'upper'], ['a', 'lower'], ['extra', ''], ['empty', null],
  ]));
  expect(compareRepositoryContextOutputs({ expected, current })).toEqual({
    ok: false, missing: ['/fixtures/output.json'], stale: ['..'], unexpected: ['extra'],
  });
});

test('保留孤立代理码元、尾随空白和 BOM 的原始字符串区别', () => {
  expect(compareRepositoryContextOutputs({
    expected: { surrogate: '\ud800', bom: '\ufeffx', whitespace: 'x ', newline: 'x\n' },
    current: { surrogate: '\ud801', bom: 'x', whitespace: 'x', newline: 'x' },
  })).toEqual({ ok: false, missing: [], stale: ['bom', 'newline', 'surrogate', 'whitespace'], unexpected: [] });
});

test('不把继承字段当作当前输出，保持 null 与缺失的含义', () => {
  const current: Record<string, string | null> = { constructor: null, untouched: null };
  expect(compareRepositoryContextOutputs({ expected: { toString: 'required', constructor: 'required' }, current })).toEqual({
    ok: false, missing: ['constructor', 'toString'], stale: [], unexpected: [],
  });
});
