---
"@openge/forge-release-vercel": minor
---

默认 prebuilt API GET 改为单次有界 native HTTPS，统一要求受保护的 VERCEL_TOKEN，不再使用 CLI 登录凭据。保留较小配置及原轮询剩余截止、30 秒与 64 KiB 上限、完整取消和真实 request/socket 关闭；宿主预算与门禁收束不再误占请求计时。Git 交付、自定义 transport 及单次云写入和未决效果协议保持独立；普通 publish 不新增无 ID 续发或检查缓存。
