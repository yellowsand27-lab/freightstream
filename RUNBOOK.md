# FreightStream 分析库 — 部署与运维手册

> 状态：**数据库侧已全部跑通**（2026-09-15）
> **已上线 https://ai.transknights.com** · 镜像 133 万行 · 每晚 03:00(UTC) 自动刷新 · 登录直连 FS
> 页面：总览 / 数据分析(图表+员工产出) / 告警 / 应收 / 客户 / 利润分析 / 成本回收 / 开票时效 / 操作绩效 · 通知推送(R4)尚未实现

---

## 0. 这套东西是什么

一个**独立的 PostgreSQL 分析库**，与 FlowForge-AI 无任何关系——不引用 `ff_core`、
不引用 `ff_tenant_*`、不共用角色。它单向接收 FreightStream 生产库（MSSQL
`TRANSKNIGHTS`）的数据副本，在此之上做分析、在网页上呈现、按规则推送通知。

```
MSSQL TRANSKNIGHTS          Postgres freightstream            Web + 通知
   (严格只读)      ──ETL──▶   mirror  镜像，可重建      ──▶  ai.transknights.com
                              ref     人工资产，永久          邮件 / 以后 telegram、teams
                              ops     处理工作流
                              notify  通知规则与投递
                              mart    派生视图
```

**唯一的数据流向是从 MSSQL 出、不进。** 分析库里没有任何回写生产库的代码路径。

---

## 1. 已完成的部署步骤

| # | 脚本 | 身份 | 结果 |
|---|---|---|---|
| ✅ | `sql/001_bootstrap.sql` | postgres | 库 `freightstream` + 四个 `fs_*` 角色 |
| ✅ | `sql/002_schema.sql` | fs_owner | 5 schema · 21 表 · 14 视图 |
| ✅ | `sql/004_fix_charge_codes.sql` | fs_owner | 费用代码源表改为 `T_NCODECHARGE` |
| ✅ | `etl/refresh_mirror.py` | fs_etl | 首次全量：7 表 / 1,330,550 行 / 50s，逐表行数与源库一致（023 后为 **9 表**，+CR/DB 710,094 行） |
| ✅ | `sql/003_seed_ref.sql` | fs_app | 513 费用分类 · 18,177 实体 · 21 关联方 |
| ✅ | `sql/005_refresh_function.sql` | fs_owner | `mart.refresh_all()`，解决 matview 刷新权限 |
| ✅ | `sql/006_classify_and_tune.sql` | fs_owner | 3,109 实体分类 · 104 额度种子 · 重复付款拆分 |
| ✅ | `sql/007_tune_alerts.sql` | fs_owner | 告警聚合调优（详见第 3 节） |
| ✅ | `sql/008_fix_filtered_sums.sql` | fs_owner | 修正 FILTER 聚合返回 NULL |
| ✅ | `sql/009_ref_audit.sql` | fs_owner | `ref` 层变更审计（触发器 + 只读日志） |
| ✅ | `sql/012_as_of_aging.sql` | fs_owner | 历史时点账龄函数，已用 09-01 基线校验 |
| ✅ | `sql/013_auth.sql` | fs_owner | 登录角色映射 `ref.role_map`（其 fs_users 表已被 014 废弃）|
| ✅ | `sql/014_auth_live.sql` | fs_owner | 登录改实时直连 FS，删除密码同步表 |
| ✅ | `sql/010_source_readonly_login.sql` | MSSQL sysadmin | 建 `freightstream_reader` 只读登录 |
| ✅ | `sql/011_fix_deny_control.sql` | MSSQL sysadmin | 移除 `DENY CONTROL`（它传递否掉了 CONNECT） |
| ✅ | `sql/016_staff_activity.sql` | fs_owner | 员工产出视图 `mart.staff_activity` + 系统账号排除表 |
| ✅ | `sql/017_fix_duplicate_scope.sql` | fs_owner | 重复付款收窄到「同一提单」 |
| ✅ | `sql/018_duplicate_paid_basis.sql` | fs_owner | 重复付款敞口改按「实付」计 |
| ✅ | `sql/019_english_seed_notes.sql` | fs_app | 库内系统生成文案（note/rationale）统一改英文 |
| ✅ | `sql/020_duplicate_detail_basis.sql` | fs_owner | 重复付款改按「完全相同费用行(描述+费率+数量)被录多次」，排除分期/按量分批/多箱误报 |
| ✅ | `sql/021_file_pl.sql` | fs_owner | 每票盈亏视图 `mart.file_pl`（direct 自营，收入−成本=毛利；agency/柜级不做） |
| ✅ | `sql/022_op_scorecard.sql` | fs_owner | 操作员绩效记分卡物化视图 `mart.op_file`（逐票，归属 operator），并把它挂进 `mart.refresh_all()` |
| ✅ | `sql/023_crdb_mirror.sql` | fs_owner | CR/DB 代理对账单入镜像（`mirror.crdb_notes`/`crdb_lines`，ETL 第 8/9 张表）+ `mart.agent_rebill`；**修正「成本未转嫁」口径**：转嫁 = 客户应收 + 代理借记 |
| ✅ | `sql/024_fix_alert_unrecovered_cost.sql` | fs_owner | **修复 023 带出的回归**：`mart.alert_unrecovered_cost` 被重建成汇总形状、丢了五个告警视图共用的列契约，导致 `/api/overview` 与 `/api/alerts` 双双 500（首页卡在骨架屏）。按 007 口径恢复列契约，底表仍用 023 修正后的 gap |

> 新建一套环境时按编号顺序执行即可；`004` 的修正已同步回 `002`，
> 但保留该文件用于已建库的原地升级。

---

## 2. ✅ 生产库只读账号

ETL 已切换到 `freightstream_reader`，不再使用 `sa`。已验证：

```
GRANT  CONNECT / VIEW DEFINITION
DENY   INSERT / UPDATE / DELETE / ALTER / REFERENCES
角色   db_datareader
实测   全量 1,331,020 行读取通过（7 张表 + 2 个 JOIN 查询）
       源库会话视图确认只有 freightstream_reader 在连
```

