# `@openge/forge-text-integrity`

检测文本损坏/乱码特征的 runtime-neutral Core，并提供显式 Node.js 路径扫描、Git changed-file 扫描和 CLI。

## 什么时候使用

适合 CI、代码生成后检查、仓库迁移或编辑器工具中发现 mojibake 等文本完整性问题。已有字符串时只用 Core；需要扫描仓库时使用 `/node` 或 CLI。

## 安装

```sh
pnpm add -D @openge/forge-text-integrity
```

## 可用入口

- `@openge/forge-text-integrity`：内存文本检查，无 Node.js I/O。
- `@openge/forge-text-integrity/node`：路径和 Git 变更集扫描。
- `forge-text-integrity`：命令行入口。

## 核心能力

- `inspectTextIntegrity`：检查一个字符串并返回结构化 issue。
- `scanTextIntegrityPaths`：扫描显式路径集合。
- `scanChangedTextIntegrityFiles`：检查当前 Git 变更集中的文本文件。
- `runTextIntegrityCli`：供 CLI 入口复用的执行逻辑。

## 快速使用

```ts
import { inspectTextIntegrity } from '@openge/forge-text-integrity';
import { scanChangedTextIntegrityFiles } from '@openge/forge-text-integrity/node';

const issues = inspectTextIntegrity(source, { filePath: 'src/example.ts' });
const changedIssues = await scanChangedTextIntegrityFiles();
```

CLI：

```sh
forge-text-integrity src docs
forge-text-integrity --changed
```

显式路径与 `--changed` 不能同时使用。默认行标记 `check-mojibake-ignore-line` 可抑制该行的有意匹配；Markdown inline code span 默认忽略。

## 行为与限制

具体仓库扫描根、产品特有 ignore 项和 CI 呈现方式由消费者配置；Core 不持有仓库目录和产品规则。

## 与其他 Foundation Forge 包的关系

Node 扫描组合 [`forge-repository-files`](repository-files.md) 获取 Git ignore 和 changed-file 信息；文本检测本身不依赖 Git。
