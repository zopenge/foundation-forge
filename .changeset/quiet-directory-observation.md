---
"@openge/forge-release-vercel": patch
---

预算扫描在读取子项前关闭有界目录枚举，避免 Windows 安装重命名被自身搜索句柄阻塞；Windows 受管 pnpm 安装使用 copy 导入，减少共享 store 硬链接与观察的 I/O 争用。保留既有依赖、生命周期、字节与空闲空间门槛、观察截止、重试及恢复证据要求。
