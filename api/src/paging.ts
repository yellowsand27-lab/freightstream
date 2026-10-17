/**
 * ProTable 分页 / 排序参数解析。
 * 排序列必须在白名单里——列名会拼进 SQL，绝不能直接信任客户端。
 */
export interface PageQuery {
  page?: string;
  pageSize?: string;
  sort?: string;
  order?: string;
}

export interface Paging {
  limit: number;
  offset: number;
  orderBy: string;
}

export function paging(qs: PageQuery, allowed: readonly string[], defaultSort: string): Paging {
  const page = Math.max(1, Number(qs.page ?? 1) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(qs.pageSize ?? 50) || 50));
  const col = qs.sort && allowed.includes(qs.sort) ? qs.sort : defaultSort;
  const dir = qs.order === "asc" ? "ASC" : "DESC";
  return { limit: pageSize, offset: (page - 1) * pageSize, orderBy: `${col} ${dir} NULLS LAST` };
}
