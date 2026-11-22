# 支付凭证核验

[`@openge/forge-payment-verification`](../../packages/payment-verification/README.md) 定义核验请求、结果和精确的最小单位金额格式。[`@openge/forge-payment-verification-evm`](../../packages/payment-verification-evm/README.md) 接受由应用注入的可信 RPC，核验 EVM 顶层原生资产转账。应用设置付款预期、选择确认数，并处理订单状态、入账幂等和链重组后的对账。

调用 `verify(request, { signal })` 时，预期数据包括交易哈希、`eip155:<chainId>`、付款地址、收款地址、最小单位十进制整数字符串、32 字节支付引用和最少确认数。交易输入必须完整等于该引用。适配器用回执与规范区块中的交易位置检查成功状态和确认深度，只有 `verified` 返回凭证。`pending` 可在链上数据更新后重试，`unavailable` 可在 RPC 恢复后用同一实例重试，`rejected` 表示请求或付款条件不匹配。区块高度和确认数以十进制字符串返回。

核验依据 RPC 在当次读取时给出的链状态。适配器沿父区块哈希将确认高度绑定到付款所在分叉，返回已验证的最少确认数。应由应用使用可信网络配置、设置调用期限，并在入账时按自己的确认与重组策略处理凭证。

## 本次准入记录

维护者已批准由 XGameHub 沙箱购分作为首个接入场景，先发布支付核验 Core 与 EVM 适配器。Game Forge 的创作者购分与 Link Light 的模块激活仍按原计划接入，目前尚未计作已接入消费者。这项准入决定仅适用于这两个包的首次发布。后续接入时复核稳定契约是否覆盖至少两个独立消费者的共同需求。