**踩过的坑**：`010` 最初还 DENY 了 `CONTROL`。SQL Server 的权限有层级且 DENY 沿层级
向下传递，链路是 `CONNECT ← CONNECT REPLICATION ← CONTROL`，且 `CONTROL` 直接涵盖
`SELECT`——一条 `DENY CONTROL` 传递否掉 73 项权限，结果直连报 4060、`EXECUTE AS` 报 916。
`011` 用 `REVOKE CONTROL` 修掉。注意 `REVOKE` 才能删除已有的 DENY 记录，
重跑一条不含 `CONTROL` 的 `DENY` 语句是无效的——漏写不等于撤销。

剩余两项加固建议（非阻塞）：

1. `1433` 端口目前可从公网访问，建议对分析主机做 IP 白名单
2. 连接未加密（`encrypt: false`），SQL Server 2016 支持配证书后开启

## 3. 告警现状 · 已在真实数据上调优

调优前后的产出量对比——**这一步是打开通知开关前的必要工作**：

| 告警 | 调优前 | 调优后 | 关键调整 |
|---|---:|---:|---|
| `alert_credit_breach` | 9 | **7** | 剔除 `credit_limit < 100` 的源库脏值 |
| `alert_payment_overdue` | 22 | **22** | 无需调整 |
| `alert_unrecovered_cost` | 4,868 | **13** | 聚合到客户级 + 近 12 月 + 客户缺口 ≥ 1000 |
| `alert_duplicate_payment` | 925 | **4** | 存量拆出为报表，告警只报近 14 天新录入 |
| `alert_billing_delay` | 8,093 | **12** | 聚合到操作员 + 阈值 30→45 天 + 必须已发生成本 |

合计 58 条，属于可以每天看完的量。

**核心原则：告警聚合，网页下钻。** 一个人要的是「客户 X 有 12 票共 8,400 未转嫁」，
不是 12 封邮件。逐票明细留在 `mart.unrecovered_cost` / `mart.billing_lag` 供网页展开。

三个阈值的依据都来自实测，不是拍的：

- 开票延迟阈值定在 45 天，因为近 24 个月**已开票**的中位延迟是 24 天——
  原来的 30 天几乎等于中位数，那是常态不是例外
- 必须已发生应付成本：8,093 票未开票里只有 3,910 票有成本，
  其余多是作废或空壳单，催它开票没有意义
- 重复付款存量 925 组横跨 2007–2026，属一次性清理工作，
  不该混进日常告警流；`mart.duplicate_payment` 保留全量供清理用

### ⚠ 五个 `alert_*` 视图共用一份列契约 —— 改一个会打断另外四个

契约：`alert_code, dedup_key, entity_id, shipment_id, severity, amount, subject_zh, subject_en, detail_json`，
**顺序也是契约的一部分**。两个消费方都按位置吃它：

- `/api/alerts` 是 `SELECT * FROM v1 UNION ALL SELECT * FROM v2 …`——列数或类型对不上直接整个报错，五类告警一起挂
- `/api/overview` 的 `SELECT alert_code, amount FROM …`——少一个 `amount` 列同样整个 500

**踩过的坑（2026-09-29）**：`023` 重建 `mart.unrecovered_cost` 时顺手重建了
`mart.alert_unrecovered_cost`，写成了 `(alert_code, entity_id, entity_name, shipments, total_gap, latest_file)`
这个汇总形状——注释里写的还是「定义保持 007 调优后的口径」，是重建时漏了契约列，不是有意改。
结果 `/api/overview` 与 `/api/alerts` 双双 500。而前端 `Overview` 当时是
`api.get(...).then(setD)` 没有 `.catch`，请求一失败 `d` 永远是 `null`，
页面上所有 `loading={!d}` 的卡片**永远停在骨架屏**，不报错、不提示——
表现就是"首页统计卡出不来"，很难一眼看出是后端挂了。`024` 恢复契约。

前端同时补了两层，免得下次再出现"坏了但看不出来"：

- `pages/Overview` 有自己的错误态 + 重试按钮（接口挂了不再转骨架屏）
- `components/ApiErrorToast`（挂在 `App.tsx` 的 `AntApp` 里）监听 `unhandledrejection`，
  兜住其余 26 处 `api.get(...).then(setX)` 没有 `.catch` 的调用点——骨架屏仍会转，
  但至少会弹一条错误提示。自己 catch 过的不触发该事件，所以不会和页面内提示重复。
  `lib/api.ts` 把断网时 fetch 抛的 `TypeError` 也收敛成了 `ApiError(0)`，
  这样兜底只需要认一种错误类型。

**以后动任何 `alert_*` 视图，先跑这条验证**（任一列对不上就会报错）：

```sql
SELECT count(*) FROM (
  SELECT * FROM mart.alert_credit_breach
  UNION ALL SELECT * FROM mart.alert_payment_overdue
  UNION ALL SELECT * FROM mart.alert_unrecovered_cost
  UNION ALL SELECT * FROM mart.alert_duplicate_payment
  UNION ALL SELECT * FROM mart.alert_billing_delay) a;
```

---

## 4. ⬜ 打开通知 · 需要业务确认后

五条规则目前全部 `enabled = false`。打开前建议先人工核一轮误报。

```sql
-- 4a. 配 SMTP（密钥放 secret 引用，不要明文）
UPDATE notify.channel
SET config_json = '{"secret_ref":"freightstream/smtp/primary",
                    "from":"freightstream@transknights.com",
                    "host":"smtp.example.com","port":587}'::jsonb
WHERE kind = 'email';

-- 4b. 加收件人
INSERT INTO notify.recipient (display_name, channel_id, address, lang)
SELECT '财务经理', channel_id, 'finance@transknights.com', 'zh'
FROM notify.channel WHERE kind = 'email';

-- 4c. 订阅规则
INSERT INTO notify.rule_recipient (rule_id, recipient_id)
SELECT r.rule_id, p.recipient_id
FROM notify.rule r, notify.recipient p
WHERE r.alert_code IN ('credit_breach','payment_overdue','unrecovered_cost')
  AND p.address = 'finance@transknights.com';

-- 4d. 先看会发出什么，确认后再开
SELECT severity, subject_zh FROM mart.alert_unrecovered_cost ORDER BY amount DESC;
UPDATE notify.rule SET enabled = true WHERE alert_code = 'unrecovered_cost';
```

**以后加 Telegram / Teams 不用改 schema、不用改规则、不用改视图**——
往 `notify.channel` 插一行 `kind='telegram'`，把收件人挂到该渠道即可。

