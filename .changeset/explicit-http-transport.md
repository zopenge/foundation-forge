---
"@openge/forge-http-transport": minor
"@openge/forge-release-vercel": minor
---

新增显式 Node HTTP(S) 传输、只读选路描述与脱敏错误分类，支持独立连接池、环境快照和 HTTP/HTTPS CONNECT 代理。生产 build-info 读取复用该传输，默认显式直连并在每次读取后回收连接；可通过运行选项传入代理配置。
