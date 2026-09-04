# @openge/forge-path-safety

## 0.1.1-rc.0

- 拒绝含孤立 UTF-16 代理码元的 portable path，避免文件系统编码导致路径别名；合法代理对保持不变。

## 0.1.0

### Minor Changes

- 61fa170: Add portable relative-path validation and explicit Node.js root containment.

## 0.1.0-rc.1

Publish the first release candidate through npm Trusted Publishing after the
one-time package bootstrap.

## 0.1.0-rc.0

Initial release candidate with portable relative-path validation and explicit
Node.js root containment.