告警视图契约：每个 `mart.alert_*` 必须返回
`alert_code / dedup_key / entity_id / shipment_id / severity / amount / subject_zh / subject_en / detail_json`。
已验证五个视图列集完全一致。通知器是一个通用循环，**新增一类告警 = 建一个视图 + 插一行规则**。

`outbox.dedup_key` + `rule.throttle_hours` 负责去重限流。没有这一条，
同一个告警会天天发，两周后所有人都会把邮件规则静音——这是告警系统最常见的死法。

---

## 5. 日常运维

连接配置从 `documents/` 下的 yaml 读取，**不需要设环境变量**：

| 来源 | 提供 |
|---|---|
| `documents/FreightStream.yaml` | MSSQL 源库（`dbGroups` 里 `enabled` 的 mssql 组） |
| `documents/analytics-db.connection.yaml` | Postgres 分析库（`endpoints.etl`） |

环境变量 `FS_MSSQL_*` / `FS_PG_DSN` 仍然可用，且**优先级高于 yaml**——
生产环境建议只用环境变量注入密码，让 yaml 保持 `passwordSecretRef` 不落明文。

```bash
cd /Users/kevinqin/Documents/Projects/transknights/AI/FreightStream
. .venv/bin/activate

python etl/refresh_mirror.py --show-config     # 先确认用的是哪个账号（密码打码）
python etl/refresh_mirror.py --verify          # 全量刷新并比对行数
psql -U fs_app -d freightstream -c "SELECT * FROM mart.refresh_all();"
```

放进 crontab（业务低峰）：

```
0 3 * * *  cd /path/to/FreightStream && . .venv/bin/activate && \
           python etl/refresh_mirror.py && \
           psql -U fs_app -d freightstream -c "SELECT mart.refresh_all();"
```

常用检查：

```bash
# 刷新是否正常
psql -U fs_read -d freightstream -c \
  "SELECT table_name, status, row_count, finished_at FROM mirror.refresh_log
   ORDER BY started_at DESC LIMIT 10;"

# 只刷某几张表
python etl/refresh_mirror.py --tables charge_lines,invoices --verify

# 只读源库验证转换，不写 Postgres
python etl/refresh_mirror.py --dry-run
```

网页上的「数据截至 X」直接读 `mirror.refresh_log` 的最新成功记录——
让看的人知道数据是什么时候的，比追求强一致更有用。

**刷新机制**：`TRUNCATE` + `COPY` 在同一事务里。Postgres 的 `TRUNCATE` 是事务性的，
提交前读者始终看到上一版完整数据，所以刷新期间网页不会出现空窗，也不需要停机。
不做增量——`F_PaidAmt` 会在老单据上被后续收付款改写，按创建日期做增量必然漏掉回款。

---

## 6. 快照与历史

**结论：mirror 不做快照。** 源库行上带日期，所有流量型指标都能任意时点回溯：

| 指标 | 依据 |
|---|---|
| 应收账龄 | `invoice_date` + `paid_date`，当时未清取全额 |
| 开票延迟 | `shipments.created_at` + `invoices.invoice_date` |
| DSO / 实际付款天数 | `invoice_date` + `paid_date` |
| 滞期成本与回收 | `charge_lines.doc_date` |
| 成本未转嫁 | `charge_lines.doc_date` + 提单 |
| 重复付款 | `ap_vouchers.created_at` |

账龄回溯已用 **2026-09-01 的历史基线**（当时直查 MSSQL 得出）逐档校验：

| 账龄段 | 原始（直查 MSSQL） | 回溯（`mart.aging_as_of`） |
|---|---|---|
| 未到期 | 191 张 / 1,861,255 | 190 张 / 1,861,674 |
| 逾期 1-30 | 175 张 / 1,474,073 | 174 张 / 1,497,133 |
| 逾期 31-60 | 51 张 / 140,665 | 48 张 / 138,839 |
| 逾期 61-90 | 34 张 / 79,340 | 28 张 / 71,380 |
| 逾期 91-180 | 29 张 / 50,669 | 27 张 / 52,548 |
| 逾期 181-365 | 18 张 / 9,050 | 17 张 / 9,047 |
| 逾期 365+ | 3 张 / 7,000 | 3 张 / 7,000 |
| **合计** | **501 张 / 3,622,052** | **487 张 / 3,637,621** |
| 90 天以上占比 | 1.8% | 1.9% |

金额吻合度 99.6%。剩余 14 张差异已查明：原始查询未过滤作废发票，而两周内确有
发票被作废；且原始以「当前余额 > 1」判未清，对当时已部分收款的发票按残值计入。
不是管道错误。

**⚠ 公式有一个必须加的判断。** 校验过程中发现全库有 **11 张发票已收清但
`paid_date` 未盖**（面额合计 149,052）。只按 `paid_date IS NULL` 判"当时未清"会把
这 11 张按全额计入，把 90 天以上占比从 **1.9% 虚增到 5.7%**。
`mart.open_item_as_of` 已用 `paid_amt < invoice_amt` 兜掉这一类。
`paid_date` 整体缺失率是 0%（2019–2024、2026 全为 0，2025 仅 8 张），所以问题面很小，
但漏了这一条结论就会错。

用法（12 个月趋势一句 SQL，不需要任何快照表）：

```sql
SELECT g.d, sum(a.invoices), sum(a.freight_balance)
FROM generate_series('2025-10-01'::date, '2026-09-01'::date, '1 month') g(d),
     LATERAL mart.aging_as_of((g.d + interval '1 month - 1 day')::date) a
GROUP BY g.d ORDER BY g.d;
```

`mart.aging_as_of` 默认排除关联方（`Knights CHB` 等内部往来会让账龄失真），
`include_related => true` 时纳入。

关税腿有一个边界：源库没有 `duty_paid_date`，无法回溯，函数返回的
`duty_balance_current` 是当前值——列名刻意这么起，提醒调用方它不是 as-of 值。

**趋势图上线第一天就能回补 2007 年至今的完整序列**，不用等数据积累。

### `ref` 层是唯一例外，已做审计

`business_model` / `credit_limit` / `is_related_party` / `passthrough_expected`
是人判断出来的结论，每次修改覆盖上一版，不记就永久丢失且无法重建。

