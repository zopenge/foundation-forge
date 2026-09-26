# A/B 评测运行手册

`pnpm ab:eval` 是可复用的本地评测入口。它负责冻结任务包、准备隔离的 A/C 工作目录、检查 OpenCode 和 MCP 连接、按对调度、保存原始会话证据及审计结果。评测协议写在任务包中，运行时不修改脚本，也不从某台机器的绝对路径推断任务或候选包。

## 任务包

任务包目录包含真实候选 tarball、A/C OpenCode 配置模板、每项任务的初始 fixture、公开与隐藏验证器，以及按需使用的 `setup.mjs` 和 MCP 程序。`draft.json` 使用相对 POSIX 路径：

```json
{
  "schemaVersion": 1,
  "id": "example-regression",
  "candidate": "candidate.tgz",
  "client": {
    "kind": "opencode",
    "version": "1.18.30",
    "model": "provider/model",
    "variant": "high",
    "agent": "build"
  },
  "configs": { "A": "config/a.json", "C": "config/c.json" },
  "tasks": [{
    "id": "example-task",
    "fixture": "fixtures/example-task",
    "setup": "setup.mjs",
    "prompt": "Complete the frozen task and run its public check.",
    "publicVerifier": "verifiers/example-public.mjs",
    "hiddenVerifier": "verifiers/example-hidden.mjs"
  }],
  "pairs": [{ "id": "pair-01", "taskId": "example-task", "order": "AC" }],
  "concurrency": 1,
  "armTimeoutMs": 600000,
  "allowedTools": { "A": ["read"], "C": ["repository_context_investigate"] },
  "toolContract": {
    "A": { "native": ["read"], "mcp": {} },
    "C": { "native": [], "mcp": { "repository_context": {
      "investigate": "0000000000000000000000000000000000000000000000000000000000000000"
    } } }
  }
}
```

示例中的全零 schema 指纹仅是占位值，不能通过真实 `doctor`。合同中的每个 MCP 工具须填入经审定的 `inputSchema` SHA-256：按 JSON 对象键递归排序后序列化，取大写十六进制摘要。`allowedTools` 必须等于原生工具与命名空间映射后的 MCP 工具并集；映射沿用当前锁定 OpenCode 版本的名称规则，将服务器名与工具名中的非 ASCII 字母、数字、下划线和连字符替换为下划线，再用单个下划线连接。相同映射名、遗漏或多出的授权均会被拒绝。合同由评测包作者独立审定；运行时 `tools/list` 不能自动扩大授权。

配置模板须为每个臂提供按顺序声明的 `permission`：首项 `"*":"deny"`，随后对 `allowedTools` 中每个工具精确配置 `"allow"`。其他权限可继续设置为 `"deny"`。配置模板可使用 `{{WORK_DIR}}`、`{{ARM_DIR}}`、`{{PACK_DIR}}`、`{{CANDIDATE}}` 和 `{{NODE}}`。OpenCode 本地 MCP 的 `command` 是参数数组，例如 `{"type":"local","command":["{{NODE}}","{{PACK_DIR}}/mcp.mjs"],"enabled":true}`。任务包须纳入 MCP 程序及其所有运行依赖；不得引用仓库外的临时代码。可选 `setup.mjs` 依次接收工作目录、臂目录、候选 tarball 路径、臂名和任务 ID，在模型启动前从**真实 tarball** 准备 CLI、索引或测试依赖；A/C 各执行一次。配置和 fixture 在准备后会记录哈希，付费运行前再次核对。验证器依次接收工作目录和任务 ID。

```text
pnpm ab:eval freeze --draft .tmp/pack/draft.json --out .tmp/pack/pack.json
pnpm ab:eval verify-pack --manifest .tmp/pack/pack.json
```

冻结清单记录包内文件的 SHA-256。移动任务包后仍可验证；更改任务、依赖、配置或候选包需重新冻结并取得新批次授权。任务 fixture 不允许未登记的新文件或符号链接。不要把凭据放进任务包。

## 本机配置与模型禁用预检

每台机器在仓库忽略的 `.tmp/ab-eval-local.json` 写入自己的 OpenCode 可执行文件和认证文件路径；文件只存路径，不存凭据正文：

```json
{
  "clientExecutable": "C:/path/to/opencode.exe",
  "authPath": "C:/path/to/opencode/auth.json"
}
```

```text
pnpm ab:eval client-doctor --local .tmp/ab-eval-local.json
pnpm ab:eval prepare --manifest .tmp/pack/pack.json --run-dir .tmp/eval-run-001 --local .tmp/ab-eval-local.json
pnpm ab:eval doctor --run-dir .tmp/eval-run-001
```

