-- =============================================================================
-- 009 —— ref 层变更审计
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/009_ref_audit.sql
--
-- 为什么只审计 ref：
--   mirror 每晚全量重建，且源库行上带日期，所有流量型指标（开票延迟、DSO、
--   滞期成本、账龄）都能任意时点回溯——实测以今天为基准日回溯出 462 张未清，
--   与 mart.open_item 的 462 张完全吻合。所以 mirror 不需要快照。
--   ops / notify 本身是追加写，动作历史天然保留。
--
--   ref 是唯一例外：business_model、credit_limit、is_related_party、
--   passthrough_expected 这些是**人判断出来的结论**，每次修改直接覆盖上一版。
--   谁在什么时候把某客户额度从 8 万调到 15 万、之前是多少、为什么调——
--   不记就永久丢失，且无法从任何地方重建。这是整个库里唯一会真丢数据的地方。
--
-- 设计取舍：
--   用一张通用 jsonb 审计表而不是五张对应的 history 表。代码量小一个数量级，
--   加字段不用改审计结构，而审计的用途（谁改了什么）本来就不需要强类型。
-- =============================================================================


-- =============================================================================
-- 审计表
-- =============================================================================

CREATE TABLE ref.change_log (
    change_id    bigserial PRIMARY KEY,
    table_name   text        NOT NULL,
    op           text        NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE')),
    pk           jsonb       NOT NULL,     -- 被改行的主键值
    before_json  jsonb,                    -- INSERT 时为空
    after_json   jsonb,                    -- DELETE 时为空
    changed_cols text[],                   -- UPDATE 时实际发生变化的列
    db_user      text        NOT NULL DEFAULT session_user,
    app_user     text,                     -- 真实操作人，见下方说明
    changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ref.change_log (table_name, changed_at DESC);
CREATE INDEX ON ref.change_log (changed_at DESC);
CREATE INDEX ON ref.change_log USING gin (pk);

COMMENT ON COLUMN ref.change_log.db_user IS
  '实际连库的角色（session_user）。应用都以 fs_app 连，所以这个值几乎恒为 fs_app；
   它的用途是发现"不该有人手工改"的情况，比如出现 fs_owner 就说明有人直连改了数据。
   真正的操作人看 app_user。';
COMMENT ON COLUMN ref.change_log.app_user IS
  '真实操作人。应用需在事务开始时执行：
       SET LOCAL app.user_id = ''kevin@transknights.com'';
   触发器会读取它。不设则为 NULL——网页端必须设，否则审计等于没做。';


-- =============================================================================
-- 触发器函数
--
-- SECURITY DEFINER：以 fs_owner 身份写入审计表，因此 fs_app 只能读、
-- 不能改也不能删审计记录。审计日志能被被审计者篡改就失去意义了。
-- =============================================================================

CREATE OR REPLACE FUNCTION ref.log_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ref, pg_temp
AS $$
DECLARE
    pk_cols  text[] := TG_ARGV[0]::text[];
    b        jsonb  := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
    a        jsonb  := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
    pkv      jsonb;
    cols     text[];
    au       text   := nullif(current_setting('app.user_id', true), '');
BEGIN
    -- 主键值：从 before 或 after 里取出指定列
    SELECT jsonb_object_agg(k, COALESCE(a, b) -> k) INTO pkv
    FROM unnest(pk_cols) AS k;

    IF TG_OP = 'UPDATE' THEN
        -- 实际变化的列。排除 updated_at：应用通常每次更新都会刷它，
        -- 不排除的话每一行都显示"有变化"，审计立刻变成噪音。
        SELECT array_agg(key ORDER BY key) INTO cols
        FROM jsonb_each(a)
        WHERE key <> 'updated_at'
          AND b -> key IS DISTINCT FROM a -> key;

        -- 只有 updated_at 变了 → 不是实质变更，不记
        IF cols IS NULL THEN
            RETURN NEW;
        END IF;
    END IF;

    -- 用 session_user 而不是 current_user：本函数是 SECURITY DEFINER，
    -- 函数内的 current_user 是函数所有者（fs_owner），记下来毫无意义。
    -- session_user 始终是实际通过认证连上来的角色。
    INSERT INTO ref.change_log (table_name, op, pk, before_json, after_json,
                                changed_cols, db_user, app_user)
    VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP, pkv, b, a,
            cols, session_user, au);

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION ref.log_change() FROM PUBLIC;


-- =============================================================================
-- 挂载到五张人工资产表
-- 第二个参数是该表的主键列名数组，触发器用它构造 pk 字段。
-- =============================================================================

