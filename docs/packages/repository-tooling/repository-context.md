# `@openge/forge-repository-context`

领域中立、确定性的仓库索引与证据调查能力。它从受控源码范围构建带摘要的 generation，并在返回候选、关系和源码窗口前核对 corpus 与源码绑定。

## 安装

```sh
pnpm add @openge/forge-repository-context
```

## 入口

- `@openge/forge-repository-context`：runtime-neutral 的 corpus 契约、校验、搜索、关系查询、响应裁剪和 investigation。
- `@openge/forge-repository-context/adapters/typescript`：Node 环境下的 TypeScript/JavaScript 提取器。
- `@openge/forge-repository-context/adapters/cpp`：Node 环境下的 C++ 有界词法提取器。
- `@openge/forge-repository-context/node`：仓库发现、generation 构建、current/stale 校验和证据读取。
- `forge-repository-context`：Node CLI，提供 `build`、`check`、`investigate`。

根入口不依赖 `node:*`。三个 Node 子入口在浏览器导出条件下均为 `null`。

## 调查已有 corpus

```ts
import { createRepositoryInvestigator } from '@openge/forge-repository-context';
import { createFileReader, readRanges } from '@openge/forge-repository-context/node';

const reader = createFileReader({ rootDir, corpusId: corpus.corpusId, generationId: corpus.generationId });
const investigator = createRepositoryInvestigator({
  corpus,
  readRanges: (ranges) => readRanges(reader, ranges),
  route: 'investigate-relations',
  preferredScopes: ['packages/runtime/src/'],
  promoteRelationEndpoints: true,
});

const result = await investigator.investigate({ query: 'where invalid input is rejected' });
```

结果只包含带 `SourceRef` 的候选、已解析关系、证据窗口、源码提示和结构化诊断。没有有用候选时返回 `insufficient`，不会猜测路径或事实。

## 构建与检查

```sh
forge-repository-context build \
  --root . \
  --index .tmp/repository-context \
  --corpus local \
  --scope packages \
  --language typescript \
  --tsconfig tsconfig.json

forge-repository-context check \
  --root . \
  --index .tmp/repository-context
```

构建只扫描明确 scope，拒绝绝对路径、`..`、符号链接逃逸、秘密文件和受保护目录。它在提取前后核对文件集合与摘要；任何漂移都会返回 `stale`，不会更新 `current.json`。generation 内容先原子发布，成功后才原子更新 current 指针。

索引是本地派生缓存，默认位于 `.tmp/repository-context/`，不应提交。

## 语言证据边界

TypeScript adapter 使用声明的 tsconfig 和 TypeScript compiler API，支持 TypeScript 与 JavaScript 模块。C++ adapter 只声明 `ready-for-lexical-evidence`，提供文件、命名实体和 include 的词法证据，不冒充 typechecker 或 configured-build 结论。非空输入不得静默产生空成功。

## 所有权边界

本包不拥有消费者的业务域、模块分类、任务 Gold、模型、Provider、提示词、风险等级或产品文案。消费者负责选择 scope 和语言，并决定如何使用结构化结果；本包不会自动选择 Provider、隐式回退或写入仓库跟踪的生成物。