`client-doctor` 在隔离目录里验证版本和自带 MCP 握手；`doctor` 对每个 C 臂检查真实任务 MCP 的连接，并对每个 A/C 臂读取完整的 MCP `tools/list`（包括分页），核对工具名称、命名空间、schema 指纹、冻结允许集合与配置权限。旧包若缺少 `toolContract`，新运行预检不会通过。两者均不发起模型调用。`prepare` 写入 `preflight.json` 和 `approval-template.json`，记录客户端版本、二进制及认证文件哈希、任务包哈希、候选包哈希和每臂配置。改变本机环境后重新准备新的运行目录，保留旧目录及证据。

## 运行与审计

仅在该**具体付费批次**取得授权后，将 `approval-template.json` 内容复制为同目录的 `approval.json`，设置 `approved: true`、完整的 `approvedArmIds` 和实际授权记录 `userAuthorization`。运行入口核对运行 ID、任务包哈希、全部臂及所有臂的工具合同预检，并用 `run.lock.json` 防止重复启动。同一运行目录不重放。

```text
pnpm ab:eval run --run-dir .tmp/eval-run-001
pnpm ab:eval audit --run-dir .tmp/eval-run-001
pnpm ab:eval assess --run-dir .tmp/eval-run-001
pnpm ab:eval diagnose --run-dir .tmp/eval-run-001
```

运行期间或结束后可用 `pnpm ab:eval status --run-dir .tmp/eval-run-001` 只读查看已启动/结算臂、在途臂、运行失败臂、完成配对、逐对 token、模型调用和已知质量/账目/工具边界问题。命令成功读取时退出码为 0，即使批次状态为 `blocked`；状态字段仍保留原失败。无需为进度或逐对收据再写临时提取脚本。

每对按任务包中的 `AC`/`CA` 顺序依次执行，最多并行 `concurrency` 对。每臂最长 `armTimeoutMs`，超时终止该臂拥有的进程树。任一质量、计费、工具边界或副作用不明即停止新发；任一完整对满足 `C.rawTotal >= A.rawTotal` 也停止新发，已启动的对继续结算。`journal/` 的 started/settled 文件、每臂 OpenCode `run.jsonl` 与 `export.json`、`result.json` 和 `postflight.json` 是审计依据。审计独立重算原始输入与输出 token，要求逐对 `C.rawTotal < A.rawTotal`，不将未完成或未知状态计为通过。诊断命令从收据和 OpenCode 导出提取逐对差值、质量失败、模型调用数、首轮输入 token、工具输出字节、违规工具名、MCP 错误码及真实重复查询，写入同目录的 `diagnostics.json` 和 `diagnostics.md`；未启动的对标为“未运行”。诊断还列出逐回合原始输入与输出 token、工具所属回合、工具错误载荷字节、证据完整文件与片段、响应截断状态，以及首次替换前运行公开测试的次数。若收据调用数与导出消息数无法对齐，会记录 `TURN_ALIGNMENT_MISMATCH`，不伪造逐回合工具归属。工具输出字节和错误字节只是载荷大小，不等同于模型输入 token 或最终计费。

需要收齐完整回归集时，可在单批授权中明确使用 `run --run-dir PATH --gate-mode collect`。此模式将逐对 token 反超、已完整结算的公开/隐藏质量失败，以及收据中可明确列出违规工具名的工具边界失败记录到 `result.json` 的 `gateFailures`，继续启动其余配对；违规臂和配对不会被 `audit` 判为通过。账目、收据、质量结论、工具列表、副作用或运行结果未知时仍阻断新发，避免把不完整收据当成可比较样本。`run.lock.json` 记录所选模式；默认 `stop` 行为不变。

若本批授权还要求在单臂 OpenCode 运行失败后继续收集其他独立配对，可显式加入 `--gate-mode collect --continue-on-run-failure on`。只有 `OPENCODE_RUN_FAILED` 使用此选项：脚本写入 `journal/<臂>.failed.json`，跳过该对尚未启动的臂，继续其他配对；失败臂保留 started 且没有 settled 收据，绝不重放。`status.failedArmIds` 与 `result.json` 的 `armErrors` 可定位它们；`evidence/run-outcome.json` 只记录退出状态、超时、截断、错误代码及输出字节数，不保存错误正文。整批最终仍为 `blocked`，`audit` 和 `assess` 不会把未结算臂计为通过。源码、认证、客户端启动、日记写入、账目或合同异常仍停止新发；默认 `collect` 行为不变。此参数须在该付费批次授权中明确，不能用于补跑既有批次。

