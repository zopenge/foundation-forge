# `@openge/forge-path-safety`

跨运行时的便携相对路径校验，以及显式的 Node.js 根目录包含关系检查。

## 什么时候使用

适合生成物、归档、配置导入等需要先验证“逻辑相对路径是否安全”，或在 Node.js 中确认目标路径位于指定根目录内的场景。

如果需要的是归档 entry 资源限制、SHA-256 校验或 ZIP 解码，应使用对应的更高层 package。

## 安装

```sh
pnpm add @openge/forge-path-safety
```

## 可用入口

- `@openge/forge-path-safety`：runtime-neutral 的便携相对路径规则。
- `@openge/forge-path-safety/node`：Node.js 根目录路径解析与包含关系检查。

## 核心能力

- `validatePortableRelativePath`：校验 canonical `/` 分隔相对路径。
- `normalizePortableRelativePath`：把可接受的分隔形式规范为便携相对路径。
- `resolvePathWithinRoot`：词法级根目录包含检查。
- `resolveExistingPathWithinRoot`：对已存在路径使用 `realpath` 做实际包含检查。

## 快速使用

```ts
import { normalizePortableRelativePath } from '@openge/forge-path-safety';
import { resolveExistingPathWithinRoot } from '@openge/forge-path-safety/node';

const logicalPath = normalizePortableRelativePath('assets\\atlas.json');
const existingPath = await resolveExistingPathWithinRoot(inputRoot, logicalPath);
```

## 行为与限制

根入口拒绝绝对路径、drive/UNC/device path、NUL、空 segment、`..` traversal 和不成对 UTF-16 surrogate。`resolvePathWithinRoot` 只保证词法包含，不能防止 symlink escape；需要真实文件系统包含时使用 `resolveExistingPathWithinRoot`。

本包不拥有目录白名单、权限、ACL、文件生命周期或产品级安全策略。

## 与其他 Foundation Forge 包的关系

[`forge-archive-safety`](archive-safety.md) 和 [`forge-generated-artifacts`](generated-artifacts.md) 复用本包的路径规则；更高层组合包不应复制自己的便携路径算法。
