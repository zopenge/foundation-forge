# `@openge/forge-repository-context`

领域中立、确定性、无模型的仓库证据层。它从明确 scope 构建 generation，提供候选、关系、源码窗口和受验证读取，并在 mutable source 与可信 frozen source 两种模式下保持来源绑定。

## 什么时候使用

适合：调用方不知道确切文件，需要有界候选；需要来源 SHA、行范围、关系证据；需要固定预算和可继续分页的机器接口。

不适合：文件路径已经明确时应直接读取；IDE/LSP 重构、完整调用图、跨语言语义翻译、Embedding、模型摘要或 Agent 查询规划不属于本包职责。无命中返回 `insufficient`，不会自动换模型或联网。

## 安装与入口

```sh
pnpm add @openge/forge-repository-context
```

- 根入口：runtime-neutral 的 corpus、搜索、关系、预算与 investigation。
- `/node`：构建、current/frozen 校验、受验证读取与 generation store。
- `/adapters/typescript`、`/adapters/cpp`：语言提取器；浏览器条件下 Node 子入口不可用。
- CLI：`build`、`check`、`investigate`、`read`。

根入口不引用 `node:*`；Node 专用能力不得从根入口泄漏。
## CLI 调查与预算

```sh
forge-repository-context investigate --root . --index .tmp/repository-context \
  --query "semantic input package exports" --scope packages/repository-context/src/ \
  --view evidence --max-bytes 4096

forge-repository-context read --root . --index .tmp/repository-context \
  --path packages/repository-context/src/node/reader.ts --line-start 1 --line-end 80 \
  --max-bytes 16384
```

`investigate` 默认 `evidence`、4 KiB；`read` 默认 16 KiB。`locate` 只返回候选元数据且不读正文；`evidence` 从同一批候选构造命中摘录、可信包围符号和有界短文件升级选项，再用完整 JSON 的实际 UTF-8 字节数选择。查询明确命名多个目录时，候选上限内优先覆盖各目录的实现；已明确命名的符号仍受保护。先保留候选锚点，再按候选顺序升级；支持证据不会挤掉已选锚点。`complete` 仅表示选定正文未被预算裁剪；`wholeFile` 必须是当前来源文件全文。`relations` 只在显式选择时返回现有真实关系，不默认扩图。

查询在有效 scope 内明确提到唯一文件名时，调查只定位该文件；同名文件存在歧义时保留常规候选搜索。完整相对路径与唯一裸文件名使用相同的目标文件证据范围；已经解码的 Windows 单反斜杠路径按相对路径识别。查询文本中的相对路径只有以索引内已知根目录开头、明确使用 `./` 前缀，或以文件扩展名结尾时才提升为硬范围；普通斜杠短语继续作为检索文本。已知完整路径仍可直接使用 `read`。

显式 `--scope` 是硬搜索边界，不会在该 scope 无命中时自动扩大到全 corpus。如果所有显式请求的 scope 在当前 corpus 中都不存在，返回 `status: "insufficient"`、`reason: "REQUESTED_SCOPE_MISSING"`，同时在 `primaryScopeCoverage.missing` 和 diagnostic 中保留缺失 scope；调用方应把它视为这些 scope 的终止性负证据，而不是为了重新确认其存在性继续做全局 fallback。普通 `NO_USEFUL_CANDIDATE` 仍只表示当前查询在有效 scope 内证据不足。

`nextCursor` 表示后续条目；`hasMoreEvidence=true` 是同义提示。同一请求的续页固定证据规划或兼容展示序列，游标绑定策略、generation、查询、scope 和预算；策略变化后旧游标须重新从第一页获取。`complete=false` 与 `expand` 表示当前条目正文被裁短，`internallyTruncated=true` 在预算容许时给出汇总提示，二者可独立于分页存在。`requestedRange` 在新规划响应中表示所选来源范围；`deliveredRange` 是完整交付的行范围，按字节裁短且不能证明整行交付时为 `null`。极紧预算的旧式兼容响应可能省略附加字段，此时 `lineStart/lineEnd` 仍是请求范围，不能将 `complete=false` 的文本当作完整行交付。`expansion` 指向同一来源文件中更大的可读范围；`complete=false` 时按 `expand` 范围使用 `read`。`read` 支持单范围，也支持 `--ranges-json` 的有界批读。预算是输出上限，不要求填满。