完整重复评测可在 `audit` 生成不可覆盖的 `postflight.json` 后运行只读 `assess`。重复验收要求清单中每项任务**恰好三对**、所有臂均已结算、每对质量与证据审计通过且无审计问题；每项任务至少两对满足 `C.rawTotal < A.rawTotal`，并要求整批 `C.rawTotal` 总和严格小于 A 总和。相等不算获益。缺少重复、未完成、账目无效或审计行与冻结清单不符时返回 `REPLICATED_GATE_INELIGIBLE`；质量或 token 条件未过则返回 `REPLICATED_GATE_NOT_PASSED`。命令列出每项任务的获益对数、逐任务及整批 token 总量，引用原 `postflight.json` 的 SHA-256，不修改原审计或收据。`audit` 仍按原逐对严格规则报告，故它可能退出 2 而 `assess` 返回 `REPLICATED_GATE_PASS`。四对各不相同任务的试点不能据此放行完整回归；两对三次获益只是容忍一次轨迹波动，不等于统计显著性或跨代码库泛化证明。

逐回合诊断保留 `input`、`cacheRead`、`cacheWrite`、`output`、`reasoning` 分项；`rawInput` 是前三项之和，`rawOutput` 是后两项之和。缓存分项由客户端收据提供，不能单独证明服务端实际请求体或原始计费。

诊断的“导出历史字节”是本回合之前、OpenCode 导出消息 `parts` 的 JSON UTF-8 字节数；它不包括系统提示、工具定义和提供方请求包装，不能当成请求大小或 token 数。重新诊断历史轮次时使用 `diagnose --run-dir PATH --report-dir .tmp/新目录`；新目录必须位于仓库 `.tmp/` 内且尚不存在。诊断文件以独占创建方式写入，避免覆盖已有收据和报告。

`diagnostics.json` 的每个工具事件还记录导航请求的 `input.maxBytes`。未提供或无效的预算记为 `null`，便于对照模型请求预算与实际输出字节；这两者都不能直接换算成模型 token。

## 可选传输观测

当导出历史字节不能解释服务端输入 token 差异时，可在**新批次**的 `run` 命令加入 `--observe-transport on`。运行前会核对每臂配置的提供方地址：只接受 HTTPS 或本机回环 HTTP，缺失或无效地址在创建运行锁和模型调用之前阻断。每臂启动回环转发器，并通过运行时配置层覆盖模型端点；模型调用前再用客户端的 `debug config --pure` 核对实际有效地址，防止项目配置覆盖观测地址。观测不改变冻结任务包、原始配置或 A/C 工具权限。

```text
pnpm ab:eval transport-doctor --executable C:/path/to/opencode.exe --out .tmp/transport-probe-001
pnpm ab:eval run --run-dir .tmp/eval-run-002 --observe-transport on
```

`transport-doctor` 使用本机假提供方和假凭据，运行真实客户端、导出收据并审计观测证据；不调用付费模型。输出目录必须是仓库 `.tmp/` 内尚不存在的目录。真实批次仍须按上文单批授权流程准备，并在批准该批次时明确开启观测。

观测器只保存每个请求的字节数、SHA-256、响应状态、响应字节数、响应中的数值用量字段，以及 JSON 请求的结构计数；不保存请求或响应正文、认证头。结构计数包括顶层字段数、消息和工具数量、各自的序列化字节数及最多 128 项的逐项字节数，超限时标记截断。结构字节数由解析后重新序列化得到，用来比较组成，不能当作原始请求的精确分段。`evidence/transport.json`、`transport-config.json` 与 `transport-config-probe.json` 留在对应臂目录；收据绑定观测文件和配置哈希，审计要求观测请求数覆盖导出的模型调用数。`diagnose` 在请求数与导出回合数一一对应时列出逐请求结构与提供方用量；文件漂移或回合数不符时标记问题，不强行对齐。字节数可定位传输体变化，不能直接换算为 token；请求摘要只能确认字节相同与否。观测文件缺失、配置漂移或请求未覆盖模型调用会使该臂无法通过审计。

请求记录还包含开始时间 `startedAt`、总耗时 `durationMs`、收到上游响应头的耗时 `responseHeaderMs`、终态 `terminalEvent`、取消来源 `cancelSource` 与白名单错误类别 `errorClass`。上游 HTTP 错误、连接失败、响应流中断、下游取消及观察器取消分别记录；臂超时 `ARM_TIMEOUT` 和观察器的 `OBSERVER_CLOSING`、`OBSERVER_CLOSED` 独立保留。上游流中断会使已开始的下游响应失败；观察器关闭会取消并等待在途请求处理结束，迟到响应不会覆盖已记录的取消。