```sql
-- 谁把什么从 X 改成了 Y
SELECT changed_at, actor, table_name, col, old_value, new_value
FROM ref.change_detail ORDER BY change_id DESC LIMIT 20;

-- 额度调整专用视图
SELECT changed_at, actor, entity_name, old_limit, new_limit, rationale
FROM ref.credit_limit_history ORDER BY changed_at DESC;
```

**⚠ 网页端必须做的一件事**：每个写事务开头要设置操作人，否则审计只记到
`fs_app`（所有人共用的连接角色），等于没做审计。

```sql
BEGIN;
SET LOCAL app.user_id = 'kevin@transknights.com';   -- 必须
UPDATE ref.credit_policy SET credit_limit = 150000 WHERE entity_id = 123;
COMMIT;
```

已验证的性质：

- 只改 `updated_at` 不产生记录（否则审计立刻变噪音）
- `fs_app` 对 `ref.change_log` 只有 SELECT——`INSERT`/`UPDATE`/`DELETE` 全部被拒。
  写入由 `SECURITY DEFINER` 触发器以 `fs_owner` 身份完成，被审计者无法篡改日志
- `db_user` 记的是 `session_user`，所以它出现 `fs_owner` 就意味着有人绕过应用直连改了数据

### 可选：KPI 月度表

还没做，建议和网页一起做——等看板画出来才知道哪几个指标真需要趋势线。
它属于 `mart`（可重建，可随时 DROP 重算），不属于权威层。
建议频率：每月 1 号算上月月末一行做趋势，每日覆盖当月那一行供网页看当前值。

---

## 7. 数据现实备忘 · 建报表前必读

| 事实 | 后果 |
|---|---|
| 43% 应收按结算周期批量开票（`T_GENMAIN`） | 单票级指标必须按 `ref.entity.business_model` 分流，混算必错 |
| 57% 发票名义账期为 0 天，准时率 20% | 逾期必须用 `days_past_baseline`，不能用 `days_past_due_nominal` |
| 提柜日覆盖 0.3%（357/134,829） | **提柜延期列表做不了**；超期罚款金额可以（`mart.demurrage_penalty` 可靠） |
| 应付审批人字段全空（0/244,324） | 任何金额的付款都无系统级审批留痕——内控缺口，非分析问题 |
| `T_CODECHARGE` 是废表 | 费用代码用 `T_NCODECHARGE`（在用的 377 个代码命中率 100% vs 0%） |
| 源库额度字段开单时无校验 | 有额度的客户中多家严重超限（最高 897%）；实际额度管在 `ref.credit_policy` |
| CR/DB 对账单是多数提单的收支载体（近两年 94% 提单有、应收发票只有 42%） | **已于 023 纳入镜像**并修正「成本未转嫁」口径（转嫁 = 客户应收 + 代理借记）。修正前约 60% 是误报。见下方口径纠偏表第 5 行 |
| 15,001 家实体仍是 `unknown` | 它们无应收发票，不参与任何单票级告警；有业务后会自动分类 |

### 口径纠偏三次（都是"看着像漏洞、实为业务模式"，靠钻取到票才发现）

| 指标 | 错误的宽口径 | 收窄后 | 教训 |
|---|---|---|---|
| 滞期回收缺口 | 全口径 $11.2M "漏收" | 直客 not_rebilled 才算，$945K | 代理业务按周期结算，无单票应收，不是漏收 |
| 重复付款 | 同供应商+同发票号+同金额 925 组 $532K | +同一提单 → +按实付 → +「完全相同费用行被录多次」→ **疑似复核清单** 103 组（50 组 gap≥1h 更值得查） | 一个发票号常是**汇总账单**(MIIN-23032：110 条/25 提单/$61,695)；"录了"≠"付了"；分期、按量分批(仓储 36+4 天)、多箱都会被头层口径误判。**根本局限**：缺「供应商发票应付总额」这个源头锚点，纯我方录入数据无法区分"重复录入"与"分批正常业务"(数据长得一样)——故定位为**疑似清单**(方向 A)，不给确定判决，加**录入间隔** max_gap_hours(≈0 多为分批、隔时/隔天才可疑)供人工对发票原件核。要真正对账须引入供应商发票总额(发票录入/OCR)，属更大的项目 |
| （应收重复未做） | 原始 5280 组 $1.5M | 不做 | 多收客户会被客户自己发现挡回；力气放在无外部制衡的应付侧 |
| 成本未转嫁（第 5 次纠偏，**已修**·023） | 近12月 1,233 行 / $361,369 | 其中 **约 60%（$217,690 / 402 票）疑似误报**，duty 类 94% 误报 | 成本可以经 **CR/DB 贷借对账单**向海外代理收回，而 CR/DB 整套没进镜像。实证：TKIBIMIAS041764 判「duty 未转嫁 $17,426」，CR/DB 里 DUTY & FEE 借记 $17,426，分毫不差。storage/customs 类误报仅 4%/14%，那部分缺口仍可能是真的。修法（已实施）：023 把 T_CRDBHD/T_CRDBDETAIL 纳入 ETL，`mart.agent_rebill` 按 (票, 费用类别) 汇总代理借记，`unrecovered_cost.gap` 扣除之，并新增状态 `recovered_via_agent`；旧口径保留为 `gross_gap` 列可对比 |
| 操作员「超 45 天未开票」 | 全口径 CalvinL 524 票 | direct 口径 **5 票** | 同一个坑第四次出现：agency 按周期批量结算、单票永远"没开票"。凡按操作员考核的时效/金额指标，一律 `business_model='direct'`；产出量（票数）才用全口径，因为代理的活也是活 |

**通用规律：任何"重复/缺口/异常"类指标，先问三件事——(1) 是不是业务模式（多票/周期结算）；(2) 有没有算作废；(3) 是"记录"还是"实付/实收"。汇总数字骗人，钻取到票才见真。**

---

## 8. 生产部署（已上线）

**线上地址：https://ai.transknights.com**  —— 登录用各自的 FS 账户。

整套跑在 `ai.transknights.com` 这一台服务器上（Ubuntu 24.04，与 FlowForge 等站点共用，
部署时只新增、未改动现有站点）。

### 服务器布局