## 构建与 current 校验

```sh
forge-repository-context build --root . --index .tmp/repository-context \
  --corpus local --scope packages --language typescript --tsconfig tsconfig.json

forge-repository-context check --root . --index .tmp/repository-context
```
构建只扫描明确 scope，拒绝绝对路径、`..`、符号链接逃逸、秘密文件和常规派生输出。generation 同时绑定源码摘要与 TypeScript 配置闭包，包括 tsconfig/extends、project references、相关 package manifest、workspace/lockfile 以及已解析或缺失模块目标。

`current-verified` 每次重新发现并比较这些输入。源码或语义输入漂移返回 `stale`；构建期间发生漂移也不会推进 `current.json`。索引是可重建的本地缓存，不应提交。

## 可信 frozen

frozen 快路径只接受已经由 `@openge/forge-source-snapshot` 发布并授权的不可变 snapshot store；必须同时提供固定的 root、owner 和 snapshot id：

```sh
forge-repository-context check --root . --index .tmp/repository-context \
  --snapshot-root .tmp/source-snapshots --snapshot-owner local-owner \
  --snapshot-id snapshot-<sha256>
```

`investigate` 与 `read` 使用同样三项参数。Repository Context 会逐项核对 generation 所依赖的源码和语义输入与 snapshot manifest/正文 hash；普通 mutable 目录、仅声明 frozen 的标志、错误 owner/snapshot、无法证明的缺失语义输入都会失败为 `FROZEN_SOURCE_UNVERIFIED`，不会降级成可信 frozen。

显式绑定 snapshot id 后，即使 snapshot store 的 current entry 切换到新版本，旧 snapshot 仍按不可变内容读取。查询路径只读，不创建 generation、后台 watcher 或服务。

## 检索与中文边界

exact/path/symbol 先于词法；统一 tokenizer 处理 NFKC、camel/Pascal/HTTP、snake/kebab、短标识符和中文字符/双字片段。正文候选使用可解释 BM25；多词证据查询可纳入正文排名首位但符号名未命中的文件，同时保护查询中明确命名的符号候选。显式请求范围在读取前就限制正文索引和提示。`locate` 不读取正文；关系只在显式 `relations` 视图使用。

中文和英文之间没有共享词时允许返回 `insufficient`。本包不做翻译、语义向量、神经重排或模型查询，因此不能把词法命中能力描述成跨语言语义检索。
## SDK 调查

```ts
import { createRepositoryInvestigator } from '@openge/forge-repository-context';
import { createFileReader, readRanges } from '@openge/forge-repository-context/node';

const reader = createFileReader({ rootDir, corpusId: corpus.corpusId, generationId: corpus.generationId });
const investigator = createRepositoryInvestigator({
  corpus,
  readRanges: (ranges) => readRanges(reader, ranges),
  route: 'investigate',
  preferredScopes: ['packages/runtime/src/'],
});

const result = await investigator.investigate({ query: 'where invalid input is rejected' });
```

SDK 可在请求中传 `evidenceBudget: { maxBytes }` 获取 `evidenceUnits` 升级候选，再用公开的 `selectEvidence` 与调用方提供的完整输出计量器选择；未传时保留原有 evidence 行为。CLI 已装配实际 JSON 计量器。同一次 `investigate()` 可复用已经验证过的完整文件读取来满足其子范围 evidence；缓存不跨查询持久化。freshness verification 是独立成本，不能被这种复用跳过。

## 语言与所有权边界

TypeScript adapter 使用声明 tsconfig 和 compiler API；C++ adapter 仅提供有界词法证据，不冒充 typechecker/configured-build。

本包不拥有消费者业务域、Gold、模型、Provider、提示词、风险等级或产品文案，也不自动选择 Provider、隐式回退、写入仓库跟踪生成物或联网回源。完整任务 Token 节省必须由独立真实模型实验验证，离线字节或召回结果不能替代。
