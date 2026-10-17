#!/usr/bin/env python3
"""
FreightStream mirror 层刷新

    MSSQL TRANSKNIGHTS (只读)  ──游标流式──▶  Postgres freightstream.mirror.*

设计要点
--------
1. 不落中间文本文件。行对象直接喂给 psycopg 的 COPY，由驱动做类型适配与转义。
   源数据里 63 个客户名嵌了换行符、6 个嵌了制表符、4 个含竖线——任何基于
   分隔符的文本导出都会在这些行上静默错位。走 COPY 协议就没有这个问题。

2. TRUNCATE + COPY 在同一事务里。Postgres 的 TRUNCATE 是事务性的，提交前
   读者始终看到上一版完整数据，刷新期间网页不会出现空窗，也不需要停机。

3. 全量刷新，不做增量。F_PaidAmt / F_DutyPaidAmt 会在老单据上被后续收付款
   改写，按创建日期做增量必然漏掉回款。全量约 150 万行，代价可以接受。

4. 金额在源库是 float。float 存钱本身就有精度隐患（SQL Server 自己都认为
   2.72 有 2 位小数之外的残余），落地前统一量化成 Decimal(18,2)。

5. mirror.charge_lines.line_id 是生成列，由 (direction, src_line_id) 决定，
   因此每晚重建后取值不变——ops.case_link 引用它。COPY 时不提供该列。

配置来源（按优先级，前者覆盖后者）
--------
1. 环境变量
       FS_MSSQL_HOST / FS_MSSQL_PORT / FS_MSSQL_USER / FS_MSSQL_PASSWORD
       FS_MSSQL_DATABASE / FS_PG_DSN
2. 配置文件
       documents/FreightStream.yaml            → MSSQL 源库（dbGroups 中 enabled 的 mssql 组）
       documents/analytics-db.connection.yaml  → Postgres 分析库（endpoints.etl）

改 yaml 就会生效，不需要同时改环境变量。生产环境建议只用环境变量注入密码，
让 yaml 里保持 passwordSecretRef 而不落明文。
用 --show-config 可以确认实际生效的配置（密码已打码）。

用法
--------
    python refresh_mirror.py                     # 全量刷新
    python refresh_mirror.py --dry-run           # 只读源库并校验，不写 Postgres
    python refresh_mirror.py --tables companies,invoices
    python refresh_mirror.py --verify            # 刷新后比对源库与镜像行数
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from decimal import Decimal, InvalidOperation

import pymssql
import psycopg
import yaml

BATCH = 5000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---------------------------------------------------------------- 配置
def _yaml(name):
    path = os.path.join(ROOT, "documents", name)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def load_config():
    """环境变量优先，其次读 documents/ 下的 yaml。两者都缺才报错。"""
    ms = {"host": None, "port": "1433", "user": None,
          "password": None, "database": "TRANSKNIGHTS"}

    doc = _yaml("FreightStream.yaml") or {}
    groups = [g for g in (doc.get("dbGroups") or [])
              if g.get("enabled") and g.get("driver") == "mssql"]
    if groups:
        g = groups[0]
        ms.update(host=g.get("host"), port=str(g.get("port", 1433)),
                  user=g.get("user"), password=g.get("password"),
                  database=g.get("database", "TRANSKNIGHTS"))
        if not g.get("password") and g.get("passwordSecretRef"):
            ms["password_hint"] = (
                f"yaml 中只有 passwordSecretRef（{g['passwordSecretRef']}），"
                "未含明文密码；请用 FS_MSSQL_PASSWORD 注入")

    for key, env in (("host", "FS_MSSQL_HOST"), ("port", "FS_MSSQL_PORT"),
                     ("user", "FS_MSSQL_USER"), ("password", "FS_MSSQL_PASSWORD"),
                     ("database", "FS_MSSQL_DATABASE")):
        if os.environ.get(env):
            ms[key] = os.environ[env]

    pg = os.environ.get("FS_PG_DSN")
    if not pg:
        adoc = _yaml("analytics-db.connection.yaml") or {}
        pg = ((adoc.get("endpoints") or {}).get("etl") or {}).get("connectionString")

    missing = [k for k in ("host", "user", "password") if not ms.get(k)]
    if missing:
        hint = ms.get("password_hint")
        sys.exit("MSSQL 配置缺失: " + ", ".join(missing)
                 + (f"\n  {hint}" if hint else "")
                 + "\n  可用 documents/FreightStream.yaml 或 FS_MSSQL_* 环境变量提供")
    return ms, pg


def _mask(v):
    if not v:
        return "(未设置)"
    return v[:2] + "*" * max(len(v) - 4, 3) + v[-2:] if len(v) > 5 else "*" * len(v)


def show_config(ms, pg):
    print("实际生效的配置")
    print(f"  MSSQL  {ms['user']}@{ms['host']}:{ms['port']}/{ms['database']}"
          f"  password={_mask(ms.get('password'))}")
    if pg:
        import re as _re
        print("  PG     " + _re.sub(r"://([^:]+):[^@]*@", r"://\1:****@", pg))
    else:
        print("  PG     (未设置)")


# ---------------------------------------------------------------- 取值转换
def money(v) -> Decimal:
    """源库金额是 float，量化到 2 位小数再落库。"""
    if v is None:
        return Decimal("0.00")
    try:
        return Decimal(f"{float(v):.2f}")
    except (ValueError, InvalidOperation, TypeError):
        return Decimal("0.00")


def num(v):
    """数量/单价：保留 4 位，允许为空。"""
    if v is None:
        return None
    try:
        return Decimal(f"{float(v):.4f}")
    except (ValueError, InvalidOperation, TypeError):
        return None


def as_date(v):
    return v.date() if hasattr(v, "date") else v


def as_ts(v):
    return v


def flag(v) -> bool:
    """源库用 varchar '0'/'1' 存布尔，不是 'Y'/'N'——按 'Y' 判断会全判成 false。"""
    return str(v).strip() == "1"


def as_int(v, default=0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def opt_int(v):
    """外键类字段：0 与 NULL 都视为"无"，避免造出指向不存在主体的 0 号引用。"""
    n = as_int(v, 0)
    return n if n else None


def text(v):
    """保持源值原样（含换行/制表符）。COPY 协议不怕，mirror 应当是忠实副本。"""
    return v



def s(v):
    """去掉首尾空白的字符串；源库大量 char 字段带尾随空格。"""
    return v.strip() if isinstance(v, str) else v


# ---------------------------------------------------------------- 表定义
# 每个 spec：
#   target   目标表
#   columns  COPY 的列清单（生成列必须排除）
#   sources  一个或多个 (select, transform) —— charge_lines 由两张源表合成
#   dedupe   可选，按该列位置去重，防源库主键不唯一导致整批失败
TABLES = {

    # ------------------------------------------------------------------
    "companies": {
        "target": "mirror.companies",
        "columns": ["company_id", "short_name", "full_name", "city", "state", "country",
                    "irs_no", "sman_id", "credit_limit", "terms_days",
                    "inactive", "credit_hold", "account_no"],
        "source_count": "SELECT COUNT(*) FROM T_COMPANY",
        "sources": [(
            """
            SELECT F_ID, F_SName, F_FName, F_City, F_State, F_Country,
                   F_IRSNo, F_SManID, F_CreditLimit, F_Terms,
                   F_InActive, F_CreditHold, F_AccountNo
            FROM T_COMPANY
            """,
            lambda r: (as_int(r[0]), text(r[1]), text(r[2]), s(r[3]), s(r[4]), s(r[5]),
                       s(r[6]), s(r[7]), money(r[8]), as_int(r[9]),
                       flag(r[10]), flag(r[11]), s(r[12])),
        )],
        "dedupe": 0,
    },

    # ------------------------------------------------------------------
    # 业务单。F_U1Date 覆盖 100%，是流程时效唯一可靠的起点
    # （F_PickupDate 在源库 0 条，F_LastFreeday 仅 12.3%）。
    "shipments": {
        "target": "mirror.shipments",
        "columns": ["shipment_id", "hbl_no", "master_id", "customer_id", "invoice_to_id",
                    "operator", "sman_id", "eta", "last_free_day", "pickup_date",
                    "avail_date", "release_date", "notice_date", "close_date",
                    "created_at", "updated_at", "created_by", "updated_by",
                    "file_closed", "isf_no", "custom_status", "fda_hold"],
        "source_count": "SELECT COUNT(*) FROM T_OIHMAIN",
        "sources": [(
            """
            SELECT F_ID, F_HBLNo, F_OIMBLID, F_Customer, F_INVOICETO,
                   F_Operator, F_SManID, F_FETA, F_LastFreeday, F_PickupDate,
                   F_AvialDate, F_RLSDate, F_NOTICEDATE, F_CloseDate,
                   F_U1Date, F_U2Date, F_U1ID, F_U2ID,
                   F_FileClosed, F_ISFNO, F_CustomStatus, F_FDAHold
            FROM T_OIHMAIN
            """,
            lambda r: (as_int(r[0]), s(r[1]), opt_int(r[2]), opt_int(r[3]), opt_int(r[4]),
                       s(r[5]), s(r[6]), as_date(r[7]), as_date(r[8]), as_date(r[9]),
                       as_date(r[10]), as_date(r[11]), as_date(r[12]), as_date(r[13]),
                       as_ts(r[14]), as_ts(r[15]), s(r[16]), s(r[17]),
                       s(r[18]), s(r[19]), s(r[20]), s(r[21])),
        )],
        "dedupe": 0,
    },

    # ------------------------------------------------------------------
    "containers": {
        "target": "mirror.containers",
        "columns": ["container_row_id", "master_id", "container_no", "container_type",
                    "last_free_day", "pickup_date", "out_date", "in_date",
                    "empty_return", "ata", "carrier_release", "customs_release"],
        "source_count": "SELECT COUNT(*) FROM T_OIMCONTAINER",
        "sources": [(
            """
            SELECT F_ID, F_OIMBLID, F_ContainerNo, F_ConType,
                   F_LastFreeDay, F_PUDATE, F_OutDate, F_Indate,
                   F_EmptyReturn, F_ATA, F_CarrierRLS, F_CustomRLS
            FROM T_OIMCONTAINER
            """,
            lambda r: (as_int(r[0]), opt_int(r[1]), s(r[2]), s(r[3]),
                       as_date(r[4]), as_date(r[5]), as_date(r[6]), as_date(r[7]),
                       as_date(r[8]), as_date(r[9]), as_date(r[10]), as_date(r[11])),
        )],
        "dedupe": 0,
    },

    # ------------------------------------------------------------------
    # 不过滤作废单：mirror 是忠实副本，口径判断留给 mart 层。
    # 否则「这张单系统里有、报表里没有」会变成无法排查的问题。
    "invoices": {
        "target": "mirror.invoices",
        "columns": ["invoice_id", "invoice_no", "bill_to_id", "invoice_date", "due_date",
                    "terms_days", "invoice_amt", "paid_amt", "duty_amt", "duty_paid_amt",
                    "paid_date", "src_table", "src_id", "is_credit", "void_flag",
                    "created_at", "created_by"],
        "source_count": "SELECT COUNT(*) FROM T_INVOHD",
        "sources": [(
            """
            SELECT F_ID, F_InvoiceNo, F_BillTo, F_InvoiceDate, F_DueDate,
                   F_Terms, F_InvoiceAmt, F_PaidAmt, F_DutyAmt, F_DutyPaidAmt,
                   F_PaidDate, F_TBName, F_TBID, F_IsCredit, F_Void,
                   F_U1Date, F_U1ID
            FROM T_INVOHD
            """,
            lambda r: (as_int(r[0]), s(r[1]), opt_int(r[2]), as_date(r[3]), as_date(r[4]),
                       as_int(r[5]), money(r[6]), money(r[7]), money(r[8]), money(r[9]),
                       as_date(r[10]), s(r[11]), opt_int(r[12]), as_int(r[13]), as_int(r[14]),
                       as_ts(r[15]), s(r[16])),
        )],
        "dedupe": 0,
    },

    # ------------------------------------------------------------------
    # 应付单头。invoice_no 是重复付款检测的唯一锚点——
    # 不能用金额匹配：某提单 31 个箱的按箱拖车费会有 19 笔同额记录，
    # 发票号各不相同，那是正常计费。
    "ap_vouchers": {
        "target": "mirror.ap_vouchers",
        "columns": ["voucher_id", "invoice_no", "pay_to_id", "invoice_date", "due_date",
                    "invoice_amt", "paid_amt", "paid_date", "src_table", "src_id",
                    "void_flag", "approved", "approved_by", "created_at", "created_by"],
        "source_count": "SELECT COUNT(*) FROM T_APHD",
        "sources": [(
            """
            SELECT F_ID, F_InvoiceNo, F_PayTo, F_InvoiceDate, F_DueDate,
                   F_InvoiceAmt, F_PaidAmt, F_PaidDate, F_TBName, F_TBID,
                   F_Void, F_Approved, F_ApprovedUser, F_U1Date, F_U1ID
            FROM T_APHD
            """,
            lambda r: (as_int(r[0]), s(r[1]), opt_int(r[2]), as_date(r[3]), as_date(r[4]),
                       money(r[5]), money(r[6]), as_date(r[7]), s(r[8]), opt_int(r[9]),
                       as_int(r[10]), s(r[11]), s(r[12]), as_ts(r[13]), s(r[14])),
        )],
        "dedupe": 0,
    },

    # ------------------------------------------------------------------
    # 现行费用代码体系。不要用 T_CODECHARGE——那是已废弃的短码表，
    # 明细里在用的 377 个代码命中它 0 个，命中 T_NCODECHARGE 全部 377 个。
    "charge_codes": {
        "target": "mirror.charge_codes",
        "columns": ["code", "code_id", "description", "local_desc", "inactive",
                    "use_in_invoice", "use_in_bill",
                    "mod_oi", "mod_oo", "mod_ai", "mod_ao", "mod_wh", "mod_ot"],
        "source_count": "SELECT COUNT(*) FROM T_NCODECHARGE",
        "sources": [(
            """
            SELECT F_Code, F_ID, F_Description, F_LocalDesc, F_InActive,
                   F_IsUseInInvoice, F_IsUseInBill,
                   F_OI, F_OO, F_AI, F_AO, F_WH, F_OT
            FROM T_NCODECHARGE
            WHERE F_Code IS NOT NULL AND LTRIM(RTRIM(F_Code)) <> ''
            """,
            lambda r: (s(r[0]), as_int(r[1]), text(r[2]), text(r[3]), flag(r[4]),
                       flag(r[5]), flag(r[6]),
                       s(r[7]), s(r[8]), s(r[9]), s(r[10]), s(r[11]), s(r[12])),
        )],
        "dedupe": 0,
    },

    # ------------------------------------------------------------------
    # 核心事实表：应收与应付明细合并成一张，用 direction 区分。
    # 滞期归因、成本未转嫁、单票盈利全部在这张表上聚合。
    # line_id 是生成列，不在 columns 里。
    "charge_lines": {
        "target": "mirror.charge_lines",
        "columns": ["direction", "src_line_id", "header_id", "counterparty_id",
                    "billing_code", "description", "amount", "qty", "rate", "currency",
                    "post_date", "doc_date", "src_table", "src_id", "void_flag"],
        "source_count": ("SELECT (SELECT COUNT(*) FROM T_INVODETAIL d JOIN T_INVOHD h ON h.F_ID=d.F_INVOHDID)"
                         "     + (SELECT COUNT(*) FROM T_APDETAIL  d JOIN T_APHD  h ON h.F_ID=d.F_APHDID)"),
        "sources": [
            (
                # 应收明细。T_INVODETAIL 没有自己的 PostDate，取单头的。
                """
                SELECT d.F_ID, d.F_INVOHDID, h.F_BillTo, d.F_BillingCode, d.F_Description,
                       d.F_Amount, d.F_Qty, d.F_Rate, d.F_Cur,
                       h.F_PostDate, h.F_InvoiceDate, h.F_TBName, h.F_TBID, h.F_Void
                FROM T_INVODETAIL d JOIN T_INVOHD h ON h.F_ID = d.F_INVOHDID
                """,
                lambda r: ("ar", as_int(r[0]), as_int(r[1]), opt_int(r[2]), s(r[3]), text(r[4]),
                           money(r[5]), num(r[6]), num(r[7]), s(r[8]),
                           as_date(r[9]), as_date(r[10]), s(r[11]), opt_int(r[12]), as_int(r[13])),
            ),
            (
                # 应付明细。T_APDETAIL 自带 F_PostDate。
                """
                SELECT d.F_ID, d.F_APHDID, h.F_PayTo, d.F_BillingCode, d.F_Description,
                       d.F_Amount, d.F_Qty, d.F_Rate, d.F_Cur,
                       d.F_PostDate, h.F_InvoiceDate, h.F_TBName, h.F_TBID, h.F_Void
                FROM T_APDETAIL d JOIN T_APHD h ON h.F_ID = d.F_APHDID
                """,
                lambda r: ("ap", as_int(r[0]), as_int(r[1]), opt_int(r[2]), s(r[3]), text(r[4]),
                           money(r[5]), num(r[6]), num(r[7]), s(r[8]),
                           as_date(r[9]), as_date(r[10]), s(r[11]), opt_int(r[12]), as_int(r[13])),
            ),
        ],
        # (direction, src_line_id) 决定生成列 line_id，重复会违反主键
        "dedupe": (0, 1),
    },

    # ------------------------------------------------------------------
    # 与海外代理/关联公司的贷项借项对账单（023 纳入）。
    # 这是多数提单真正的收支载体：近两年 94% 的提单有 CR/DB，只有 42% 有应收发票。
    # 不过滤作废单，与其它镜像表一致——口径判断留给 mart 层。
    "crdb_notes": {
        "target": "mirror.crdb_notes",
        "columns": ["note_id", "crdb_no", "src_table", "src_id", "agent_id",
                    "invoice_date", "due_date", "post_date", "paid_date", "terms_days",
                    "total_amt", "paid_amt", "profit_share", "settled", "currency",
                    "void_flag", "created_at", "created_by", "updated_at", "updated_by"],
        "source_count": "SELECT COUNT(*) FROM T_CRDBHD",
        "sources": [(
            """
            SELECT F_ID, F_CrDbNo, F_TBName, F_TBID, F_Agent,
                   F_InvoiceDate, F_DueDate, F_PostDate, F_PaidDate, F_Terms,
                   F_Total, F_PaidAmt, F_ProfitShare, F_Settled, F_Currency,
                   F_Void, F_U1Date, F_U1ID, F_U2Date, F_U2ID
            FROM T_CRDBHD
            """,
            lambda r: (as_int(r[0]), s(r[1]), s(r[2]), opt_int(r[3]), opt_int(r[4]),
                       as_date(r[5]), as_date(r[6]), as_date(r[7]), as_date(r[8]), as_int(r[9]),
                       money(r[10]), money(r[11]), money(r[12]), s(r[13]), s(r[14]),
                       as_int(r[15]), as_ts(r[16]), s(r[17]), as_ts(r[18]), s(r[19])),
        )],
        "dedupe": 0,
    },

    # ------------------------------------------------------------------
    # 对账单明细。debit=代理欠我们（成本经代理收回），credit=我们欠代理。
    # billing_code 与 charge_lines 同一套编码，可直接接 ref.charge_class。
    "crdb_lines": {
        "target": "mirror.crdb_lines",
        "columns": ["line_id", "note_id", "billing_code", "description",
                    "debit", "credit", "revenue", "cost", "rate", "qty",
                    "profit_share", "src_table", "src_id", "currency", "seq"],
        "source_count": "SELECT COUNT(*) FROM T_CRDBDETAIL",
        "sources": [(
            """
            SELECT F_ID, F_CrDbHDID, F_CRDBCODE, F_Description,
                   F_Debit, F_Credit, F_Revenue, F_Cost, F_Rate, F_Qty,
                   F_PShare, F_STBName, F_STBID, F_CUR, F_Seq
            FROM T_CRDBDETAIL
            """,
            lambda r: (as_int(r[0]), as_int(r[1]), s(r[2]), text(r[3]),
                       money(r[4]), money(r[5]), money(r[6]), money(r[7]), num(r[8]), num(r[9]),
                       s(r[10]), s(r[11]), opt_int(r[12]), s(r[13]), opt_int(r[14])),
        )],
        "dedupe": 0,
    },

}

LOAD_ORDER = ["companies", "charge_codes", "shipments", "containers",
              "invoices", "ap_vouchers", "charge_lines", "crdb_notes", "crdb_lines"]


# ---------------------------------------------------------------- 连接
def mssql_connect(ms):
    return pymssql.connect(
        server=ms["host"],
        port=ms["port"],
        user=ms["user"],
        password=ms["password"],
        database=ms["database"],
        charset="UTF-8",          # 否则 FreeTDS 按 ISO-8859-1 返回，
        login_timeout=15,         # 客户名里的 ’ – ö 会变成非法字节
        timeout=1800,
    )


def _cursor(ms_conn):
    cur = ms_conn.cursor()
    # 只读隔离级别：不对生产 OLTP 加共享锁，分析查询不阻塞业务
    cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED")
    return cur


def source_rows(ms_conn, spec):
    """流式读取该 spec 的全部源表，逐行产出已转换的元组。"""
    seen = set() if spec.get("dedupe") is not None else None
    dk = spec.get("dedupe")
    for select, tf in spec["sources"]:
        cur = _cursor(ms_conn)
        cur.execute(select)
        while True:
            rows = cur.fetchmany(BATCH)
            if not rows:
                break
            for raw in rows:
                row = tf(raw)
                if seen is not None:
                    key = tuple(row[i] for i in dk) if isinstance(dk, tuple) else row[dk]
                    if key in seen:
                        continue
                    seen.add(key)
                yield row
        cur.close()


def source_count(ms_conn, spec):
    cur = _cursor(ms_conn)
    cur.execute(spec["source_count"])
    n = cur.fetchone()[0]
    cur.close()
    return n


# ---------------------------------------------------------------- 刷新
def log_start(log_conn, target):
    with log_conn.cursor() as c:
        c.execute("INSERT INTO mirror.refresh_log (table_name, status) "
                  "VALUES (%s, 'running') RETURNING id", (target,))
        return c.fetchone()[0]


def log_finish(log_conn, log_id, rows, status, err=None):
    with log_conn.cursor() as c:
        c.execute("UPDATE mirror.refresh_log SET finished_at = now(), row_count = %s, "
                  "status = %s, error_text = %s WHERE id = %s",
                  (rows, status, err, log_id))


def refresh(name, spec, ms_conn, pg_dsn, dry_run):
    target = spec["target"]
    cols = ", ".join(spec["columns"])
    t0 = time.time()

    if dry_run:
        n = sum(1 for _ in source_rows(ms_conn, spec))
        print(f"  {target:<22} {n:>9,} 行  {time.time()-t0:6.2f}s  (dry-run，未写入)")
        return n

    # 日志连接独立且 autocommit：主事务回滚时失败记录仍要留下
    log_conn = psycopg.connect(pg_dsn, autocommit=True)
    log_id = log_start(log_conn, target)
    try:
        # 主连接不 autocommit —— TRUNCATE 与 COPY 必须同一事务
        with psycopg.connect(pg_dsn) as pg:
            with pg.cursor() as cur:
                cur.execute(f"TRUNCATE {target}")
                n = 0
                with cur.copy(f"COPY {target} ({cols}) FROM STDIN") as cp:
                    for row in source_rows(ms_conn, spec):
                        cp.write_row(row)
                        n += 1
            # 退出 with 时提交；在此之前读者看到的仍是上一版数据
        log_finish(log_conn, log_id, n, "ok")
        print(f"  {target:<22} {n:>9,} 行  {time.time()-t0:6.2f}s")
        return n
    except Exception as e:
        log_finish(log_conn, log_id, None, "failed", str(e)[:2000])
        print(f"  {target:<22} 失败: {str(e)[:160]}", file=sys.stderr)
        raise
    finally:
        log_conn.close()


def verify(ms_conn, pg_dsn, names):
    print("\n  源库 vs 镜像行数比对")
    print(f"  {'表':<22}{'源库':>11}{'镜像':>11}{'差异':>9}")
    print(f"  {'-'*53}")
    ok = True
    with psycopg.connect(pg_dsn) as pg:
        for name in names:
            spec = TABLES[name]
            src = source_count(ms_conn, spec)
            with pg.cursor() as c:
                c.execute(f"SELECT count(*) FROM {spec['target']}")
                dst = c.fetchone()[0]
            diff = dst - src
            mark = "" if diff == 0 else "  ← 去重或过滤所致，请核对"
            if diff != 0:
                ok = False
            print(f"  {spec['target']:<22}{src:>11,}{dst:>11,}{diff:>9,}{mark}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只读源库并校验转换，不连 Postgres")
    ap.add_argument("--tables", help="只刷新指定表，逗号分隔")
    ap.add_argument("--verify", action="store_true", help="刷新后比对行数")
    ap.add_argument("--show-config", action="store_true",
                    help="打印实际生效的连接配置（密码打码）后退出")
    args = ap.parse_args()

    ms, pg_from_cfg = load_config()
    if args.show_config:
        show_config(ms, pg_from_cfg)
        return

    names = [t.strip() for t in args.tables.split(",")] if args.tables else LOAD_ORDER
    unknown = [n for n in names if n not in TABLES]
    if unknown:
        sys.exit(f"未知表名: {', '.join(unknown)}\n可用: {', '.join(LOAD_ORDER)}")

    pg_dsn = pg_from_cfg
    if not args.dry_run and not pg_dsn:
        sys.exit("缺少 Postgres 连接串：请设置 FS_PG_DSN，"
                 "或在 documents/analytics-db.connection.yaml 的 endpoints.etl 中提供")

    print(f"{'[dry-run] ' if args.dry_run else ''}mirror 刷新开始 —— {len(names)} 张表"
          f"  （源库 {ms['user']}@{ms['host']}）")
    t0 = time.time()
    ms_conn = mssql_connect(ms)
    try:
        total = sum(refresh(n, TABLES[n], ms_conn, pg_dsn, args.dry_run) for n in names)
        print(f"  {'-'*53}\n  合计 {total:,} 行，{time.time()-t0:.2f}s")
        if args.verify and not args.dry_run:
            verify(ms_conn, pg_dsn, names)
    finally:
        ms_conn.close()


if __name__ == "__main__":
    main()