| 位置 | 内容 |
|---|---|
| PostgreSQL 16（本机 5432） | 分析库 `freightstream`，生产专属密码 |
| `/opt/freightstream/` | 代码：`api/`（编译后 dist）、`etl/`、`sql/`、`documents/`、`.venv/` |
| `/opt/freightstream/.env` | fs-api 用的密钥（`FS_PG_DSN`=**fs_app**、JWT、MSSQL），`chmod 600` |
| `/opt/freightstream/.env.etl` | **fs-etl 专用** env（同 `.env`，但 `FS_PG_DSN`=**fs_etl**）。见下方「ETL 必须用 fs_etl」 |
| `/var/www/ai.transknights.com/` | 前端 `web/dist`（SPA），`share/` 子目录是设计文档，未动 |
| systemd `fs-api.service` | API 常驻 127.0.0.1:8787，开机自启、崩溃自重启 |
| systemd `fs-etl.timer` | 每晚 03:00(UTC) 全量刷新 + 重建物化视图 |

> **⚠ ETL 必须用 fs_etl 连 Postgres（踩过的坑）**
> `refresh_mirror.py` 会 TRUNCATE+COPY 重建 mirror，需要写权限，只有 `fs_etl` 有；`fs_app` 对 mirror 只读，用它跑 ETL 会在写第一条 `refresh_log` 时就 `permission denied` 退出。
> `fs-api` 和 `fs-etl` 不能共用同一个 `.env`：api 要 fs_app、etl 要 fs_etl，而 `FS_PG_DSN` 变量名相同会冲突。
> 更坑的是 **systemd 里 `EnvironmentFile=` 会盖过 `Environment=`**（与直觉相反），所以靠 drop-in 加一行 `Environment=FS_PG_DSN=...` 覆盖 `.env` 是无效的。
> 正解：给 fs-etl 一份独立的 `/opt/freightstream/.env.etl`（`FS_PG_DSN`=fs_etl），用 drop-in `/etc/systemd/system/fs-etl.service.d/override.conf` 让它**只**加载这份：
> ```ini
> [Service]
> EnvironmentFile=
> EnvironmentFile=/opt/freightstream/.env.etl
> ```
> 验证运行时实际生效的账号：`systemd-run --wait --pipe --property=EnvironmentFile=/opt/freightstream/.env.etl /bin/sh -c 'echo $FS_PG_DSN'`（应为 fs_etl）。
| nginx（复用现有 vhost + 证书） | `/` → SPA，`/api/` → 反代 8787，`/share/` → 文档 |

数据流向不变：ETL 从 MSSQL 只读拉数 → 本机 Postgres；登录时 API 直连 MSSQL 实时校验。

### 服务器运维命令

先 SSH 上去：`ssh root@ai.transknights.com`（建议尽快换成 SSH key，见下）。

```bash
# 服务状态
systemctl status fs-api.service          # API 状态/日志摘要
systemctl is-active fs-etl.timer         # 定时器是否在跑
systemctl list-timers fs-etl.timer       # 下次刷新时间

# 看日志
journalctl -u fs-api.service -n 100 -f   # API 实时日志（登录、报错）
journalctl -u fs-etl.service -n 50       # 最近一次 ETL 刷新日志

# 手动立刻刷新一次数据（不等夜里）
systemctl start fs-etl.service           # 跑完约 4 分钟；进度看 journalctl -u fs-etl.service -f

# 重启 / 停 API
systemctl restart fs-api.service
systemctl stop fs-api.service

# 数据新鲜度
sudo -u postgres psql -d freightstream -c \
  "SELECT table_name,status,row_count,finished_at FROM mirror.refresh_log ORDER BY started_at DESC LIMIT 8;"
```

### 更新已上线的代码

前端或 API 改动后，从本地重新构建并推送：

```bash
# 本地：
cd web && npx vite build                 # 出 web/dist
cd ../api && npm run build               # 出 api/dist
# 推送（用 sshpass 或 scp）：
scp -r web/dist/*  root@ai.transknights.com:/var/www/ai.transknights.com/
scp -r api/dist    root@ai.transknights.com:/opt/freightstream/api/
ssh root@ai.transknights.com 'systemctl restart fs-api.service'
```
前端是静态文件，推完即时生效（用户刷新即可）；API 改动需 restart。
数据库迁移（新增 sql/xxx.sql）：scp 到 `/opt/freightstream/sql/` 后按对应角色 psql 执行。

### 密钥

`/opt/freightstream/.env` 持有：PG 各角色密码（生产专属，与本地开发不同）、
`FS_JWT_SECRET`（固定，重启不登出）、MSSQL 只读账号密码。备份这个文件 = 备份全部凭据。

### ⚠ 收尾项（不阻塞使用）

1. **`deploy.sh` 里有 root 明文密码**，本次部署即用它。强烈建议换成 SSH key 登录、删掉密码。
2. **MSSQL 目前公网直连** `47.176.245.212`。若关闭公网直连（本地 yaml 的 SSH 隧道注释暗示此方向），
   服务器需配 autossh 隧道到 `localhost:14330`，并把 `.env` 的 `FS_MSSQL_HOST/PORT` 改过去。
3. `.env` 里 MSSQL 密码为明文（内部凭据，可接受）；规范上建议接密钥管理。

---

## 9. 数据分析页（图表 · 钻取 · 员工产出）

侧栏「数据分析」，用 ECharts 呈现，配色取自校验过的调色板；金额轴用紧凑格式（`$7M`）。

### 图表
| 图 | 数据源 | 说明 |
|---|---|---|
| 月度开票额 | `analytics/business-trend` | 柱状 |
| 发票数 / 进口提单 | 同上 | 双线（同为件数，可同轴；金额与件数不同轴，故拆两张——不做双 Y 轴）|
| 回款速度 DSO | `analytics/dso-trend` | 中位+P90；近月偏低是"尚未收清的还多"的幸存者偏差，已在 ⓘ 注明 |
| 应收账龄（月末） | `mart.aging_as_of` | 堆叠柱，回溯计算无需快照 |
| 滞期回收趋势 | `costs/demurrage/trend` | 年×科目，可切"仅直客" |
| 客户敞口 Top / 成本未转嫁按类别 | `analytics/top-customers` 等 | 横向条形 |

