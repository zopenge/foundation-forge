# `@openge/forge-deterministic-json`

严格的确定性 JSON 校验、排序和序列化工具，不依赖运行时第三方库。

## 什么时候使用

适合需要稳定文本输出、可重复构建、可比较配置或摘要输入的场景。它只接受语义明确的 JSON 数据，主动拒绝 JavaScript 中会造成不确定结果的值。

如果需要 RFC 标准的 canonical JSON，本包不是该标准的实现。

## 安装

```sh
pnpm add @openge/forge-deterministic-json
```

## 可用入口

- `@openge/forge-deterministic-json`：唯一入口，runtime-neutral。

## 核心能力

- `assertJsonValue`：验证严格 JSON 值。
- `sortJsonValue`：递归复制并按 UTF-16 code-unit 顺序排序对象键；数组顺序保持不变。
- `stringifyDeterministicJson`：按稳定顺序序列化，可控制缩进和末尾换行。
- `DeterministicJsonError` 与稳定错误码。

## 快速使用

```ts
import { stringifyDeterministicJson } from '@openge/forge-deterministic-json';

const output = stringifyDeterministicJson(
  { z: 1, a: 2 },
  { space: 2, trailingNewline: true },
);
```

## 行为与限制

循环引用、稀疏数组、访问器、自定义 prototype、`undefined`、`bigint` 和非有限数值都会被拒绝，而不是静默转换。它不负责 schema 校验、摘要计算、文件 I/O 或持久化。

## 与其他 Foundation Forge 包的关系

[`forge-repository-context`](../repository-tooling/repository-context.md)、[`forge-workspace-checks`](../workspace-tooling/workspace-checks.md) 和 [`forge-config-bundle`](../artifacts/config-bundle.md) 会在需要稳定 JSON 时复用本包，而不是各自实现序列化规则。
