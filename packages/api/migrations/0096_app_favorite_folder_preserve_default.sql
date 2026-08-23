-- 删除自定义收藏夹时，先把其中的真人保留到默认收藏。
-- 该触发器与 DELETE 同一事务执行，避免客户端看到“不会取消喜欢”但实际丢失收藏。
-- 删除整个账号时 users 已不存在，此时不执行保留逻辑，避免干扰级联清理。

CREATE TRIGGER app_favorite_folder_preserve_default_before_delete
BEFORE DELETE ON app_favorite_folders
WHEN OLD.folder_type = 'custom'
  AND EXISTS (
    SELECT 1
    FROM users
    WHERE id = OLD.account_id
  )
  AND EXISTS (
    SELECT 1
    FROM app_favorite_folders
    WHERE account_id = OLD.account_id
      AND id = 'ff_default'
      AND folder_type = 'default'
  )
BEGIN
  INSERT OR IGNORE INTO app_favorite_folder_items (
    account_id,
    folder_id,
    profile_id,
    created_at
  )
  SELECT
    item.account_id,
    'ff_default',
    item.profile_id,
    item.created_at
  FROM app_favorite_folder_items item
  WHERE item.account_id = OLD.account_id
    AND item.folder_id = OLD.id;
END;

UPDATE app_interaction_collection_policies
SET max_folder_name_length = 20
WHERE id = 'icp_app_1_0_interaction_2_dev_1';
