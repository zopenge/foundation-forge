# 子进程性能采样

此诊断 hook 不进入发布 tarball，不参与日常测试的运行前提。它保持原始 callback、promisify、spawn 和 spawnSync 结果，只记录程序 basename、Git 操作白名单、起止耗时及退出码，不记录参数、环境、输出或凭据。

从仓库根目录使用 Node 的 `--import` 或 `NODE_OPTIONS` 加载 `profile-process-commands.mjs`，然后执行需要定位的定向测试。`FORGE_CHECK_PROFILE_DIRECTORY` 可指定仓库 `.tmp/` 下的独立子目录，默认写入 `.tmp/check-performance-profile/commands-<pid>.jsonl`。结束后恢复环境变量。

每个进程使用独立日志文件。不同进程的时间原点不同；父子进程及身份查询可能重叠，累计命令时长不能直接当作墙钟关键路径。`spawn` 同时记录 exit 与 close 耗时，用于区分命令运行与输出管道关闭；Git 操作计数用于核实重复元数据查询。性能结论必须结合测试或完整检查的真实墙钟时间。

`tests/profile-process-commands.test.mjs` 使用自行创建并清理的真实 Node 子进程验证 hook 的透明性；测试及 hook 不依赖已有 `.tmp/` 内容。