### 员工产出（绩效）
- 数据源 `mart.staff_activity`：三类"新建"合成一张——提单/应收发票/应付录入。
  **源库只存首建(U1)与最后改(U2)，所以是"产出量"，不是全部操作。**
- 系统账号（如 `AMS`）由 `ref.system_account` 排除，可维护、走审计。
- 形态：GitHub 式日历热力图（全团队或选某人）+ 产出排行（提单/应收/应付拆开，
  不合并成一个笼统分——不同岗位产出类型不同）+ 点某天钻取到当天新建的每张单。
- 接口：`analytics/staff/leaderboard`、`/daily`、`/day`。

### 交互约定（成本回收 / 分析各表通用）
- **钻取**：统计行 → 抽屉列出背后的每一票/每一张凭证，可再进客户 360。
- **全量汇总行**：表底固定一行，汇总**整个数据集**（非当前页）——对 dataSource
  全量数组自求和，不用 antd 默认的"仅当前页"summary。
- **全量排序**：点列头对整表排序（非当前页），泛型辅助 `numSort/dateSort/strSort`。
- **术语说明**：晦涩/有歧义的列头带 ⓘ（未清/敞口/逾期、未转嫁状态、DSO、cron、限流…），
  三语文案在 `web/src/i18n/locales/*.json` 的 `*Help` 键。

---

## 10. 网页开发（R3）

```
web/   React 18 + TypeScript + Vite 6 · Ant Design 5 + pro-components · ECharts 5 · react-i18next
api/   Fastify 5 + pg · 把 mart.* 视图暴露为 JSON；写路径只有 ref（额度、业务模式），全部走审计事务
```

