# `@openge/forge-archive-zip`

运行时中立、只处理内存字节的确定性 ZIP32 Provider，并在解压前执行有界安全检查。

## 什么时候使用

适合需要可重复生成 ZIP、检查 ZIP 内容或在内存中安全解码 ZIP32，同时不希望依赖系统 `zip/unzip` 命令的场景。

不适合 ZIP64、加密 ZIP 或需要直接写入文件系统的解压流程。

## 安装

```sh
pnpm add @openge/forge-archive-zip
```

## 可用入口

- `@openge/forge-archive-zip`：唯一入口，runtime-neutral。

## 核心能力

- `encodeZipArchive`：创建确定性 ZIP32，可选择 `store` 或 `deflate`。
- `inspectZipArchive`：解析中央目录并在解压前检查 entry 与资源限制。
- `decodeZipArchive`：验证后解压为内存字节。
- `zipArchiveDefaultLimits` 与 `ZipArchiveError`。

## 快速使用

```ts
import { decodeZipArchive, encodeZipArchive } from '@openge/forge-archive-zip';

const archive = encodeZipArchive([
  { bytes: new TextEncoder().encode('hello'), kind: 'file', path: 'hello.txt' },
], { compression: 'deflate' });

const decoded = decodeZipArchive(archive, {
  limits: { maxArchiveBytes: 8 * 1024 * 1024, maxExpandedBytes: 32 * 1024 * 1024 },
});
```

## 行为与限制

会拒绝 ZIP64、加密、未知压缩方法、不安全路径或 entry kind、重复路径、本地 header 与中央目录不一致、CRC mismatch 和资源限制违规。UTF-8 文件名按字节内容保留，不在解码时自行规范化。

下载、缓存、凭据、文件系统写入和产品制品语义不属于本包。

## 与其他 Foundation Forge 包的关系

解压前的 entry 安全规则复用 [`forge-archive-safety`](archive-safety.md)；更高层 [`forge-config-bundle`](config-bundle.md) 使用本包承载 manifest-backed 配置归档。
