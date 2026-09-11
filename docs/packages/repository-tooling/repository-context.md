# `@openge/forge-repository-context`

纯逻辑、确定性的仓库上下文规划与校验原语，可用于 Node.js 和浏览器。消费者先完成文件发现、解析、语义分类和候选排序，再把结构化候选交给本包。

## 什么时候使用

适合 AI Context、代码审查辅助、仓库分析等工具中已经拥有候选文件/符号/依赖数据，需要稳定执行 profile/recipe 校验、上下文截断、影响闭包和预算评估的场景。

如果还需要从 Git 找文件，请先使用 `forge-repository-files` 或消费者自己的发现层；本包不执行 I/O。

## 安装

```sh
pnpm add @openge/forge-repository-context
```

## 可用入口

- `@openge/forge-repository-context`：唯一入口，runtime-neutral。

## 核心能力

- `createRepositoryContextRegistry`：验证 profile、recipe、标识符、scope、limit 和引用关系。
- `stableUniqueRepositoryContextValues`：保持首次出现顺序的稳定去重。
- `buildRepositoryContextSelection`：required context 优先，并按 profile 的 impact/symbol scope 做去重后截断。
- `buildRepositoryContextImpactSlice`：从 root 集合计算可达闭包，允许环且保证终止。
- `calculateRepositoryContextReductionPercent` / `evaluateRepositoryContextBudget`：计算缩减率和结构化预算诊断。
- `serializeRepositoryContextJson` / `compareRepositoryContextOutputs`：稳定 JSON 输出和文本映射比较。

## 快速使用

```ts
import { buildRepositoryContextSelection } from '@openge/forge-repository-context';

const selection = buildRepositoryContextSelection({
  profile: {
    id: 'compact', impactScope: 'local', maxSourceFiles: 2,
    maxSymbols: 1, symbolScope: 'local',
  },
  requiredContextFiles: ['route.json'],
  localContextFiles: ['near.json', 'route.json'],
  sourceFiles: ['entry.ts', 'entry.ts', 'contract.ts'],
  symbols: ['Entry', 'Contract'],
});
```

Selection 会先稳定去重再截断；required context 始终优先。影响闭包结果按 ID 排序，遇到环不会无限递归。预算诊断只返回结构化 code/actual/limit，不决定产品文案。

## 输出比较

`compareRepositoryContextOutputs` 只比较调用方给出的字符串映射：统一 CRLF、CR、LF 后返回 `missing`、`stale`、`unexpected` 和 `ok`。它不读取或写入文件，也不把调用方 output key 强制解释为文件系统路径。

## 行为与限制

本包不拥有 recipe ID、subsystem、风险等级、symbol tier、读取规则、parser、tokenizer、candidate ranking、output schema、路径、query、telemetry、A/B 或 live benchmark。调用方必须先确定这些产品语义，不能为了调用 API 而虚构依赖节点。

它也不会自动回退 profile、过滤业务关键词或自动选择 Provider。校验失败使用 `RepositoryContextError` 的稳定 code/details；严格 JSON 失败保留底层 serializer 错误。

## 与其他 Foundation Forge 包的关系

稳定 JSON 委托 [`forge-deterministic-json`](../data-formats/deterministic-json.md)。通用生成物文本比较可向下委托 [`forge-generated-artifacts`](../artifacts/generated-artifacts.md) 的纯逻辑能力，但 Node 文件发布仍属于 Generated Artifacts。Git 文件发现由 [`forge-repository-files`](repository-files.md) 单独负责。
