# @openge/forge-repository-files

## 0.1.1

### Patch Changes

- b544386: Git 查询在取消或启动失败后等待真实 `close` 再返回错误，避免调用方收到拒绝后仍与进程竞争文件清理。stdin 模式同时接收管道错误并保留进程首错；原取消、退出码与输出断言保持。

## 0.1.0

### Patch Changes

- 9d292a3: List tracked and untracked files from initialized nested Git submodules without using an unsupported `git ls-files` option combination.

## 0.1.0-rc.0

Initial release candidate with deterministic read-only Git repository file discovery.
