# Repository Policy

`@openge/forge-repository-policy` 用于把消费者已经声明的路径、事实和规则路由解析为稳定的 required / candidate 规则集合。它不解释业务语义，也不替代宿主原生指令、源码证据、用户授权或项目验收。

## 边界

根入口是纯 Core，只处理内存对象，不做文件 I/O、命令执行、网络访问或 AI 推断。

Node 入口 `@openge/forge-repository-policy/node` 提供三项只读能力：

- `checkPolicyRepository()`：检查严格 JSON manifest、规则来源和 package-script 引用是否存在。
- `resolvePolicyBundle()`：解析适用规则，并完整读取 required 与 candidate 的规则正文，返回原始字节 SHA-256 和 bundleDigest。
- `preparePolicyRepository()`：创建显式读取会话，固定 root、manifest 和读取限额，供调用方重复解析；成功读取的规则正文保存在会话内。

被 manifest 引用的 package script **只检查是否存在，不会执行**。

## 重复解析与刷新

`preparePolicyRepository({ root, manifestPath, preload })` 返回成功后，通过 `repository.resolve(request)` 解析请求。相对 root 在创建时解析为绝对路径，后续修改调用方的 options 或返回文档不会改变会话中的来源身份。

默认 `preload: 'none'` 在规则首次成功选中时读取正文；`preload: 'policy-sources'` 在准备阶段读取全部 policy source，并检查单文件及总来源字节预算。两种方式都保留严格路径、UTF-8 和双读内容校验。prepare 不检查 package-script 目标，完整结构检查仍调用 `checkPolicyRepository()`。

会话不监听文件，也不会自动刷新已经缓存的来源。规则或 manifest 修改后，需要创建新会话，或使用每次重新读取的 `resolvePolicyBundle()`。manifest 与各文件并非在同一时刻读取，因此不能把会话当作原子文件系统快照；digest 只绑定实际返回字节，不证明当前磁盘未变化。调用方持有并释放会话引用即可管理缓存生命周期。

该接口用于显式选择内容复用方式；具体性能取决于负载，不能从缓存存在推导延迟、内存或 token 收益。

## Manifest

首期持久配置为 `.forge/repository-policy.json`。JSON 必须是严格 UTF-8；允许文件开头单个 UTF-8 BOM，但不允许注释、尾逗号、重复 key 或容错解析结果。

规则正文保持原始 UTF-8 文本，包括 BOM、CRLF 和中文。单份 source 的 `sha256` 与 `utf8Bytes` 均按原始字节计算。

## 路径与来源安全

所有来源必须是显式 root 内的完整文件。Node 层同时检查词法路径、真实路径、大小写别名、regular file、单文件/总读取预算，以及两次读取间的内容变化。

内部 symlink/junction 可以解析；真实路径越出 root 会返回 `SOURCE_OUTSIDE_ROOT`。这些检查用于减少越界和 TOCTOU 风险，但不是操作系统级恶意并发沙盒。高对抗场景仍应使用受信快照或隔离工作副本。

## CLI

```sh
forge-repository-policy check --root . --manifest .forge/repository-policy.json
forge-repository-policy resolve --root . --manifest .forge/repository-policy.json --input - --delivery inline
forge-repository-policy resolve --root . --manifest .forge/repository-policy.json --input request.json --delivery references
```

`resolve` 可加 `--max-output-bytes <正整数>`。默认 128 KiB，最小 1 KiB。预算按最终 JSON 加换行后的 UTF-8 wire bytes 计算；超限不会截断规则正文，而是返回 `OUTPUT_BUDGET_EXCEEDED` 和 `deliveryComplete=false`。

退出码：

| exit | 含义 |
| --- | --- |
| 0 | check 完整通过；或 resolve 为 ready 且 inline 完整交付 |
| 2 | needs-context、references-only 或输出预算不足 |
| 1 | 非法输入、显式冲突、来源/检查失败 |

stdout 只包含 JSON；日志不得混入 stdout。

## 正确使用方式

消费者继续保留原有 AGENTS/rules/SKILL 和本地 checker。Policy manifest 只是执行化路由，不是第二份规则正文。调用方应提交实际路径和已复核事实；unknown 或 suggested 不得当成 false。

`deliveryComplete=true` 只表示本工具完整组装了返回内容，不表示宿主没有截断、模型已经阅读、模型理解正确或当前任务已经获得写入/提交授权。
