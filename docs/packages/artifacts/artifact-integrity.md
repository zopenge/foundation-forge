# `@openge/forge-artifact-integrity`

跨运行时的字节完整性校验，以及显式的 Node.js 文件 SHA-256/长度验证。

## 什么时候使用

适合需要验证下载结果、缓存内容、生成物或配置条目的字节长度与 SHA-256，但不希望把下载、来源或业务身份规则耦合进校验层的场景。

## 安装

```sh
pnpm add @openge/forge-artifact-integrity
```

## 可用入口

- `@openge/forge-artifact-integrity`：基于 Web Crypto 的字节计算与验证。
- `@openge/forge-artifact-integrity/node`：Node.js 文件流、同步文件和同步字节 API。

## 核心能力

- `calculateBytesIntegrity` / `verifyBytesIntegrity`：异步字节完整性。
- `calculateFileIntegrity` / `verifyFileIntegrity`：可取消的异步普通文件校验。
- `calculateBytesIntegritySync` / `verifyBytesIntegritySync`：同步字节校验。
- `calculateFileIntegritySync` / `verifyFileIntegritySync`：同步分块文件校验。
- 统一解析和规范化 SHA-256 digest，并使用结构化 `ArtifactIntegrityError`。

## 快速使用

```ts
import { verifyBytesIntegrity } from '@openge/forge-artifact-integrity';
import { verifyFileIntegrity } from '@openge/forge-artifact-integrity/node';

await verifyBytesIntegrity(bytes, { byteLength: 3, sha256: expectedDigest });
await verifyFileIntegrity('artifact.bin', {
  byteLength: expectedLength,
  sha256: expectedDigest,
});
```

## 行为与限制

Node 文件 API 拒绝 symlink 和非普通文件。下载、凭据、缓存、制品来源、签名信任以及“这个 digest 属于谁”的业务身份规则都不属于本包。

## 与其他 Foundation Forge 包的关系

[`forge-config-bundle`](config-bundle.md) 使用它验证 manifest 中的大小和 SHA-256；路径安全由 [`forge-path-safety`](path-safety.md) 单独负责。
