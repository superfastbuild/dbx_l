import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCountQuerySql,
  buildPaginatedQuerySql,
  buildQueryPaginationExecutionPlan,
} from "../../apps/desktop/src/lib/queryResultPagination.ts";

test("wraps a single select query with limit and offset", () => {
  const result = buildPaginatedQuerySql("SELECT id, name FROM users;", "postgres", 100, 200);

  assert.deepEqual(result, {
    ok: true,
    sql: 'SELECT * FROM (SELECT id, name FROM users) "dbx_page" LIMIT 100 OFFSET 200;',
  });
});

test("uses MySQL style quoting for paginated query alias", () => {
  const result = buildPaginatedQuerySql("SELECT id FROM users WHERE active = 1", "mysql", 50, 0);

  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT * FROM (SELECT id FROM users WHERE active = 1) `dbx_page` LIMIT 50;",
  });
});

test("uses SQL Server TOP pagination for the first page to support SQL Server 2008", () => {
  const result = buildPaginatedQuerySql("SELECT id FROM users", "sqlserver", 100, 0);

  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT TOP (100) * FROM (SELECT id FROM users) [dbx_page]",
  });
});

test("strips top-level SQL Server order by before wrapping paginated query", () => {
  const result = buildPaginatedQuerySql("SELECT id FROM users ORDER BY id DESC", "sqlserver", 100, 0);

  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT TOP (100) * FROM (SELECT id FROM users) [dbx_page]",
  });
});

test("does not generate SQL Server OFFSET pagination for later query-result pages", () => {
  const result = buildPaginatedQuerySql("SELECT id FROM users", "sqlserver", 100, 300);

  assert.deepEqual(result, {
    ok: false,
    reason: "unsupported",
  });
});

test("does not paginate SQL Server SELECT INTO statements", () => {
  const result = buildPaginatedQuerySql(
    "SELECT * INTO DingTalk_SyncTask FROM YonSuite_SyncTask WHERE 1=2",
    "sqlserver",
    100,
    0,
  );

  assert.deepEqual(result, { ok: false, reason: "not_select" });
});

test("uses fetch first pagination for Oracle first page", () => {
  const result = buildPaginatedQuerySql("SELECT id FROM users", "oracle", 100, 0);

  assert.deepEqual(result, {
    ok: true,
    sql: 'SELECT * FROM (SELECT id FROM users) "dbx_page" FETCH FIRST 100 ROWS ONLY',
  });
});

test("supports CTE select queries", () => {
  const result = buildPaginatedQuerySql("WITH cte AS (SELECT 1 AS id) SELECT * FROM cte", "clickhouse", 100, 0);

  assert.deepEqual(result, {
    ok: true,
    sql: 'SELECT * FROM (WITH cte AS (SELECT 1 AS id) SELECT * FROM cte) "dbx_page" LIMIT 100;',
  });
});

test("rejects multiple statements", () => {
  const result = buildPaginatedQuerySql("SELECT 1; SELECT 2;", "postgres", 100, 0);

  assert.deepEqual(result, { ok: false, reason: "multi" });
});

test("rejects non select statements", () => {
  const result = buildPaginatedQuerySql("UPDATE users SET name = 'A'", "postgres", 100, 0);

  assert.deepEqual(result, { ok: false, reason: "not_select" });
});

test("wraps a single select query for total row count", () => {
  const result = buildCountQuerySql("SELECT id, name FROM users;", "postgres");

  assert.deepEqual(result, {
    ok: true,
    sql: 'SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id, name FROM users) "dbx_count";',
  });
});

test("strips top-level SQL Server order by before wrapping count query", () => {
  const result = buildCountQuerySql("SELECT id FROM users ORDER BY id DESC", "sqlserver");

  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id FROM users) [dbx_count];",
  });
});

test("keeps nested SQL Server order by expressions when wrapping count query", () => {
  const result = buildCountQuerySql(
    "SELECT ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn, id FROM users ORDER BY id DESC",
    "sqlserver",
  );

  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn, id FROM users) [dbx_count];",
  });
});