完整 SSE 错误事件使用固定的 `UPSTREAM_SSE_ERROR` 分类，并在 `sseErrorCode` 中保留；不保存提供方错误正文、类型或代码。即使随后发生流中断或取消，已有 SSE 错误证据仍可单独诊断。正常响应字节保持原样转发。

诊断同时检查 HTTP 状态和传输终态，HTTP 502 不依赖 `UPSTREAM_TRANSPORT_FAILED` 才能被发现。请求数超出收据回合数时，分别报告含额外 usage 的 `TRANSPORT_USAGE_REQUEST_OVERAGE` 与不含额外 usage 的 `TRANSPORT_REQUEST_OVERAGE_NO_USAGE`。只有每个回合的输入、输出数值都能唯一且按序匹配请求时，才提供 `TRANSPORT_NUMERIC_TURN_CANDIDATES` 数值候选及同请求体摘要对；候选不代表已证实的回合身份或计费结论，未匹配请求不会被强行并入收据。

## H8 冻结任务迁移

旧 H8 的包导出器位于 `packages/repository-context/evaluation/export-h8-pack.mjs`。它核对 run063 候选 tarball 与 CLI 哈希、八项 fixture 的冻结树哈希、公开/隐藏验证器哈希和任务清单；自动收集 MCP 模块的相对导入闭包及候选 CLI 的运行依赖，生成不含本机绝对路径的完整任务包。导出器只在原工作区需要，之后可把包目录复制到另一台机器。`slice` 从冻结包按 pair ID 选择新轮次，不编辑脚本或旧包。新导出的 A/C 工具合同均不开放 `todowrite`；也只开放自动运行公开测试的 `formal_task_replace_text`，不开放额外的 `formal_task_run_public_test`。`scripts/ab-eval/formal-task-filtered-stdio.mjs` 通过固定的 MCP 投影层同时收窄实际 `tools/list` 和可调用工具，模型禁用预检必须核对这一实际集合。每次成功编辑后的公开测试、每臂最终公开与隐藏验证、全部质量断言仍执行。A 的源码导航工具与 C 的 `investigate`、`read`、`continue` 分别保留。此变化仅影响新包，既有冻结包和收据保持原样；工具合同变化后的结果不能直接与旧包按同一实验条件合并。

```text
node packages/repository-context/evaluation/export-h8-pack.mjs --out .tmp/h8-pack --client-version 1.18.30
pnpm ab:eval slice --manifest .tmp/h8-pack/pack.json --pairs v85-full-01 --id h8-pilot-01 --out .tmp/h8-pilot-01
pnpm ab:eval prepare --manifest .tmp/h8-pilot-01/pack.json --run-dir .tmp/h8-pilot-run-01 --local .tmp/ab-eval-local.json
pnpm ab:eval doctor --run-dir .tmp/h8-pilot-run-01
```

修改 repository-context 源码后，先完成 `pnpm check`，再从包目录执行 `pnpm pack --out ../../.tmp/h8-next/candidate.tgz` 生成新真实 tarball（先创建目标目录）。固定换包入口用旧冻结任务包及新 tarball 生成新的自含包；它从 tarball 提取 CLI 运行时，只复用依赖版本相同的已冻结运行依赖，依赖契约变化会拒绝换包。然后按常规 `prepare`、`doctor`、单批授权、`run`、`audit`、`diagnose` 运行，无需编辑 `.tmp/` 中的代码。

```text
node packages/repository-context/evaluation/rebase-h8-candidate.mjs --source-pack .tmp/h8-pilot-01/pack.json --candidate .tmp/h8-next/candidate.tgz --out .tmp/h8-pilot-next --id h8-pilot-next
pnpm ab:eval prepare --manifest .tmp/h8-pilot-next/pack.json --run-dir .tmp/h8-pilot-run-next --local .tmp/ab-eval-local.json
pnpm ab:eval doctor --run-dir .tmp/h8-pilot-run-next
```

迁移时已对完整 24 对、48 臂包完成模型禁用准备，24 个 C 臂 MCP 全部连通；单对切片迁移目录后也通过准备与连接检查。经单批授权，四对切片的真实试点启动了前三对共六臂，六臂质量均通过；两对 C 的原始 token 高于 A，因此调度器停止新发，第四对未运行。该试点的冻结包、收据和诊断报告保留在忽略的 `.tmp/repository-context-optimization-v3/h8-portable-pilot4-preflight-v1/`。历史 run063 的收据没有修改。新入口与旧 v85 的会话续接策略不同，因此不能把旧批次 token 与新协议的数字直接比较；新批次必须在同一冻结任务包和运行协议内比较 A/C。付费运行仍按每批单独授权。新任务及独立代码库的泛化验收仍需独立任务包。
