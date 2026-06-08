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
