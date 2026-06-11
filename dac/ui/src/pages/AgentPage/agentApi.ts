/*
 * Copyright (C) 2017-2019 Dremio Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Dremio REST API helpers for the AI Agent.
 *
 * Auth strategy (in priority order):
 *  1. Dremio's internal ApiContext (if available) – includes CSRF / auth headers
 *  2. dremio.localStorageToken from localStorage  (set by Dremio login flow)
 *  3. Auto-login with hardcoded credentials (dremio1 / dremio11)
 *  4. Cookie-based session (browser handles automatically)
 */

// @ts-ignore
import { getApiContext } from "dremio-ui-common/contexts/ApiContext.js";

// ── Auto-login ────────────────────────────────────────────────────────────────

const AGENT_USER = "dremio1";
const AGENT_PASS = "dremio11";
const AGENT_BACKEND = "http://localhost:9047";
const TOKEN_KEY = "_dremio_agent_token";

let _loginPromise: Promise<string | null> | null = null;

async function fetchToken(): Promise<string | null> {
  try {
    const res = await window.fetch(`${AGENT_BACKEND}/apiv2/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userName: AGENT_USER, password: AGENT_PASS }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const token: string = data.token;
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    }
    return token ?? null;
  } catch {
    return null;
  }
}

/** Return a valid Dremio auth token, auto-logging in if needed. */
async function getToken(): Promise<string | null> {
  const cached = localStorage.getItem(TOKEN_KEY);
  if (cached) return cached;

  // Deduplicate concurrent login calls
  if (!_loginPromise) {
    _loginPromise = fetchToken().finally(() => { _loginPromise = null; });
  }
  return _loginPromise;
}

/** Clear cached token (call on 401 to force re-login). */
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type JobStatus =
  | "NOT_SUBMITTED"
  | "STARTING"
  | "RUNNING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "CANCELLATION_REQUESTED"
  | "ENQUEUED"
  | "PLANNING"
  | "PENDING"
  | "METADATA_RETRIEVAL"
  | "QUEUED"
  | "ENGINE_START"
  | "EXECUTION_PLANNING"
  | "INVALID_STATE";

export type JobStatusResponse = {
  id: string;
  /** Dremio v3 API uses "jobState" */
  state: JobStatus;
  jobState?: JobStatus;
  errorMessage?: string;
  rowCount?: number;
};

export type JobResults = {
  rowCount: number;
  schema: { name: string; type: { name: string } }[];
  rows: Record<string, unknown>[];
};

const TERMINAL: JobStatus[] = ["COMPLETED", "CANCELLED", "FAILED"];

// ── Auth-aware fetch ──────────────────────────────────────────────────────────

/** Build headers that include Dremio auth token when available. */
async function buildHeaders(extra: Record<string, string> = {}): Promise<HeadersInit> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };

  // Priority 1: Dremio UI login token from localStorage
  const uiToken =
    localStorage.getItem("dremio.localStorageToken") ??
    localStorage.getItem("_dremio_token") ??
    sessionStorage.getItem("dremio.localStorageToken");

  if (uiToken) {
    headers["Authorization"] = `_dremio${uiToken}`;
    return headers;
  }

  // Priority 2: auto-login token (dremio1 / dremio11)
  const agentToken = await getToken();
  if (agentToken) {
    headers["Authorization"] = `_dremio${agentToken}`;
  }

  return headers;
}

/** Fetch using Dremio ApiContext when available, falling back to direct backend call */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = await buildHeaders(
    (init?.headers as Record<string, string>) ?? {}
  );

  // Try Dremio's internal ApiContext first (proxy path)
  const proxyUrl = `/api/v3/${path}`;
  try {
    const ctx = getApiContext();
    if (ctx?.fetch) {
      return await ctx.fetch(
        new URL(proxyUrl, window.location.origin).toString(),
        { ...init, headers },
      );
    }
  } catch {
    // ApiContext not available – fall through
  }

  // Try proxy (webpack dev server → :9047)
  const proxyRes = await window.fetch(proxyUrl, {
    credentials: "include",
    ...init,
    headers,
  });

  // 401 → clear cached token and retry once with fresh login
  if (proxyRes.status === 401) {
    clearToken();
    const freshToken = await fetchToken();
    const retryHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(freshToken ? { Authorization: `_dremio${freshToken}` } : {}),
    };
    return window.fetch(proxyUrl, {
      credentials: "include",
      ...init,
      headers: retryHeaders,
    });
  }

  return proxyRes;
}

// ── Source / Schema types ─────────────────────────────────────────────────────

export type SourceInfo = {
  name: string;
  type: string;  // POSTGRES, MYSQL, HOME, etc.
};

export type ColumnInfo = {
  name: string;
  type: string;
};

export type TableInfo = {
  schema: string;
  name: string;
  columns: ColumnInfo[];
};

export type SourceSchema = {
  sourceName: string;
  tables: TableInfo[];
};

// ── Source API functions ──────────────────────────────────────────────────────

function quotePath(path: string[]): string {
  return path.map((part) => `"${part}"`).join(".");
}

function byPathUrl(path: string[]): string {
  return `catalog/by-path/${path.map(encodeURIComponent).join("/")}`;
}

/** List all Dremio catalog sources */
export async function listSources(): Promise<SourceInfo[]> {
  try {
    const res = await apiFetch("catalog");
    if (!res.ok) return [];
    const data = await res.json();
    const items: any[] = data.data ?? [];
    return items
      .filter((it: any) => it.containerType === "SOURCE" || it.type === "SOURCE")
      .map((it: any) => ({ name: it.path?.[0] ?? it.name, type: it.datasetType ?? "UNKNOWN" }));
  } catch {
    return [];
  }
}

/** Fetch table list from Dremio Catalog API. This is more reliable for external sources. */
async function fetchCatalogTables(sourceName: string): Promise<TableInfo[]> {
  const tables: TableInfo[] = [];

  async function readCatalogPath(path: string[]) {
    const res = await apiFetch(byPathUrl(path));
    if (!res.ok) return;
    const data = await res.json();
    const children: any[] = data.children ?? [];

    for (const child of children) {
      const childPath: string[] = child.path ?? [];
      if (!childPath.length) continue;

      if (child.type === "DATASET") {
        tables.push({
          schema: childPath.slice(0, -1).join("."),
          name: childPath[childPath.length - 1],
          columns: [],
        });
      } else if (child.containerType === "FOLDER" || child.type === "CONTAINER") {
        await readCatalogPath(childPath);
      }
    }
  }

  await readCatalogPath([sourceName]);
  return tables;
}

/** Fetch a small result set to infer columns for a table path. */
async function inferColumnsFromQuery(path: string[]): Promise<ColumnInfo[]> {
  try {
    const jobId = await submitSql(`SELECT * FROM ${quotePath(path)} LIMIT 1`);
    const job = await waitForJob(jobId);
    if (job.state !== "COMPLETED") return [];
    const result = await fetchJobResults(jobId, 0, 1);
    return result.schema.map((c) => ({ name: c.name, type: c.type.name }));
  } catch {
    return [];
  }
}

/**
 * Fetch table list and column info for a source via INFORMATION_SCHEMA.
 *
 * Dremio's INFORMATION_SCHEMA always uses TABLE_CATALOG = 'DREMIO'.
 * External sources appear as TABLE_SCHEMA = '<sourceName>.<subschema>'
 * (e.g. "bosch_production.public"), while home spaces appear as TABLE_SCHEMA = '@dremio1'.
 */
export async function fetchSourceSchema(sourceName: string): Promise<SourceSchema> {
  const tables: TableInfo[] = [];
  const matchesSource = (tableSchema: string) =>
    sourceName.startsWith("@")
      ? tableSchema === sourceName
      : tableSchema === sourceName || tableSchema.startsWith(`${sourceName}.`);

  try {
    // Step 1: get table list
    const tablesJobId = await submitSql(
      `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA."TABLES"
       WHERE TABLE_CATALOG = 'DREMIO'
         AND TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA','sys')
       ORDER BY TABLE_SCHEMA, TABLE_NAME`
    );
    const tablesJob = await waitForJob(tablesJobId);
    if (tablesJob.state === "COMPLETED") {
      const tablesResult = await fetchJobResults(tablesJobId, 0, 500);

      // Step 2: get column list
      const colsJobId = await submitSql(
        `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
         FROM INFORMATION_SCHEMA."COLUMNS"
         WHERE TABLE_CATALOG = 'DREMIO'
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
      );
      const colsJob = await waitForJob(colsJobId);
      const colsMap: Record<string, ColumnInfo[]> = {};

      if (colsJob.state === "COMPLETED") {
        const colsResult = await fetchJobResults(colsJobId, 0, 2000);
        for (const row of colsResult.rows) {
          const tableSchema = String(row.TABLE_SCHEMA);
          if (!matchesSource(tableSchema)) continue;
          const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
          if (!colsMap[key]) colsMap[key] = [];
          colsMap[key].push({
            name: String(row.COLUMN_NAME),
            type: String(row.DATA_TYPE),
          });
        }
      }

      for (const row of tablesResult.rows) {
        const tableSchema = String(row.TABLE_SCHEMA);
        if (!matchesSource(tableSchema)) continue;
        const name = String(row.TABLE_NAME);
        tables.push({
          schema: tableSchema,
          name,
          columns: colsMap[`${tableSchema}.${name}`] ?? [],
        });
      }
    }
  } catch {
    // Partial failure – return what we have
  }

  // Fallback: external sources are reliably visible through Catalog API even
  // when INFORMATION_SCHEMA metadata has not fully refreshed.
  if (tables.length === 0) {
    const catalogTables = await fetchCatalogTables(sourceName);
    for (const table of catalogTables) {
      const path = [...table.schema.split("."), table.name];
      tables.push({
        ...table,
        columns: await inferColumnsFromQuery(path),
      });
    }
  }

  return { sourceName, tables };
}

