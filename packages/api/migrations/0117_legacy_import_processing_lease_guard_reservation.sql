-- Legacy Import-2 租约收缩约束的序号预约。
-- 原 0117 约束在 dev/production 均从未执行；实际约束已顺延到 0119，
-- 以保证 0118 扩展和兼容运行时先发布。本文件只保持 migration 序列连续，不修改 schema 或业务数据。

SELECT 1;
