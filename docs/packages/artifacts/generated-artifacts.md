# `@openge/forge-generated-artifacts`

用显式生成物计划描述预期文件，在纯逻辑层比较快照，并在 Node.js 中安全发布变更文件。

## 什么时候使用

适合代码生成器、索引生成、配置派生文件等“我明确知道应该有哪些文件及内容”的场景。它尤其适合需要稳定比较、保留未变化文件 mtime、拒绝危险路径并控制退休文件删除的工具链。

如果需要扫描整个目录、推断哪些文件过期或定义产品输出 schema，这些职责应留在消费者。

## 安装

```sh
pnpm add @openge/forge-generated-artifacts
```

## 可用入口

- `@openge/forge-generated-artifacts`：纯计划定义与快照比较，runtime-neutral。
- `@openge/forge-generated-artifacts/node`：文件系统检查与发布；browser condition 下不可用。

## 核心能力

- `defineGeneratedArtifactPlan`：声明 expected artifacts 与显式 retired paths。
- `compareGeneratedArtifactSnapshot`：返回 missing、stale、retiredPresent 等确定性结果。
- `inspectGeneratedArtifacts`：在显式绝对根目录下预检当前状态。
- `publishGeneratedArtifacts`：只写计划内文件，并删除计划内明确退休文件。

## 快速使用

```ts
import { defineGeneratedArtifactPlan } from '@openge/forge-generated-artifacts';
import { publishGeneratedArtifacts } from '@openge/forge-generated-artifacts/node';

const plan = defineGeneratedArtifactPlan({
  artifacts: [{ path: 'generated/index.txt', content: 'ready\n' }],
  retiredPaths: ['generated/old.txt'],
});

const result = await publishGeneratedArtifacts('/absolute/project/root', plan, {
  pathCaseSensitivity: 'case-sensitive',
});
```

## 行为与限制

路径必须是安全的便携相对路径；调用方必须显式选择大小写策略。发布前会检查 expected/retired 的 file-ancestor 冲突，并拒绝目标或祖先 symlink/junction。变化文件先在目标目录写临时文件，再以 rename 发布；内容相同的文件不重写。

单文件发布是原子的，但整个 plan 不是跨文件事务；前面已经成功的写入不会因后续失败整体回滚。退休删除只处理显式列出的路径，不递归清理目录，也不扫描计划外文件。

`normalize-newlines` 只适用于字符串比较；它统一 CRLF/CR/LF，但不改变其它空白、BOM 或末尾换行是否存在。

## 与其他 Foundation Forge 包的关系

路径规则来自 [`forge-path-safety`](path-safety.md)。[`forge-repository-context`](../repository-tooling/repository-context.md) 可向下复用纯比较能力，但文件系统发布仍由本包 `/node` 负责。