/**
 * Convert a Dremio TABLE_SCHEMA value to a quoted SQL path prefix.
 *
 * Examples:
 *   "@dremio1"           → `"@dremio1"`
 *   "bosch_production.public" → `"bosch_production"."public"`
 */
function schemaToSqlPrefix(tableSchema: string): string {
  return tableSchema
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
}

// Bosch 스테이션 → (테이블, 대표 컬럼 5개) 정적 매핑
// agentApi에서 schema_context에 주입해 LLM이 올바른 테이블/컬럼을 선택하게 함
const BOSCH_STATION_HINT = `
=== Bosch 생산라인 스테이션-테이블 매핑 (중요) ===
| 스테이션      | 테이블     | 대표 컬럼 (앞 5개)                                                        |
|-------------|----------|--------------------------------------------------------------------------|
| S1~S23      | bosch_l0 | l0_s1_f25, l0_s1_f27, l0_s2_f33, l0_s9_f151, l0_s10_f215              |
| S24~S25     | bosch_l1 | l1_s25_f1852, l1_s25_f1853, l1_s25_f1856, l1_s25_f1859, l1_s25_f1861  |
| S26~S28     | bosch_l2 | l2_s26_f3038, l2_s26_f3042, l2_s27_f3131, l2_s27_f3135, l2_s28_f3224  |
| S29~S49     | bosch_l3 | l3_s29_f3317, l3_s29_f3320, l3_s29_f3323, l3_s32_f3851, l3_s44_f4102  |

규칙:
- S25 관련 쿼리 → 반드시 "bosch_production"."public"."bosch_l1" 테이블 사용
- S26/S27/S28 쿼리 → 반드시 "bosch_production"."public"."bosch_l2" 테이블 사용
- S29 이상 쿼리 → 반드시 "bosch_production"."public"."bosch_l3" 테이블 사용
- 컬럼명 패턴: l<라인번호>_s<스테이션번호>_f<피처번호>
- non-null 필터 필수: WHERE <첫번째_피처컬럼> IS NOT NULL
- 피처 값은 'T1', 'T2' 등 카테고리 코드 (문자열)
`;

