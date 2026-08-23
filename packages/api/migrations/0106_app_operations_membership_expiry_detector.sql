-- Operations-2：会员到期后权限泄漏反向检测的只读索引。
--
-- 检测器不会改写 grant、撤销记录、话题或消息；这里只为按观看者消息发生时间
-- 反查当时有效会员授权提供有界索引。migration 执行仍留到全部开发结束后的统一阶段。

CREATE INDEX idx_app_conversation_messages_viewer_created
  ON app_conversation_messages (created_at, conversation_id, id)
  WHERE sender_type = 'viewer';