CREATE TRIGGER audit_entity
    AFTER INSERT OR UPDATE OR DELETE ON ref.entity
    FOR EACH ROW EXECUTE FUNCTION ref.log_change('{entity_id}');

CREATE TRIGGER audit_entity_member
    AFTER INSERT OR UPDATE OR DELETE ON ref.entity_member
    FOR EACH ROW EXECUTE FUNCTION ref.log_change('{company_id}');

CREATE TRIGGER audit_credit_policy
    AFTER INSERT OR UPDATE OR DELETE ON ref.credit_policy
    FOR EACH ROW EXECUTE FUNCTION ref.log_change('{entity_id}');

CREATE TRIGGER audit_terms_override
    AFTER INSERT OR UPDATE OR DELETE ON ref.terms_override
    FOR EACH ROW EXECUTE FUNCTION ref.log_change('{entity_id}');

CREATE TRIGGER audit_charge_class
    AFTER INSERT OR UPDATE OR DELETE ON ref.charge_class
    FOR EACH ROW EXECUTE FUNCTION ref.log_change('{billing_code}');


-- =============================================================================
-- 可读视图：把 jsonb 摊成「字段 / 原值 / 新值」，给网页的变更历史面板用
-- =============================================================================

CREATE VIEW ref.change_detail AS
SELECT l.change_id,
       l.changed_at,
       COALESCE(l.app_user, '(未记录操作人)') AS actor,
       l.db_user,
       l.table_name,
       l.op,
       l.pk,
       c.col,
       l.before_json -> c.col                 AS old_value,
       l.after_json  -> c.col                 AS new_value
FROM ref.change_log l
LEFT JOIN LATERAL unnest(
    COALESCE(l.changed_cols,
             -- INSERT / DELETE 没有 changed_cols，展开全部非空字段
             ARRAY(SELECT key FROM jsonb_each(COALESCE(l.after_json, l.before_json))
                   ORDER BY key))
) AS c(col) ON true;

COMMENT ON VIEW ref.change_detail IS
  '一行一个字段变化，便于网页直接渲染「谁把什么从 X 改成了 Y」。';

-- 额度变更单独一个视图：这是最需要被追问的一类改动
CREATE VIEW ref.credit_limit_history AS
SELECT l.changed_at,
       COALESCE(l.app_user, '(未记录操作人)')            AS actor,
       l.op,
       (l.pk ->> 'entity_id')::bigint                    AS entity_id,
       e.entity_name,
       (l.before_json ->> 'credit_limit')::numeric       AS old_limit,
       (l.after_json  ->> 'credit_limit')::numeric       AS new_limit,
       (l.before_json ->> 'duty_limit')::numeric         AS old_duty_limit,
       (l.after_json  ->> 'duty_limit')::numeric         AS new_duty_limit,
       l.after_json  ->> 'rationale'                     AS rationale
FROM ref.change_log l
LEFT JOIN ref.entity e ON e.entity_id = (l.pk ->> 'entity_id')::bigint
WHERE l.table_name = 'ref.credit_policy'
  AND (l.op <> 'UPDATE' OR 'credit_limit' = ANY(l.changed_cols)
                        OR 'duty_limit'   = ANY(l.changed_cols));


-- =============================================================================
-- 权限：应用只能读审计，不能写、不能改、不能删
-- 写入由 SECURITY DEFINER 触发器以 fs_owner 身份完成。
-- =============================================================================

GRANT SELECT ON ref.change_log, ref.change_detail, ref.credit_limit_history
    TO fs_app, fs_read;

-- 002 里给 ref 整体授了增删改（因为 ref 是人工维护层），
-- 这里把审计表单独收回来——它不是人工维护的数据。
REVOKE INSERT, UPDATE, DELETE ON ref.change_log FROM fs_app;
REVOKE USAGE, SELECT ON SEQUENCE ref.change_log_change_id_seq FROM fs_app;

-- 后续 migration 若再给 ref 批量授权，需要记得重新收回本表；
-- 为此这里留一条检查语句，发现异常时会显性报错：
DO $$
BEGIN
    IF has_table_privilege('fs_app', 'ref.change_log', 'UPDATE')
       OR has_table_privilege('fs_app', 'ref.change_log', 'DELETE')
       OR has_table_privilege('fs_app', 'ref.change_log', 'INSERT') THEN
        RAISE EXCEPTION 'fs_app 仍可写入 ref.change_log —— 审计表必须对应用只读';
    END IF;
END
$$;
