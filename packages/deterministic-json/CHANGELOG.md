# @openge/forge-deterministic-json

## 0.1.0

### Minor Changes

- aae44f3: 新增 `cloneJsonValue`，在保留对象枚举顺序的同时执行严格 JSON 校验并生成独立快照。
  修复 `__proto__` 自有数据键在克隆和排序时丢失或改变对象原型的问题，并补齐真实包消费验证。

## 0.1.0-rc.0

Initial release candidate with strict deterministic JSON validation and serialization.
