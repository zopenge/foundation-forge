# 仓库与能力边界

本文面向公共基础库维护者和依赖架构负责人，是能力归属与准入判断的权威文档。公开包的安装和使用从根 [README](../../README.md) 进入。

## 分层职责

| 层级 | 所有权 | 依赖方向 |
| --- | --- | --- |
| 公共基础层 | 领域中立、可独立版本化、跨产品复用的 TypeScript contract 与 Provider | 只依赖领域中立的第三方基础库或本仓库中更底层的公开包 |
| 高性能运行时层 | 渲染、Native/WASM、高性能计算和运行时适配 | 可依赖公共基础层，不得要求公共基础层理解运行时实现语义 |
| 平台与服务层 | AI、数据、网络服务和平台级编排 | 可依赖公共基础层及明确需要的运行时能力 |
| 产品与业务层 | 房间、匹配、业务流程、UI 和客户语义 | 可组合下层公开能力，领域规则只能保留在本层 |

依赖必须从拥有领域语境的上层指向中立基础层。公共基础层不得引用具体消费者、反向依赖消费者代码，或复制消费者的配置、术语和业务语义。

## 准入规则

能力进入公共基础层前必须同时满足：

1. 至少两个独立消费者已经共享同一问题与稳定 contract。
2. contract 不包含 AI、游戏、房间、业务流程、具体 UI 或客户语义。
3. 能力可以单独安装、测试和版本化，不要求消费者引入无关基础设施。
4. 第三方实现可以封装在独立 Provider 包中，且中立 Core 不暴露其类型。
5. 代码及依赖许可证允许以 Apache-2.0 仓库公开分发。

仅因“未来可能复用”不构成准入依据。尚未稳定或只有一个消费者的实现继续由原仓库持有。

## 常见能力归属

- 数据库：连接、迁移和 ORM 装配保留在拥有数据模型的应用；只有稳定的中立 contract 且存在多个消费者时才评估提取。
- 文件 I/O：产品目录、权限和文件语义保留在应用；纯数据转换可在满足准入规则后提取。
- 渲染与 Native/WASM：属于高性能运行时层，不进入公共基础层。
- 网络：中立连接、消息、发现 contract 可进入公共基础层；具体 Provider 独立封装。
- 房间通信、Lobby 和匹配：属于产品与业务层；可组合中立网络能力，但不得下沉房间语义。
- AI service、agent 与模型适配：属于平台与服务层，不进入公共基础层。

## Peer Network 首期边界

`@openge/forge-peer-network` 只提供中立 contract、生命周期、分帧、操作控制与拨号调度，零运行时第三方依赖。

`@openge/forge-peer-network-libp2p` 明确区分 Node.js、浏览器和 relay 入口，完整封装 libp2p 类型与依赖。

`@openge/forge-peer-network-websocket` 将浏览器 client、跨运行时 hub 与 Node server 分开；client 使用调用方注入的标准 WebSocket factory，hub 只依赖 Foundation Core 与 Web Platform API，只有 server 依赖 `ws` 和 Node 内置模块。server 为兼容既有公开契约继续重导出 hub。

## Text Integrity 边界

`@openge/forge-text-integrity` 的根入口只提供领域中立的纯文本完整性检测，不依赖 Node.js 内置模块或文件系统。`/node` 入口负责文本路径扫描，并组合 `@openge/forge-repository-files` 完成 Git ignore 与 changed-file 收集；CLI 只将结构化问题格式化为命令行诊断。

公共 contract 不持有具体消费者的仓库目录、默认扫描根和产品特有忽略项。消费者可通过明确选项提供这些配置；检测规则、文本文件类型并集和稳定排序则由公共包维护为唯一实现。

## Repository Files 边界

`@openge/forge-repository-files` 只执行只读 Git 文件发现、changed-file 收集、ignore 过滤、路径规范化和稳定排序。它不提供 commit、branch、push 等写操作，不持有任何消费者的索引或上下文语义，并且 Git 不可用时显式失败而不递归扫描文件系统。

## Deterministic JSON 边界

`@openge/forge-deterministic-json` 只接受严格 JSON 数据，递归复制并按 UTF-16 code-unit 顺序排列对象键。它拒绝循环引用、稀疏数组、访问器、自定义原型和非 JSON 值，不负责摘要、持久化、schema 校验或 RFC canonical JSON。

## Artifact Integrity 边界

`@openge/forge-artifact-integrity` 的根入口只使用 Web Crypto 计算和验证字节长度与 SHA-256；`/node` 入口增加可取消的异步普通文件流式校验，以及同步字节和分块文件校验。下载、凭据、缓存、制品来源和业务身份规则仍由消费者持有。

## Path Safety 边界

`@openge/forge-path-safety` 的根入口只验证和规范化使用 `/` 的领域中立相对路径，不依赖 Node.js 内置模块。`/node` 入口区分词法包含与基于 `realpath` 的既有路径包含；前者不声称防止符号链接逃逸。产品目录白名单、权限策略和文件生命周期仍由消费者持有。

## Archive Safety 边界

`@openge/forge-archive-safety` 组合 Path Safety 的便携路径规则，并保留归档目录条目的尾部 `/` contract 与独立错误类型。它只验证归档条目路径、条目类型、展开大小和条目数量。归档格式解析、下载、临时目录、系统命令与实际解压属于 Provider 或消费者，不进入该公共包。

`@openge/forge-archive-zip` 是显式 ZIP32 Provider。它在解压前解析中央目录并执行 Archive Safety 检查，拒绝 ZIP64、加密、不支持的压缩方法、符号链接、重复路径和不一致的本地文件头。它只处理内存中的字节，不拥有下载、文件系统写入、缓存或产品制品语义。

