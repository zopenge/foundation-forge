---
"@openge/forge-artifact-publish": minor
"@openge/forge-artifact-publish-cos": patch
---

新增领域中立的制品操作输入绑定、持久 CAS 占位、独立接受与观察回执及只观察恢复入口。提供显式命令适配器，复用有界命令执行和受管作用域，不把命令退出解释为远端部署就绪。

增加不可变目录激活与静态/OCI/运行多制品两类真实 tarball 消费证明。COS 协议保持现有行为，更新精确 Core 依赖并验证响应丢失后的激活恢复不会重放写入。