/** Format SourceSchema into a compact text block for the LLM system prompt. */
export function formatSchemaForLLM(schema: SourceSchema): string {
  if (!schema.tables.length) return "";
  const lines: string[] = [`=== ${schema.sourceName} 데이터베이스 스키마 ===\n`];
  const MAX_COLUMNS_PER_TABLE = 80;

  const isBosch = schema.sourceName.toLowerCase().includes("bosch");

  for (const t of schema.tables) {
    // bosch_column_meta는 LLM 스키마 컨텍스트에서 제외 (2140행 메타데이터 테이블)
    if (isBosch && t.name === "bosch_column_meta") continue;

    // TABLE_SCHEMA can be "bosch_production.public" or "@dremio1"
    const prefix = schemaToSqlPrefix(t.schema);
    const fullName = `${prefix}."${t.name}"`;
    const shownColumns = t.columns.slice(0, MAX_COLUMNS_PER_TABLE);
    const cols = t.columns.length
      ? [
          ...shownColumns.map((c) => `  - ${c.name} (${c.type})`),
          ...(t.columns.length > MAX_COLUMNS_PER_TABLE
            ? [`  - ... ${t.columns.length - MAX_COLUMNS_PER_TABLE} more columns omitted`]
            : []),
        ].join("\n")
      : "  (컬럼 정보 없음)";
    lines.push(`테이블: ${fullName}\n${cols}\n`);
  }

  lines.push(
    `SQL 규칙:\n` +
    `- 테이블명 형식: 위 스키마의 "테이블: ..." 경로를 그대로 사용\n` +
    `- 기본 LIMIT 100 적용\n` +
    `- 문자열 숫자 컬럼은 CAST 사용 (예: CAST(col AS DOUBLE))\n`
  );

  // bosch_production 접속 시 스테이션 힌트 추가
  if (isBosch) {
    lines.push(BOSCH_STATION_HINT);
  }

  return lines.join("\n");
}

