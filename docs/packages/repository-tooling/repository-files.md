# `@openge/forge-repository-files`

面向 Node.js 工具链的确定性、只读 Git 仓库文件发现能力。

## 什么时候使用

适合需要可靠获取仓库根、受 Git 管理的文件、当前变更文件或 ignore 过滤结果，并希望输出路径稳定、规范化的开发工具。

它不会修改 Git，也不会在 Git 不可用时偷偷退化成递归扫描文件系统。

## 安装

```sh
pnpm add -D @openge/forge-repository-files
```

## 可用入口

- `@openge/forge-repository-files`：唯一公开入口；实现使用 Node.js/Git。

## 核心能力

- `findRepositoryRoot`：定位 Git 仓库根。
- `listRepositoryFiles`：列出仓库文件。
- `listChangedRepositoryFiles`：列出变更和未跟踪文件，并处理 rename/copy target。
- `filterIgnoredRepositoryPaths`：按 Git ignore 规则过滤候选路径。
- `normalizeRepositoryPath`：统一为 repository-relative `/` 路径。

## 快速使用

```ts
import {
  listChangedRepositoryFiles,
  listRepositoryFiles,
} from '@openge/forge-repository-files';

const allFiles = await listRepositoryFiles({ cwd: process.cwd() });
const changedFiles = await listChangedRepositoryFiles({ cwd: process.cwd() });
```

返回路径会做仓库相对化、slash 规范化、去重和确定性排序；changed-file 默认不返回已经删除的路径。

## 行为与限制

本包不提供 commit、branch、push、index 修改或工作区写操作，也不理解 context、风险等级、代码语义或产品目录含义。

## 与其他 Foundation Forge 包的关系

[`forge-text-integrity`](text-integrity.md) 的 Node 扫描可复用本包；[`forge-repository-context`](repository-context.md) 刻意不依赖文件发现，而是只处理调用方已经提供的数据。