**为什么有 api/**：浏览器不能直接连 Postgres。API 是一层薄壳，不含任何业务计算——
口径全部在数据库视图里，这样网页、通知器、BI 看到的是同一套数字。

### 本地运行

```bash
make install     # 首次：安装 api/ 与 web/ 依赖
make dev         # 开发：API(8787) + 前端热更新 → http://localhost:5173
make preview     # 部署前测试：生产构建 + 本地 API → http://localhost:4173
```

两种模式的区别：`dev` 是 Vite 开发服务器（未打包、热更新，几百个 ESM 模块）；
`preview` 跑的是 `npm run build` 的产物 `web/dist`——**和线上完全一样的文件**，
只是由 Vite 的静态服务器托管并把 `/api` 代理到本地 API。部署前用它验收。

品牌素材（取自 transknights.com 的盾形标）在 `web/public/brand/`：
favicon 全套（16/32/48/180/192/512 + `.ico`）、侧栏 logo、`KNIGHTS GROUP` 字标。
主题色 `#0F64AA` 蓝 / `#212D59` 藏青，定义在 `web/src/App.tsx` 的 `BRAND`。

首次打开先到「设置」填写你的名字——**每次修改额度都会以此记入审计日志，不填无法编辑**。

### 页面

| 路由 | 数据源 | 内容 |
|---|---|---|
| `/` | `/api/overview` `/api/aging/trend` | 6 个 KPI · 账龄趋势（`mart.aging_as_of` 回溯，无快照表）· 告警计数 |
| `/alerts` | 五个 `mart.alert_*` | 58 条聚合告警 + 通知规则状态 |
| `/receivables` | `mart.open_item` `mart.related_party_ledger` | 双口径逾期明细 · 关联方往来 |
| `/customers` | `mart.entity_exposure` | 敞口 / 额度使用率 / 付款行为 |
| `/customers/:id` | 多视图 | 客户 360：额度编辑（审计）· 付款基线 · 未清 · 关联账号 · 额度变更历史 |
| `/costs` | `mart.unrecovered_cost` `mart.demurrage_penalty` `mart.duplicate_payment` | 成本未转嫁 · 滞期归因 · 重复付款清理 |
| `/billing` | `mart.billing_lag` | 按操作员汇总 + 逐票明细，阈值可调 |
| `/settings` | — | 语言 / 时区 / 操作人 |

### i18n（已按要求 day 1 到位）

- 所有文案走 locale key；`web/src/i18n/locales/{en-US,zh-CN,es-ES}.json`，en/zh 各 183 键完全对齐，es 为部分（验证回退）
- 语言包运行时动态 import，构建后各自独立分块（en 5.7 KB / zh 5.5 KB / es 1.5 KB）
- 回退 `en-US`；浏览器自动检测 + 用户覆盖持久化到 localStorage
- 数字 / 日期 / 货币全部经 `web/src/lib/format.ts` 的 `Intl.*`，跟随语言与用户时区；组件内禁止直接 `toFixed`
- 时区用户可选，默认 `America/Los_Angeles`（租户策略，见 `lib/prefs.ts`）
- Ant Design 与 dayjs 的 locale 同步切换
- 后端错误码映射到本地化消息（`ApiError.errorKey`）

已验证：`navigator.language = zh-CN` 时整站中文，货币显示 `US$126,313`、日期 `2026/06/24`；
en-US 下为 `$126,313`、`06/24/2026`。

### 部署到 ai.transknights.com

```bash
cd web && npm run build                       # 产出 web/dist/（静态文件）
cd api && npm run build                       # 产出 api/dist/（node 运行）
```

服务器侧需要：
1. `api/dist` 以 Node 22 常驻运行（systemd 或 pm2），环境变量 `FS_PG_DSN` 指向分析库、`PORT=8787`
2. Nginx 托管 `web/dist`，并把 `/api/*` 反向代理到 `127.0.0.1:8787`；SPA 需 `try_files $uri /index.html`
3. 正式上线前把 `x-user` 头换成真实认证（会话 / SSO）——现在是开发期占位，
   任何人都能在设置里填名字。数据库端的审计机制不变，只是身份来源要可信

现有 `documents/scripts/deploy.sh` 只 rsync `share/*`，网页与 API 的部署需要另加步骤。

> **安全提醒**（重复一次）：`deploy.sh` 里有 `root` 明文密码、走 SSH 密码登录、目标是公网主机。
> 建议换成 SSH key + 非 root 部署账号。

---

## 11. 登录认证（以 FS 账户，实时直连校验）

每个 FS 用户用**自己的 FS 用户名 + FS 密码**登录本系统。

### 密码怎么处理

- 登录时 API **直连 FS 生产库（只读账号 `freightstream_reader`）**读 `T_USER`，
  当场核对密码。**分析库不存任何密码，连哈希都不存。**
- FS 密码是明文 + 末尾 `0x1C` 结束符，去掉结束符后做**常量时间比较**（防时序探测）。
- 改了 FS 密码或新增用户**立即生效**，没有同步延迟。
- 登录成功签发 JWT（HS256，默认 12 小时）；之后 `/api`（除 `/api/health`、
  `/api/auth/*`）都要 Bearer token。审计身份来自 token，前端无法伪造。

**代价**：FS 库不可达时无法登录（登录是唯一在线依赖 FS 的路径），此时返回 503。
已登录用户的 token 在有效期内不受影响。分析数据本身仍来自 Postgres 镜像，与 FS 在线无关。

### 角色

`ref.role_map` 把 FS 分组映射到三档，可人工调整且走审计：

| FS 分组 | 角色 | 权限 |
|---|---|---|
| Admin | admin | 全部 |
| Managers / CPA & GM / Accounting | editor | 可改额度、业务模式、分类 |
| Operation / Sales / Guest / 其他 | viewer | 只读 |

viewer 看不到编辑按钮，后端 `requireEditor` 再拦 403（前后端双保险）。
缺映射的分组默认 viewer（最小权限）。

### ⚠ 给 IT 的安全发现

**FS 源库密码是明文且偏弱**（如 `Cheng2022A`）。这是 FS 自身设计，建议推动加密或换 SSO。

### 配置

- API 的 FS 连接从 `documents/FreightStream.yaml` 读（与 ETL 同源），
  也可用 `FS_MSSQL_HOST/PORT/USER/PASSWORD/DATABASE` 环境变量覆盖
- `FS_JWT_SECRET`：JWT 签名密钥。不设则首次生成 `api/.jwt_secret`（已 gitignore）。
  **生产必须用环境变量注入固定值**，否则重启后所有人被登出
- `FS_JWT_TTL_HOURS`：token 有效期，默认 12

---

## 12. 凭据

四个 `fs_*` 角色的连接串在 [documents/analytics-db.connection.yaml](documents/analytics-db.connection.yaml)。
密码只使用 RFC 3986 unreserved 字符集（`A-Za-z0-9-_.~`），因此连接串中无需 percent-encode。

**这是本地开发凭据，上生产前请轮换并改用 secret 引用。**

| 角色 | 权限边界 |
|---|---|
| `fs_owner` | 只做 DDL / migration，平时不应被任何服务持有 |
| `fs_etl` | 只写 `mirror`，读 `ref`，无 DDL |
| `fs_app` | 读全部，写 `ops` / `ref` / `notify` |
| `fs_read` | 全库只读，给 BI 与临时分析 |

---

## 13. 操作绩效记分卡（`/op`）

**为什么在"每票成本算不准"的情况下还能做**：单票精确毛利被 ERP 记账结构卡住了
（`T_OPACCT` 操作台账与 `T_APDETAIL` 财务凭证对同一票各记一半成本、互相矛盾，
已发英文信请业务/财务确认哪张表权威——见第 7 节与 memory `opacct-is-correct-cost-source`。
2026-09-25 的 CR/DB 发现已把问题缩小成"确认三段式模型"，见第 14 节）。
但"衡量 OP 干得好不好"不必等那个答案：除毛利外的四个维度数据都是干净的。

| 维度 | 指标 | 数据来源 | 可靠性 |
|---|---|---|---|
| 产出量 | 建单票数 / 服务客户数 / 开票金额 | `mirror.shipments`（`operator` 覆盖 99.9%）| 高 |
| 开票时效 | 建单→首次开票天数中位数、超 45 天未开票 | 同上 + `mirror.invoices` | 高 |
| 成本转嫁 | 该转嫁未转嫁的缺口 | `mart.unrecovered_cost` | 高（direct 口径，**023 起扣除代理借记**） |
| 滞期回收 | 滞期/滞箱/仓储 付出 vs 收回 | `mart.demurrage_penalty` | 高（100% 挂提单） |
| 录入质量 | 疑似重复录入组数 | `mart.duplicate_payment` | **仅线索**，须对发票原件核 |
| ~~毛利~~ | 待业务方确认成本口径后加列 | — | 暂不可算 |

**状态**：2026-09-25 已部署生产（https://ai.transknights.com/op）。生产 `mart.op_file` 84,254 行 / 169 个 operator，
`mart.refresh_all()` 已替换为含 `op_file` 的版本，每晚 ETL 后自动重建。

**实现**：`sql/022_op_scorecard.sql` 建物化视图 `mart.op_file`（**每票一行**，本地 84,127 行），
API `api/src/routes/staff.ts`（`/api/staff/{summary,scorecard,trend,files,operators}`），
页面 `web/src/pages/OpScorecard.tsx`（菜单「操作绩效」）。

几个刻意的设计选择，改动前请先读懂：

- **逐票粒度，不是每人每月**。中位数不能由月度中位数再聚合（median of medians 是错的），
  必须在查询端对原始行算 `percentile_cont`。逐票同时把钻取列表免费给出来了。
- **物化视图**。底层 `unrecovered_cost`/`demurrage_penalty` 每次都要扫 `charge_lines`（75.8 万行），
  普通视图时一次记分卡查询 1.7s；物化后 10ms。已挂进 `mart.refresh_all()`（每晚 ETL 后重建，耗时 1.8s）。
  因此**不存"距今天数"**这类字段，未开票天数由查询端用 `CURRENT_DATE` 现算。
- **归属按 `operator`（操作归属人），不是 `created_by`（录单人）**。二者不同域：
  `operator` 171 个值 / `created_by` 189 个，仅 149 重合。数据分析页的「员工产出」
  （`mart.staff_activity`）用的是 `created_by`，**两页数字不可互相对照**，页面提示已写明。
- **不给综合评分**。各人的货型与客户结构差别极大（有人专做一个大代理客户、有人做几十个直客），
  单一分数会把结构差异当成能力差异。五个维度并列，由人判断。
- **金额与时效只算 direct**，产出量用全口径——见第 7 节口径纠偏表第 4 行（524 票 → 5 票那一条）。
- **提柜及时率做不了**：`pickup_date` 覆盖仅 0.9%，属流程改造（见 `mart.container_dwell` 注释）。

**趋势图的已知偏差（页面已标注）**：最近一两个月的"开票时效中位数"必然偏低——
只有已开票的票才有时效，当月刚建、还没开票的票不进分母。不要读成"时效在改善"。

**首轮实测（近 12 月，17 个在岗操作员 / 4,991 票 / 团队时效中位 22 天）**，
三个值得跟进的具体信号：

| 信号 | 数字 | 建议动作 |
|---|---|---|
| SammiL 超 45 天未开票 | 145 票 direct 里 **55 票**未开票，最久的 200 天（LINGLONG AMERICAS，已发生成本 $3,480） | 逐票核：是在等客户资料，还是漏了 |
| SergioC | 时效中位 **42 天**（团队 22）+ 成本未转嫁 **$166K**（占全团队 $295K 的 56%） | 先看他的客户结构是否特殊，再谈流程 |
| winnie 滞期回收率 | **24.7%**（付出 $5,290 / 收回 $1,305） | 量不大但比率最差，看是合同不让转嫁还是漏收 |

数字会随每晚刷新变化，上面是 2026-09-25 的快照，用于建立基线。

---

## 14. CR/DB 代理对账单（023）· 第 5 次口径纠偏

**发现**：`T_CRDBHD`/`T_CRDBDETAIL` 是与**海外代理/关联公司**的贷项借项对账单，
一直没进镜像，而它才是多数提单的收支载体。

| 近两年（2024-01 起）提单 | 票数 | 占比 |
|---|---:|---:|
| 合计 | 18,188 | — |
| 有 CR/DB 对账单 | 17,128 | **94%** |
| 有应收发票 | 7,680 | 42% |
| **只有 CR/DB、无应收发票** | 9,820 | **54%** |
| 两者都有 | 7,308 | 40% |
| 两者都无 | 688 | 4% |

**结构（已验证，非推测）**：明细行带 `F_Debit`（代理欠我们）/`F_Credit`（我们欠代理），
且 `F_STBName='T_OPACCT'` —— **CR/DB 行由操作台账生成**。恒等式
`F_Total = Σ借 − Σ贷` 在 2024 年起 **41,409 单上 100% 吻合**，
说明这张表干净、可直接当账用。

**它解开了"每票成本"的谜**：HBL `DGSS20222386` 的海运 $146,300 在 `T_APDETAIL`
找不到，因为它经 `TKI-CR/DR064405` 贷记给了代理 DGS LOGISTICS：

```
贷 OCEAN FREIGHT CHARGE 40HC  146,300     ← 就是那笔"消失"的成本
贷 AMS FILING FEE                  35
借 AGENT PROFIT SHARE             550     ← 我们真正赚的
借 HANDLING CHARGE TO AGENT        85
      146,335 − 635 = 145,700 = F_Total ✓
```

所以成本**不是"哪张表权威"的二选一，而是三段式**：
`T_OPACCT` 是源头台账 → 对客户/供应商走 `INVODETAIL`/`APDETAIL`，对代理走 `CRDBDETAIL` 轧差。
给业务方的问询信应据此改写：从"请问哪张表权威"改成"请确认这个模型对不对"。

**修了什么**：`mart.unrecovered_cost` 原来只认"开给客户的应收"算转嫁，
把"经 CR/DB 向代理借记收回"误判成没转嫁。023 起
**转嫁 = 客户应收（`ar_amount`）+ 代理借记（`agent_debit`）**，
并新增状态 `recovered_via_agent`；旧口径保留为 `gross_gap` 列供对比。

关键前提：**CR/DB 与应收/应付用同一套费用代码**（`DUTY.OI`/`CHASSIS.OI`/`STORAGE.OI`…），
可直接接 `ref.charge_class`，"同类"有严格定义，不需要另建映射表。这一点核过，不是假设。

**为什么不塞进 `mirror.charge_lines`**：那张表被 `file_pl`、`duplicate_payment`、
`demurrage_penalty` 等十几处直接 SUM，多一个 direction 会**静默改变**所有既有口径。
单独建表，由各 mart 视图显式选择是否纳入。

**执行顺序（三步，缺一不可）**：

```bash
# ① 建表 + 重建视图（表会被重建成空表）
psql -U fs_owner -d freightstream -f sql/023_crdb_mirror.sql
# ② 灌数，约 4 分钟 / 71 万行
.venv/bin/python etl/refresh_mirror.py --tables crdb_notes,crdb_lines --verify
# ③ 重建 op_file，否则记分卡仍是旧缺口
psql -d freightstream -c "SELECT * FROM mart.refresh_all()"
```

**实测效果（近 12 月 · direct 口径）**：

| | 修正前 | 修正后 |
|---|---:|---:|
| 团队「成本未转嫁」 | $295,461 | **$109,860**（−63%） |
| SergioC | $166,440 | $33,773（他经代理收回 $2.57M） |
| `alert_unrecovered_cost` 告警 | 13 条 | 9 条 / $101,198 |

全历史口径下，**33,105 票**被重新归类为 `recovered_via_agent`（旧口径虚报缺口 $40.2M），
原先那批"整票无应收"的票从数千降到 **710 票**——这就是第 7 节 4,214 票疑问的答案。

**验证过的两个反向案例**（一真一假，证明不是一刀切）：
- `TKIBIMIAS041764` duty 缺口 $17,426 → **归零**，CR/DB 里 DUTY & FEE 借记 $17,426，分毫不差；
- `LLPAOL020513` demurrage 缺口 $18,899 → **保留**，CR/DB 里没有对应借记（真漏收，现为 /costs 榜首）。

**新状态 `agent_partial`（刻意不算漏收）**：整票没有客户账单、代理只借记了一部分。
差额多为定价结构——实测我方付 chassis $1,800、只向代理收 $160。
全历史 1,321 票 / 旧口径 $2.17M 被移出"漏收"，单列可见可钻取。
沿用 RUNBOOK 的通用规律：**宁可漏也别把正常业务误标**。

**还没做的后续**（CR/DB 打开的门）：
1. **agency 单票盈亏**——54% 的票收入侧在 CR/DB 里，`mart.file_pl` 也许不必再只算 direct；
2. 复核 `recovery_state='no_ar_invoice'` 的那批票（原 4,214 票）；
3. `crdb_notes.profit_share` / `PS.OI` 代码可单独看代理分润。
