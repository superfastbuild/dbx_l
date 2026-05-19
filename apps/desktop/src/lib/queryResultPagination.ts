import type { DatabaseType } from "../types/database.ts";
import { usesFetchFirst } from "./databaseCapabilities.ts";
import { quoteTableIdentifier } from "./tableSelectSql.ts";
import { findStatementAtCursor } from "./sqlStatementSplit.ts";
import { sqlServerStatementForDerivedTable } from "./sqlServerQueryWrapping.ts";

export interface PaginatedQuerySqlResult {
  ok: true;
  sql: string;
}

export interface PaginatedQuerySqlError {
  ok: false;
  reason: "empty" | "multi" | "not_select" | "unsupported";
}

export interface QueryPaginationExecutionPlan {
  sqlToExecute: string;
  pageSql?: string;
  pageLimit?: number;
  pageOffset?: number;
  countSql?: string;
  useAgentResultSession: boolean;
}

const unsupportedPaginationTypes = new Set<DatabaseType | undefined>(["neo4j", "mongodb", "redis", "elasticsearch"]);

export function buildQueryPaginationExecutionPlan({
  sql,
  queryBaseSql,
  databaseType,
  pagination,
  useAgentCursor,
}: {
  sql: string;
  queryBaseSql: string;
  databaseType: DatabaseType | undefined;
  pagination: { limit: number; offset: number; sessionId?: string };
  useAgentCursor: boolean;
}): QueryPaginationExecutionPlan {
  const plan: QueryPaginationExecutionPlan = {
    sqlToExecute: sql,
    useAgentResultSession: false,
  };
  const counted = buildCountQuerySql(queryBaseSql, databaseType);
  if (counted.ok) {
    plan.countSql = counted.sql;
  }

  if (pagination.sessionId) {
    plan.pageLimit = pagination.limit;
    plan.pageOffset = pagination.offset;
    plan.useAgentResultSession = true;
    return plan;
  }

  if (useAgentCursor && pagination.offset === 0) {
    plan.sqlToExecute = queryBaseSql;
    plan.pageLimit = pagination.limit;
    plan.pageOffset = pagination.offset;
    plan.useAgentResultSession = true;
    return plan;
  }

  const paginated = buildPaginatedQuerySql(sql, databaseType, pagination.limit, pagination.offset);
  if (paginated.ok) {
    plan.sqlToExecute = paginated.sql;
    plan.pageSql = paginated.sql;
    plan.pageLimit = pagination.limit;
    plan.pageOffset = pagination.offset;
  }
  return plan;
}

export function buildPaginatedQuerySql(
  originalSql: string,
  databaseType: DatabaseType | undefined,
  limit: number,
  offset: number,
): PaginatedQuerySqlResult | PaginatedQuerySqlError {
  const statement = singleSelectableStatement(originalSql);
  if (!statement.ok) return statement;
  if (unsupportedPaginationTypes.has(databaseType)) return { ok: false, reason: "unsupported" };

  const safeLimit = Math.max(1, Math.floor(limit));
  const safeOffset = Math.max(0, Math.floor(offset));
  const alias = quoteTableIdentifier(databaseType, "dbx_page");
  const wrappedSql = databaseType === "sqlserver" ? sqlServerStatementForDerivedTable(statement.sql) : statement.sql;
  const base = `SELECT * FROM (${wrappedSql}) ${alias}`;

  if (databaseType === "sqlserver") {
    if (safeOffset > 0) return { ok: false, reason: "unsupported" };
    return {
      ok: true,
      sql: `SELECT TOP (${safeLimit}) * FROM (${wrappedSql}) ${alias}`,
    };
  }

  if (usesFetchFirst(databaseType)) {
    const offsetSql = safeOffset ? ` OFFSET ${safeOffset} ROWS` : "";
    return { ok: true, sql: `${base}${offsetSql} FETCH FIRST ${safeLimit} ROWS ONLY` };
  }

  const offsetSql = safeOffset ? ` OFFSET ${safeOffset}` : "";
  return { ok: true, sql: `${base} LIMIT ${safeLimit}${offsetSql};` };
}

export function buildCountQuerySql(
  originalSql: string,
  databaseType: DatabaseType | undefined,
): PaginatedQuerySqlResult | PaginatedQuerySqlError {
  const statement = singleSelectableStatement(originalSql);
  if (!statement.ok) return statement;
  if (unsupportedPaginationTypes.has(databaseType)) return { ok: false, reason: "unsupported" };

  const alias = quoteTableIdentifier(databaseType, "dbx_count");
  const wrappedSql = databaseType === "sqlserver" ? sqlServerStatementForDerivedTable(statement.sql) : statement.sql;
  return { ok: true, sql: `SELECT COUNT(*) AS dbx_total_rows FROM (${wrappedSql}) ${alias};` };
}

function singleSelectableStatement(
  originalSql: string,
): { ok: true; sql: string } | Pick<PaginatedQuerySqlError, "ok" | "reason"> {
  const baseSql = originalSql.trim();
  if (!baseSql) return { ok: false, reason: "empty" };

  const statement = findStatementAtCursor(baseSql, 0)
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
  if (!statement) return { ok: false, reason: "empty" };
  if (statement.length !== baseSql.replace(/;+\s*$/, "").trim().length) {
    return { ok: false, reason: "multi" };
  }
  if (!/^\s*(SELECT|WITH)\b/i.test(statement)) {
    return { ok: false, reason: "not_select" };
  }
  if (hasTopLevelSelectInto(statement)) {
    return { ok: false, reason: "not_select" };
  }

  return { ok: true, sql: statement };
}

function hasTopLevelSelectInto(sql: string): boolean {
  let sawSelect = false;
  for (const token of topLevelSqlTokens(sql)) {
    if (!sawSelect) {
      sawSelect = token === "SELECT";
      continue;
    }
    if (token === "INTO") return true;
  }
  return false;
}

function topLevelSqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let depth = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, sql.length);
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipSqlQuoted(sql, i, ch);
      continue;
    }

    if (ch === "[") {
      i = skipSqlBracketIdentifier(sql, i);
      continue;
    }

    if (ch === "(") {
      depth++;
      i++;
      continue;
    }

    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }

    if (depth === 0 && isSqlTokenStart(ch)) {
      const start = i;
      i++;
      while (i < sql.length && isSqlTokenPart(sql[i])) i++;
      tokens.push(sql.slice(start, i).toUpperCase());
      continue;
    }

    i++;
  }

  return tokens;
}

function skipSqlQuoted(sql: string, pos: number, quote: string): number {
  let i = pos + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (quote === "'" && sql[i] === "\\") {
      i += 2;
      continue;
    }
    i++;
  }
  return sql.length;
}

function skipSqlBracketIdentifier(sql: string, pos: number): number {
  let i = pos + 1;
  while (i < sql.length) {
    if (sql[i] === "]") {
      if (sql[i + 1] === "]") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

function isSqlTokenStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isSqlTokenPart(ch: string): boolean {
  return /[A-Za-z0-9_$#]/.test(ch);
}
