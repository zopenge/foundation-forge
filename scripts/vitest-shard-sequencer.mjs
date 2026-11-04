import { resolve } from 'node:path';
import { BaseSequencer } from 'vitest/node';

/** 调度提示只决定归属；测试集合和成功门禁仍由完整合并独立核对。 */
export function balanceCoverageShards(files, weights, count) {
  if (!Number.isSafeInteger(count) || count < 2 || count > 8 || files.length < count) throw new Error('CI_SHARD_ARGUMENT');
  const paths = files.map(value => resolve(value.moduleId)), known = new Set(paths);
  if (known.size !== paths.length) throw new Error('CI_SHARD_SPEC_DUPLICATE');
  const hints = new Map(Object.entries(weights).map(([path, weight]) => [resolve(path), weight]));
  for (const [path, weight] of hints) if (!known.has(path) || typeof weight !== 'number' || !Number.isFinite(weight)
    || weight <= 0 || weight > 86_400) throw new Error('CI_SHARD_WEIGHT_INVALID');
  const ordered = files.map((spec, index) => ({ spec, path: paths[index], weight: hints.get(paths[index]) ?? 1 }))
    .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts = Array.from({ length: count }, () => ({ weight: 0, files: [] }));
  for (const row of ordered) {
    let target = 0;
    for (let index = 1; index < count; index++) if (parts[index].weight < parts[target].weight) target = index;
    parts[target].weight += row.weight; parts[target].files.push(row.spec);
  }
  return parts.map(part => part.files);
}

export default class CoverageShardSequencer extends BaseSequencer {
  async sort(files) {
    const ordered = await super.sort(files);
    if (!this.ctx.config.provide.forgeCoverageFullOrder) return ordered;
    const hints = new Map(Object.entries(this.ctx.config.provide.forgeCoverageShardWeights ?? {})
      .map(([path, weight]) => [resolve(path), weight]));
    const paths = new Set(files.map(spec => resolve(spec.moduleId)));
    if (paths.size !== files.length || [...hints].some(([path, weight]) => !paths.has(path)
      || typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 86_400)) throw new Error('FULL_COVERAGE_WEIGHT_INVALID');
    // 无提示的文件保留原排序；只将包内声明的长场景提到前面，不改变测试集合。
    return ordered.map((spec, index) => ({ spec, index, weight: hints.get(resolve(spec.moduleId)) ?? 1 }))
      .sort((a, b) => b.weight - a.weight || a.index - b.index).map(value => value.spec);
  }
  async shard(files) {
    const { index, count } = this.ctx.config.shard;
    return balanceCoverageShards(files, this.ctx.config.provide.forgeCoverageShardWeights ?? {}, count)[index - 1];
  }
}