## 流式文本协议边界

`@openge/forge-json-lines` 只负责 UTF-8 JSON Lines 的增量分帧、编码、解析和字节上限。它不拥有进程标准流、HTTP 响应、日志语义、重试策略或消息 schema。

`@openge/forge-server-sent-events` 只实现 SSE 字段、事件边界、注释忽略、UTF-8 解码和事件大小上限。HTTP 连接、鉴权、重连、心跳、业务事件类型和 UI 展示仍由消费者持有。

## Workspace Graph 边界

`@openge/forge-workspace-graph` 是无文件系统依赖的 Core，只表达包、依赖种类、未解析 workspace 依赖诊断、环检测、可达性和拓扑排序。它不执行构建、发布、版本计算或任务调度。

`@openge/forge-workspace-checks` 是纯 Core：它只接收中立的 workspace graph 并产生稳定排序的结构化诊断，不读取文件系统、不选择包管理器、也不执行命令。包循环规则是一个可组合检查，不为任何具体业务或发布流程定义语义。

`@openge/forge-workspace-checks-pnpm` 是 pnpm CLI 组装与集成 facade：它组合唯一的 pnpm Provider 与 Core 检查，并把结构化诊断转换为进程退出码与标准流输出。它不是 Provider；`@openge/forge-workspace-pnpm` 仍是唯一的 pnpm Provider。所有包依赖必须构成有向无环图，禁止反向依赖与直接或传递循环。

`@openge/forge-workspace-pnpm` 是显式 Node.js Provider，只读取调用方指定的 `pnpm-workspace.yaml` 与包清单，并转换为 Core contract。它不自动尝试其他包管理器，也不修改 manifest、lockfile 或 workspace 配置。

## Process Control 边界

`@openge/forge-process-control` 只定义进程身份、TCP 监听项、显式终止策略、稳定筛选和结构化错误，不访问操作系统。

`@openge/forge-process-control-node` 提供显式 Windows 与 Posix Provider；调用方必须选择平台和监听发现后端，不存在运行时自动选择或失败回退。终止前必须重新校验 PID 与启动标识，避免 PID 复用导致误杀。服务管理、端口归属策略、进程启动、日志和产品恢复流程仍由消费者持有。

## Repository Context 边界

`@openge/forge-repository-context` 只接受调用方提供的 profile、recipe、候选文件、符号、依赖节点和预算数值，执行结构校验、稳定去重、选择、闭包与结构化诊断。它组合 Deterministic JSON 完成序列化，内部委托 Generated Artifacts 比较调用方已读取的输出，保留原有文本换行语义和领域返回结构。

候选排序、业务分类、风险等级、分片映射、文件发现、解析、token 计算、输出 schema 和路径属于消费者。公共包不读取文件、不运行命令，不拥有查询、遥测或基准测试流程。详见 [Repository Context](repository-context.md)。

## Generated Artifacts 边界

`@openge/forge-generated-artifacts` 的根入口只接受显式生成物计划，验证便携相对路径并比较预期内容与快照。它依赖 Path Safety，不依赖 Repository Context。Repository Context 可以向下委托通用比较，但不引入文件系统操作。

`/node` 入口在显式绝对根目录中检查与发布计划内文件。调用者必须选择路径大小写策略；目标及现有祖先的符号链接和 junction 无条件拒绝，提交与退休删除前重新检查。内容相同时保持 mtime；只有全部预期文件写入成功后才删除显式退休文件。计划外文件不属于本包，目录发现、产品输出 schema、状态文件、目录清扫和 CLI 由上层持有。单文件 rename 不构成跨文件事务或跨进程锁。

## Command Runner 边界

`@openge/forge-command-runner` 的根入口提供纯命令契约和校验，只依赖 Process Control 中立契约。`/node` 入口负责单命令异步启动、原始字节事件、有界捕获、超时、心跳、取消与资源释放；它不依赖 Process Control Node Provider。

调用者显式提供平台、Process Control Provider、终止策略、身份获取预算与终止总预算。PID 启动事件与身份观察事件分开；终止进程树只能使用已捕获身份。存活子进程身份不可用或 Provider 无法在预算内完成时，返回结构化失败并受控清理直接子进程，不退化为裸 PID 进程树操作。观察者同步执行，其异常转为有界诊断。全局信号、shell 组装、服务顺序、就绪探测、重启、日志展示与持久化留在上层。

## Config Bundle 边界

`@openge/forge-config-bundle` 组合 Archive ZIP、Archive Safety、Artifact Integrity、Deterministic JSON 和 Path Safety，定义稳定的 Manifest V1 配置归档格式；它是格式与流程组合，不引入 Bundle Provider 层。三个生命周期包互不依赖，依赖图始终从组合层指向低层原语。

根入口只处理内存字节，使用调用者提供的 UTC 时间生成确定性归档，校验保留路径、条目集合、大小和 SHA-256。缺少 V1 manifest 的旧归档明确拒绝，不推测其来源。`/node` 入口基于显式路径大小写与冲突策略完成所有目标预检查、staging、同目录 rename、备份和尽力回滚；备份目录由调用者提供且不得与目标文件冲突。目标与祖先 symlink/junction 均拒绝。失败结果区分预检查、staging、备份、提交及逐路径回滚不完整，不声称提供强事务或抵抗任意并发目录置换。产品文件选择、Secret 规则、配置键、业务时间戳和 CLI 文案仍由上层持有。