// ── API functions ─────────────────────────────────────────────────────────────

/** Submit a SQL query, returns the new job id. */
export async function submitSql(
  sql: string,
  context: string[] = [],
): Promise<string> {
  const res = await apiFetch("sql", {
    method: "POST",
    body: JSON.stringify({ sql, context }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body.errorMessage ?? `SQL 제출 실패 (HTTP ${res.status})`,
    );
  }
  const data = await res.json();
  return data.id as string;
}

/**
 * Poll until the job reaches a terminal state (max 120 s).
 * onStatus is called on every state change.
 */
export async function waitForJob(
  jobId: string,
  onStatus?: (state: JobStatus) => void,
): Promise<JobStatusResponse> {
  const POLL_MS = 800;
  const MAX_TRIES = 150;

  for (let i = 0; i < MAX_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    const res = await apiFetch(`job/${jobId}`);
    const raw = await res.json();

    // v3 API returns "jobState"; normalise to "state"
    const job: JobStatusResponse = {
      ...raw,
      state: (raw.jobState ?? raw.state) as JobStatus,
    };

    onStatus?.(job.state);
    if (TERMINAL.includes(job.state)) return job;
  }

  throw new Error("쿼리 시간 초과 (120초)");
}

/** Fetch up to `limit` rows of job results. */
export async function fetchJobResults(
  jobId: string,
  offset = 0,
  limit = 200,
): Promise<JobResults> {
  const res = await apiFetch(
    `job/${jobId}/results?offset=${offset}&limit=${limit}`,
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body.errorMessage ?? `결과 조회 실패 (HTTP ${res.status})`,
    );
  }
  return res.json();
}

// ── Insight API ──────────────────────────────────────────────────────────────

export type InsightResponse = {
  type: string;
  response: string;
  model: string;
};

/**
 * Sends query result data to the LLM server's /insight endpoint
 * and returns a human-readable business insight text.
 */
export async function callInsight(
  question: string,
  data: Record<string, unknown>[],
  sql?: string,
  context?: string,
): Promise<InsightResponse> {
  const res = await fetch("/llm/insight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, data, sql, context }),
    signal:
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(90000)
        : undefined,
  });
  if (!res.ok) throw new Error(`인사이트 서버 오류 (${res.status})`);
  return res.json();
}
