# `@openge/forge-artifact-publish-cos`

显式的 Node.js 腾讯 COS Provider。复用官方 `cos-nodejs-sdk-v5` 公共签名接口，通过自有 HTTP(S) 请求和 Agent 管理取消与关闭；业务编排由 [`artifact-publish`](artifact-publish.md) 负责。

## 配置与入口

```ts
import { createCosArtifactTransport } from '@openge/forge-artifact-publish-cos';

const transport = createCosArtifactTransport({
  bucket, // 包含数字 APPID 后缀的完整 bucket 名。
  region,
  credentials: { secretId, secretKey, sessionToken }, // sessionToken 可省略。
});
```

本包公开配置使用自有结构，不暴露 SDK 类型。Node 要求至少 22.14，browser 条件拒绝导入。凭据必须显式提供且在操作期间有效；不读取环境、不自动刷新会话、不发现 bucket、不创建云资源、不设置 CDN。target 收据记录 `tencent-cos`、`region/bucket` 和实际 endpoint origin。

默认 endpoint 为 `https://<bucket>.cos.<region>.myqcloud.com`。覆盖 `endpoint` 时只接受无 userinfo/path/query/fragment 的 origin；生产使用 HTTPS，仅字面量 `127.0.0.1` 或 `[::1]` 的 HTTP 用于受控协议验证。不要指向不可信服务；请求包含认证信息及可选会话 token。重定向明确失败，不转发凭据。

## 不可变存储前提

COS 的 `x-cos-forbid-overwrite: true` 在启用版本控制的 bucket 中不起作用，详见 [PUT Object 官方说明](https://www.tencentcloud.com/document/product/436/7749)。因此 prepare 先 GET bucket versioning，严格验证至多 64 KiB 的 UTF-8 XML，只接受从未启用版本控制的空配置。Enabled、Suspended、未知属性/结构、非法 UTF-8、DTD/entity、截断或读取失败全部在对象写入前停止。

运行期间必须保持 bucket 配置稳定。消费者需使用访问策略限制其他身份改写/删除不可变前缀；一个带 forbid-overwrite 的客户端无法阻止管理员或其他客户端的普通覆盖操作，也无法消除预检之后由管理员改变 bucket 配置的竞态。

create 使用禁止覆盖头，只有 `409 FileAlreadyExists` 可转入回读复用。其他冲突失败。对象匹配要求实际 GET 字节、SHA-256、长度、Content-Type 和 Cache-Control 全部一致；不把 ETag 当成 SHA-256。上传包含 Content-Length 和 Content-MD5。

指针使用普通 PUT，严格由 Core 在全部不可变对象验证之后调用。消费者承担单一 CI 仓库串行协调；本包没有目的对象 If-Match CAS、读后写锁或跨仓库分布式锁。激活旧版本只验证已有对象并写指针。

## 预算、错误与关闭

Core 总预算传递为每个请求的剩余 deadline 和 AbortSignal；HTTP(S) Agent、request、response 和 socket 均由单个 transport 拥有。取消或关闭后禁止新请求，close 幂等，并在关闭预算内确认资源结束。`closed/0` 之外均不能报告成功；收据保留已接受写入和未知副作用。

响应通过真实接收计数限制大小；成功 GET 上限是声明对象长度，409 XML 独立限制为 64 KiB。认证和缺对象状态优先映射，避免错误正文较大时掩盖 403/404。重定向、截断、过大正文、恶意 XML 不作为成功。

主要稳定错误码为 `AUTHENTICATION_FAILED`、`OBJECT_MISSING`、`OBJECT_CONFLICT`、`IMMUTABILITY_UNSUPPORTED`、`INVALID_REMOTE_RESPONSE`、`RESPONSE_TOO_LARGE`、`TRANSPORT_FAILED`、`OPERATION_ABORTED` 与 `BUDGET_EXCEEDED`；不保留原始 SDK/HTTP 错误 cause。失败不自动重试，尤其指针 `unknown` 时先在外部串行范围内核实状态。SecretId、SecretKey、Token 不进入收据或日志。

本版是缓冲内存的单次 PUT，Provider 上限为 5,000,000,000 字节；实际应根据进程内存设远小于该值的 Core 限额，不提供 multipart。`maxTotalBytes` 只计逻辑对象集合，不能当作网络流量或内存上限。

## 验证与线上验收边界

仓内受控 HTTP 服务验证官方 SDK 签名、真实请求路径、forbid-overwrite、字节与元数据回读、409、认证错误、畸形响应、取消和连接关闭。真实 tarball 消费脚本从公开入口执行文件发布、指针、旧版本激活和中途取消，自建服务/文件并回收；不引用 ignored helper，不依赖历史 `.tmp` 输入。

这些验证证明已覆盖的协议与本地资源行为，不能代替目标 COS 的权限、地域、bucket 配置、网络、CDN 缓存或生产凭据验收。真实 bucket/域名由消费侧确认并授权后单独验收，不由本包创建或推测。第三方依赖分别为 `cos-nodejs-sdk-v5@3.0.0`（ISC）与严格解析所用 `cos-fast-xml-parser@1.0.0`（MIT）；作为精确运行时依赖随包管理器安装。