test("uses MySQL style quoting for count query alias", () => {
  const result = buildCountQuerySql("WITH cte AS (SELECT 1 AS id) SELECT * FROM cte", "mysql");

  assert.deepEqual(result, {
    ok: true,
    sql: "SELECT COUNT(*) AS dbx_total_rows FROM (WITH cte AS (SELECT 1 AS id) SELECT * FROM cte) `dbx_count`;",
  });
});

test("does not build a count query for SELECT INTO statements", () => {
  const result = buildCountQuerySql("SELECT * INTO copy_users FROM users WHERE active = 1", "sqlserver");

  assert.deepEqual(result, { ok: false, reason: "not_select" });
});

test("rejects count query for unsupported database types", () => {
  const result = buildCountQuerySql("SELECT * FROM nodes", "neo4j");

  assert.deepEqual(result, { ok: false, reason: "unsupported" });
});

test("rejects count query for multiple statements", () => {
  const result = buildCountQuerySql("SELECT 1; SELECT 2;", "postgres");

  assert.deepEqual(result, { ok: false, reason: "multi" });
});

test("uses an agent result session for the first jdbc page", () => {
  const plan = buildQueryPaginationExecutionPlan({
    sql: "SELECT * FROM events",
    queryBaseSql: "SELECT * FROM events",
    databaseType: "oracle",
    pagination: { limit: 500, offset: 0 },
    useAgentCursor: true,
  });

  assert.equal(plan.sqlToExecute, "SELECT * FROM events");
  assert.equal(plan.pageLimit, 500);
  assert.equal(plan.pageOffset, 0);
  assert.equal(plan.pageSql, undefined);
  assert.equal(plan.useAgentResultSession, true);
});

test("keeps using an agent result session for sequential jdbc pages", () => {
  const plan = buildQueryPaginationExecutionPlan({
    sql: "SELECT * FROM events",
    queryBaseSql: "SELECT * FROM events",
    databaseType: "oracle",
    pagination: { limit: 500, offset: 500, sessionId: "session-1" },
    useAgentCursor: true,
  });

  assert.equal(plan.sqlToExecute, "SELECT * FROM events");
  assert.equal(plan.pageLimit, 500);
  assert.equal(plan.pageOffset, 500);
  assert.equal(plan.useAgentResultSession, true);
});

test("uses SQL pagination instead of jdbc cursor for random agent page jumps", () => {
  const plan = buildQueryPaginationExecutionPlan({
    sql: "SELECT * FROM events",
    queryBaseSql: "SELECT * FROM events",
    databaseType: "oracle",
    pagination: { limit: 500, offset: 1500 },
    useAgentCursor: true,
  });

  assert.equal(
    plan.sqlToExecute,
    'SELECT * FROM (SELECT * FROM events) "dbx_page" OFFSET 1500 ROWS FETCH FIRST 500 ROWS ONLY',
  );
  assert.equal(plan.pageSql, plan.sqlToExecute);
  assert.equal(plan.pageLimit, 500);
  assert.equal(plan.pageOffset, 1500);
  assert.equal(plan.useAgentResultSession, false);
});

test("executes SELECT INTO without pagination or count wrapping", () => {
  const sql = "SELECT * INTO DingTalk_SyncTask FROM YonSuite_SyncTask WHERE 1=2";
  const plan = buildQueryPaginationExecutionPlan({
    sql,
    queryBaseSql: sql,
    databaseType: "sqlserver",
    pagination: { limit: 500, offset: 0 },
    useAgentCursor: false,
  });

  assert.equal(plan.sqlToExecute, sql);
  assert.equal(plan.pageSql, undefined);
  assert.equal(plan.countSql, undefined);
  assert.equal(plan.pageLimit, undefined);
  assert.equal(plan.pageOffset, undefined);
});
