-- =============================================================================
-- 005 —— 物化视图刷新函数
--
-- 执行身份：fs_owner
--     psql -U fs_owner -d freightstream -f sql/005_refresh_function.sql
--
-- 原因：REFRESH MATERIALIZED VIEW 要求调用者是该视图的所有者，
--   而 fs_app / fs_etl 都不是（所有者是 fs_owner）。
--   直接把所有权给应用角色不合适——它同时意味着 DROP 权限。
--   正确做法是用一个 SECURITY DEFINER 函数把这一个动作授权出去。
--
-- 为什么不用 CONCURRENTLY：REFRESH ... CONCURRENTLY 不能在事务块内执行，
--   而 plpgsql 函数体本身就在事务里。夜间刷新时的短暂排他锁可以接受；
--   若将来要求刷新期间零阻塞，则由调度器以 fs_owner 身份在函数外直接调用
--   REFRESH MATERIALIZED VIEW CONCURRENTLY mart.payment_baseline。
-- =============================================================================

CREATE OR REPLACE FUNCTION mart.refresh_all()
RETURNS TABLE (view_name text, rows bigint, elapsed interval)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = mart, mirror, ref, pg_temp
AS $$
DECLARE
    t0 timestamptz;
    n  bigint;
BEGIN
    t0 := clock_timestamp();
    REFRESH MATERIALIZED VIEW mart.payment_baseline;
    SELECT count(*) INTO n FROM mart.payment_baseline;
    RETURN QUERY SELECT 'mart.payment_baseline'::text, n, clock_timestamp() - t0;
END;
$$;

REVOKE ALL ON FUNCTION mart.refresh_all() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mart.refresh_all() TO fs_etl, fs_app;

COMMENT ON FUNCTION mart.refresh_all() IS
  'ETL 结束后调用，重建派生物化视图。SECURITY DEFINER，仅授予 fs_etl / fs_app 执行权。';
