# `@openge/forge-archive-safety`

运行时中立的归档 entry 路径、类型和资源上限校验，不解析具体归档格式。

## 什么时候使用

适合在 TAR、ZIP 或其它归档 Provider 已经获得 entry 元数据后，统一检查路径穿越、link 类型、条目数量和展开体积风险。

如果需要直接解析 ZIP32 字节，应使用 `forge-archive-zip`。

## 安装

```sh
pnpm add @openge/forge-archive-safety
```

## 可用入口

- `@openge/forge-archive-safety`：唯一入口，runtime-neutral。

## 核心能力

- `validateArchiveEntryPath`：校验归档 entry 路径，同时保留 directory 末尾 `/` contract。
- `inspectArchiveEntries`：检查 entry 类型、单项和总展开大小、条目数量等限制。
- `archiveSafetyDefaultLimits`：默认资源限制。
- `ArchiveSafetyError` 与稳定错误码。

## 快速使用

```ts
import { inspectArchiveEntries } from '@openge/forge-archive-safety';

const summary = inspectArchiveEntries([
  { path: 'payload/', kind: 'directory' },
  { path: 'payload/data.bin', kind: 'file', uncompressedBytes: 1024 },
]);
```

## 行为与限制

绝对路径、traversal、反斜杠、link、不支持的 entry kind、无效大小以及超出配置的条目数或展开总量会被拒绝。它不下载归档、不解析 ZIP/TAR、不调用系统解压工具，也不写文件。

## 与其他 Foundation Forge 包的关系

便携路径规则来自 [`forge-path-safety`](path-safety.md)；[`forge-archive-zip`](archive-zip.md) 在真正解压 ZIP 前组合本包做安全检查。
