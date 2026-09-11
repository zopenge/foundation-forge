# `@openge/forge-config-bundle`

带确定性 Manifest V1 的配置 ZIP 格式，以及显式 Node.js 导入预检、备份和尽力回滚流程。

## 什么时候使用

适合应用需要导出一组明确配置文件，在另一环境中验证完整性并安全导入，同时要求格式可重复、冲突策略可审计的场景。

产品负责决定哪些文件属于配置、哪些内容是 Secret，以及迁移和用户交互规则；本包只负责归档格式和通用导入流程。

## 安装

```sh
pnpm add @openge/forge-config-bundle
```

## 可用入口

- `@openge/forge-config-bundle`：创建、解析和验证内存中的配置 bundle。
- `@openge/forge-config-bundle/node`：导入计划检查和实际应用。

## 核心能力

- `createConfigBundle`：按调用方提供的 UTC `createdAt` 创建确定性 ZIP。
- `decodeConfigBundle`：验证 ZIP、Manifest V1、entry 集合、大小和 SHA-256。
- `parseConfigBundleManifest`：单独解析 manifest contract。
- `inspectConfigBundleImport`：在写入前生成 create/unchanged/overwrite 计划和冲突信息。
- `applyConfigBundleImport`：staging、可选备份、逐文件发布和失败后的尽力回滚。

## 快速使用

```ts
import { createConfigBundle, decodeConfigBundle } from '@openge/forge-config-bundle';
import { inspectConfigBundleImport } from '@openge/forge-config-bundle/node';

const archive = await createConfigBundle([
  { path: 'settings/preferences.json', content: new TextEncoder().encode('{"enabled":true}\n') },
], { createdAt: '2026-09-04T00:00:00.000Z' });

const bundle = await decodeConfigBundle(archive);
const plan = await inspectConfigBundleImport('/absolute/config-root', bundle, {
  conflictPolicy: 'reject',
  pathCaseSensitivity: 'case-sensitive',
});
```

## 格式与资源限制

Manifest 固定在 `__forge_config_bundle__/manifest.json`，V1 记录 `schemaVersion`、调用方提供的 UTC `createdAt`，以及按路径排序的 `path`、`byteLength`、SHA-256。相同 entry bytes、path、`createdAt` 和 package 版本会生成相同 ZIP bytes。

默认业务 entry 上限为 256 个文件、单文件 4 MiB、展开总量 16 MiB、归档 20 MiB；manifest 另有 1 MiB 上限。调用方可用正的 safe integer 覆盖限制。

## 行为与限制

Node 导入要求显式绝对 root 和 `case-sensitive` / `case-insensitive` 策略。冲突策略包括：

- `reject`：发现不同的既有文件后拒绝应用。
- `overwrite`：预检通过后替换普通文件。
- `backup-and-overwrite`：要求调用方提供独立 backup root，先保存旧字节再发布。

目录、symlink/junction 和其它非普通目标都会拒绝。每个变化文件在目标目录 staging 后以 rename 发布；多文件导入不是强事务。commit 失败后会尽力恢复已覆盖文件并删除本次新建文件，任何未成功回滚项都会进入 `rollbackFailures`。

旧归档如果没有 Manifest V1 会返回 `CONFIG_BUNDLE_UNSUPPORTED_LEGACY_FORMAT`，不会猜测或自动转换。包也不管理权限、ownership、ACL、并发写者或 crash-recovery journal。

## 与其他 Foundation Forge 包的关系

本包组合 [`forge-archive-zip`](archive-zip.md)、[`forge-archive-safety`](archive-safety.md)、[`forge-artifact-integrity`](artifact-integrity.md)、[`forge-deterministic-json`](../data-formats/deterministic-json.md) 和 [`forge-path-safety`](path-safety.md)。这些底层规则以各自 package 为权威，本页只说明配置 bundle 如何组合它们。
