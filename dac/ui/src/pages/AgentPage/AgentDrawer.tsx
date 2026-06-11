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
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { submitSql, waitForJob, fetchJobResults, fetchSourceSchema, formatSchemaForLLM, listSources, callInsight } from "./agentApi";
import type { JobResults, JobStatus, SourceSchema, SourceInfo } from "./agentApi";
import { naturalLanguageToSql } from "./nlToSql";
import { SmartChart } from "./SmartChart";
import "./AgentDrawer.less";

// ── LLM ───────────────────────────────────────────────────────────────────────

// Use the webpack dev-server proxy instead of calling :8765 directly.
// Direct browser calls can fail when the UI is opened through a non-localhost host.
const LLM_BASE = "/llm";

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

type LlmResponse = {
  type: string;
  sql?: string;
  explanation?: string;
  response: string;
  model: string;
};

/** LLM server availability level */
type LlmMode = "qwen" | "server-rules" | "offline";

async function callLLM(
  query: string,
  history: { role: string; content: string }[] = [],
  schemaContext?: string,
): Promise<LlmResponse> {
  const res = await fetch(`${LLM_BASE}/nl2sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, history, schema_context: schemaContext }),
    signal: timeoutSignal(120000),
  });
  if (!res.ok) throw new Error(`LLM 서버 오류 (${res.status})`);
  return res.json();
}

type LlmHealthResult = { mode: LlmMode; model: string | null };

async function checkLLMHealth(): Promise<LlmHealthResult> {
  try {
    const res = await fetch(`${LLM_BASE}/health`, {
      signal: timeoutSignal(4000),
    });
    if (!res.ok) return { mode: "offline", model: null };
    const data = await res.json();
    const model: string | null = data.model ?? null;
    if (data.ollama === true && data.model_ready === true) return { mode: "qwen", model };
    if (data.status === "degraded" || data.fallback === "rule-based") return { mode: "server-rules", model };
    return { mode: "offline", model: null };
  } catch {
    return { mode: "offline", model: null };
  }
}

/** "qwen3.5:9b" → "Qwen3.5:9b" */
function formatModelName(model: string | null): string {
  if (!model) return "LLM";
  return model.charAt(0).toUpperCase() + model.slice(1);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type MessageRole = "user" | "agent" | "system";

/** Phase of a single agent turn */
type AgentPhase =
  | "thinking"   // intent detection
  | "generating" // building SQL
  | "running"    // executing SQL
  | "done"
  | "error"
  | "chat";      // non-SQL conversation

/** A single analysis recommendation card */
type Suggestion = {
  title: string;
  description: string;
  difficulty: 1 | 2 | 3;          // 1=Basic  2=Intermediate  3=Advanced
  sql: string;
  insight: string;                 // expected insight hint
};

type Message = {
  id: number;
  role: MessageRole;
  text: string;
  phase?: AgentPhase;
  jobStatus?: JobStatus;
  sql?: string;
  result?: JobResults;
  error?: string;
  suggestions?: Suggestion[];      // analysis recommendation cards
};

/** One entry per user input in the sidebar history */
type HistoryItem = {
  id: number;
  text: string;       // the user's question
  ts: number;         // ms timestamp
};

const HISTORY_KEY = "dremio-agent-history-v1";
const MAX_HISTORY = 20;
const ERROR_LOG_KEY = "dremio-agent-error-log-v1";
const MAX_ERROR_LOGS = 50;

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(list: HistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {}
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

function safeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return { unserializable: true };
  }
}

function logAgentError(
  context: string,
  err: unknown,
  details?: Record<string, unknown>,
): void {
  const entry = {
    ts: new Date().toISOString(),
    context,
    message: errorMessage(err),
    stack: errorStack(err),
    details: safeDetails(details),
  };

  // Keep a visible trace for developers and a short persistent history for users.
  // The localStorage key can be inspected from DevTools when diagnosing UI issues.
  // eslint-disable-next-line no-console
  console.error("[AI Agent Error]", entry);

  try {
    const prev = JSON.parse(localStorage.getItem(ERROR_LOG_KEY) ?? "[]");
    const next = [entry, ...(Array.isArray(prev) ? prev : [])].slice(0, MAX_ERROR_LOGS);
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(next));
  } catch {
    // Logging must never break the chat flow.
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return new Date(ts).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

/** Group history items by relative date */
function groupByDate(
  list: HistoryItem[],
): { label: string; items: HistoryItem[] }[] {
  const now = Date.now();
  const DAY = 86_400_000;
  const t0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();

  const buckets: Record<string, HistoryItem[]> = {
    "오늘": [], "어제": [], "이번 주": [], "이번 달": [], "이전": [],
  };

  for (const item of list) {
    const age = now - item.ts;
    if (item.ts >= t0)             buckets["오늘"].push(item);
    else if (item.ts >= t0 - DAY) buckets["어제"].push(item);
    else if (age < 7  * DAY)      buckets["이번 주"].push(item);
    else if (age < 30 * DAY)      buckets["이번 달"].push(item);
    else                          buckets["이전"].push(item);
  }

  return (Object.entries(buckets) as [string, HistoryItem[]][])
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _mid = 1000;
const nextId = () => ++_mid;

const JOB_STATUS_LABEL: Partial<Record<JobStatus, string>> = {
  PLANNING: "쿼리 계획 중...",
  RUNNING: "쿼리 실행 중...",
  STARTING: "시작 중...",
  QUEUED: "대기 중...",
  ENQUEUED: "대기 중...",
  METADATA_RETRIEVAL: "메타데이터 로드 중...",
  EXECUTION_PLANNING: "실행 계획 수립 중...",
  COMPLETED: "완료",
};

// ── Analysis recommendation data ──────────────────────────────────────────────

const H = '"@dremio1"';

// ── Insight intent helpers ────────────────────────────────────────────────────

type InsightTarget = {
  label: string;
  sql: string;
  context: string;
};

/**
 * Detects when the user is asking for interpretation/insights from data
 * (not a SQL query request, but a "what does this mean?" question).
 * Returns an InsightTarget if matched, null otherwise.
 */
function detectInsightIntent(text: string): InsightTarget | null {
  const lo = text.toLowerCase().trim();
  const isInsightQ =
    /(인사이트|통찰|시사점|의미|해석|알\s*수\s*있|뭘\s*알|무엇\s*을\s*알|결론|시사|내포|함의)/.test(lo) ||
    /(어떻게\s*(해석|이해|봐야|볼\s*수)|분석\s*(결과|내용)\s*(에서|으로|를))/.test(lo) ||
    /insight|implication|takeaway|conclusion/.test(lo);

  if (!isInsightQ) return null;

  // Map to the most relevant SQL
  // Note: "time" is a SQL reserved word in Dremio — always use "time" with double quotes.
  //       Date extraction: SUBSTRING("time", 1, 10) for date, SUBSTRING("time", 1, 7) for month.
  // 코호트 / 리텐션
  if (/(코호트|cohort|리텐션|retention|재방문|재구매\s*패턴|재활성)/.test(lo)) {
    return {
      label: "코호트 분석 (첫 이벤트 월 × 구매 월)",
      sql: `WITH first_event AS (
  SELECT user_id, MIN(SUBSTRING("time", 1, 7)) AS cohort_month
  FROM ${H}.commerce_data
  GROUP BY user_id
),
monthly_purchase AS (
  SELECT user_id, SUBSTRING("time", 1, 7) AS activity_month
  FROM ${H}.commerce_data
  WHERE event_name = 'purchase'
  GROUP BY user_id, SUBSTRING("time", 1, 7)
)
SELECT
  f.cohort_month,
  m.activity_month,
  COUNT(DISTINCT m.user_id) AS returning_buyers,
  COUNT(DISTINCT f.user_id) AS cohort_size
FROM first_event f
JOIN monthly_purchase m ON f.user_id = m.user_id
GROUP BY f.cohort_month, m.activity_month
ORDER BY f.cohort_month, m.activity_month`,
      context: "commerce_data 코호트 분석 — 첫 이벤트 월별 유저 그룹이 이후 월에 구매를 얼마나 유지하는지 측정",
    };
  }

  // 시계열 추이: 이커머스 언급 없어도 "시계열 분석" 등으로 매칭
  if (/(시계열|추이|트렌드|trend|일별|날짜별|time.*series)/.test(lo)) {
    return {
      label: "이커머스 일별 시계열 추이",
      sql: `SELECT SUBSTRING("time", 1, 10) AS event_date, COUNT(*) AS total_events, SUM(CASE WHEN event_name='view' THEN 1 ELSE 0 END) AS views, SUM(CASE WHEN event_name='cart' THEN 1 ELSE 0 END) AS carts, SUM(CASE WHEN event_name='purchase' THEN 1 ELSE 0 END) AS purchases FROM ${H}.commerce_data GROUP BY SUBSTRING("time", 1, 10) ORDER BY event_date`,
      context: "commerce_data 일별 이벤트 추이 (시계열)",
    };
  }
  // 세그멘테이션: "세그먼테이션"(먼) / "세그멘테이션"(멘) 둘 다 지원, 이커머스 언급 없어도 매칭
  if (/(세그먼테이션|세그멘테이션|세그먼트|segmentation|segment|사용자\s*분류|고객\s*분류|구매\s*빈도)/.test(lo)) {
    return {
      label: "사용자 구매 빈도 세그멘테이션",
      sql: `WITH user_stats AS (SELECT user_id, COUNT(*) AS total_events, SUM(CASE WHEN event_name='purchase' THEN 1 ELSE 0 END) AS purchase_cnt FROM ${H}.commerce_data GROUP BY user_id) SELECT CASE WHEN purchase_cnt=0 THEN 'no_purchase' WHEN purchase_cnt=1 THEN 'one_time' WHEN purchase_cnt<=5 THEN 'occasional' ELSE 'frequent' END AS segment, COUNT(*) AS user_cnt, ROUND(AVG(total_events),1) AS avg_events_per_user FROM user_stats GROUP BY CASE WHEN purchase_cnt=0 THEN 'no_purchase' WHEN purchase_cnt=1 THEN 'one_time' WHEN purchase_cnt<=5 THEN 'occasional' ELSE 'frequent' END ORDER BY user_cnt DESC`,
      context: "commerce_data 사용자 구매 빈도 세그멘테이션",
    };
  }
  if (/(가격대|price.*segment|price.*range)/.test(lo)) {
    return {
      label: "가격대별 구매 세그멘테이션",
      sql: `SELECT CASE WHEN CAST(price AS DOUBLE)<10 THEN 'under_10' WHEN CAST(price AS DOUBLE)<50 THEN '10_to_50' WHEN CAST(price AS DOUBLE)<200 THEN '50_to_200' ELSE 'over_200' END AS price_segment, COUNT(*) AS event_cnt, SUM(CASE WHEN event_name='purchase' THEN 1 ELSE 0 END) AS purchases, ROUND(AVG(CAST(price AS DOUBLE)),2) AS avg_price FROM ${H}.commerce_data WHERE price IS NOT NULL AND price!='' GROUP BY CASE WHEN CAST(price AS DOUBLE)<10 THEN 'under_10' WHEN CAST(price AS DOUBLE)<50 THEN '10_to_50' WHEN CAST(price AS DOUBLE)<200 THEN '50_to_200' ELSE 'over_200' END ORDER BY purchases DESC`,
      context: "commerce_data 가격대별 구매 세그멘테이션",
    };
  }
  if (/(이커머스|커머스|commerce|이벤트\s*유형|event.*type|유형.*분포)/.test(lo)) {
    return {
      label: "이커머스 이벤트 유형 분포",
      sql: `SELECT event_name, COUNT(*) AS cnt, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) AS pct FROM ${H}.commerce_data GROUP BY event_name ORDER BY cnt DESC`,
      context: "commerce_data 이벤트 유형별 분포 분석",
    };
  }
  if (/(전환율|conversion|cvr|view.*purchase|구매전환)/.test(lo)) {
    return {
      label: "카테고리별 전환율",
      sql: `SELECT category_1, COUNT(CASE WHEN event_name='view' THEN 1 END) AS views, COUNT(CASE WHEN event_name='cart' THEN 1 END) AS carts, COUNT(CASE WHEN event_name='purchase' THEN 1 END) AS purchases, ROUND(COUNT(CASE WHEN event_name='purchase' THEN 1 END)*100.0/NULLIF(COUNT(CASE WHEN event_name='view' THEN 1 END),0),2) AS conversion_rate FROM ${H}.commerce_data WHERE category_1!='Not defined' GROUP BY category_1 ORDER BY conversion_rate DESC LIMIT 20`,
      context: "commerce_data 카테고리별 view→purchase 전환율",
    };
  }
  if (/(장바구니|카트|cart.*이탈|이탈|abandon)/.test(lo)) {
    return {
      label: "장바구니 이탈 분석",
      sql: `SELECT category_1, COUNT(CASE WHEN event_name='cart' THEN 1 END) AS cart_adds, COUNT(CASE WHEN event_name='remove_from_cart' THEN 1 END) AS cart_removes, COUNT(CASE WHEN event_name='purchase' THEN 1 END) AS purchases, ROUND(COUNT(CASE WHEN event_name='remove_from_cart' THEN 1 END)*100.0/NULLIF(COUNT(CASE WHEN event_name='cart' THEN 1 END),0),1) AS abandon_rate_pct FROM ${H}.commerce_data WHERE category_1!='Not defined' GROUP BY category_1 ORDER BY cart_adds DESC LIMIT 15`,
      context: "commerce_data 카테고리별 장바구니 이탈률",
    };
  }
  if (/(브랜드|brand)/.test(lo)) {
    return {
      label: "브랜드별 구매 현황",
      sql: `SELECT brand, COUNT(CASE WHEN event_name='purchase' THEN 1 END) AS purchases, COUNT(*) AS total_events, ROUND(AVG(CAST(price AS DOUBLE)),2) AS avg_price FROM ${H}.commerce_data WHERE brand!='Not defined' GROUP BY brand ORDER BY purchases DESC LIMIT 20`,
      context: "commerce_data 브랜드별 이벤트 및 구매 현황",
    };
  }
  if (/(카테고리|category)/.test(lo)) {
    return {
      label: "카테고리별 이벤트 현황",
      sql: `SELECT category_1, COUNT(*) AS event_cnt, COUNT(DISTINCT user_id) AS unique_users, SUM(CASE WHEN event_name='purchase' THEN 1 ELSE 0 END) AS purchases FROM ${H}.commerce_data WHERE category_1!='Not defined' GROUP BY category_1 ORDER BY event_cnt DESC LIMIT 20`,
      context: "commerce_data 카테고리별 이벤트 및 구매 수",
    };
  }
  if (/(매출|revenue|sales|총.*주문|주문.*현황)/.test(lo)) {
    return {
      label: "주문 상태별 매출 현황",
      sql: `SELECT status, COUNT(*) AS order_count, SUM(CAST(total_amount AS DOUBLE)) AS total_amount, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER(),1) AS pct FROM ${H}.orders GROUP BY status ORDER BY total_amount DESC`,
      context: "orders 테이블 주문 상태별 매출 분포",
    };
  }
  if (/(고객|customer|등급|tier)/.test(lo)) {
    return {
      label: "고객 등급별 구매 패턴",
      sql: `SELECT c.tier, COUNT(DISTINCT c.customer_id) AS customers, COUNT(o.order_id) AS total_orders, ROUND(AVG(CAST(o.total_amount AS DOUBLE)),0) AS avg_order_amount, SUM(CAST(o.total_amount AS DOUBLE)) AS total_revenue FROM ${H}.customers c LEFT JOIN ${H}.orders o ON c.customer_id=o.customer_id AND o.status='Completed' GROUP BY c.tier ORDER BY total_revenue DESC`,
      context: "customers/orders 테이블 등급별 구매 패턴",
    };
  }

  // Generic fallback: run table overview
  return {
    label: "데이터 전체 현황",
    sql: `SELECT 'customers' AS table_name, COUNT(*) AS row_count FROM ${H}.customers UNION ALL SELECT 'products', COUNT(*) FROM ${H}.products UNION ALL SELECT 'orders', COUNT(*) FROM ${H}.orders UNION ALL SELECT 'order_items', COUNT(*) FROM ${H}.order_items UNION ALL SELECT 'commerce_data', COUNT(*) FROM ${H}.commerce_data`,
    context: "전체 테이블 현황",
  };
}

/**
 * Detects "disconnect / logout" intent.
 * Returns true if the user wants to disconnect from current source.
 */
function detectDisconnectIntent(text: string): boolean {
  const lo = text.toLowerCase().trim();
  return (
    /^(접속|연결)\s*(해제|끊기|종료|끊어|닫기|나가기)/.test(lo) ||
    /(접속|연결)\s*(해제|끊|종료)/.test(lo) ||
    /disconnect|logout/.test(lo)
  );
}

/**
 * Detects "connect to source" intent.
 * Returns the source name string, or null if not a connect request.
 * Examples: "factory_db에 접속해", "샘플DB 써", "dremio1 연결해줘"
 */
function detectConnectIntent(text: string): string | null {
  const t = text.trim();
  // Pattern: <source명> + 접속/연결/사용/열어/써 키워드
  const m1 = t.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:에|으로|에\s*)?(?:접속|연결|사용|써|열어)(?:해|줘|해줘|해봐|볼게)?/);
  if (m1) return m1[1];
  // Pattern: 접속해 / 연결해 + <source명>
  const m2 = t.match(/(?:접속|연결)\s*(?:해|할게|하자)?\s*([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (m2) return m2[1];
  // Pattern: <source명> db에 / 데이터베이스에 접속
  const m3 = t.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:db|데이터베이스|database)?\s*(?:에|으로)\s*(?:접속|연결)/);
  if (m3) return m3[1];
  return null;
}

// ── factory_db 전용 분석 추천 카드 ─────────────────────────────────────────────
const S_FACTORY = "factory_db.public";

const FACTORY_DB_ANALYSIS: Suggestion[] = [
  {
    title: "공장별 종합 현황",
    description: "공장(plant)별 생산 라인 수, 설비 수, 가동/유휴/정비 현황을 한눈에 파악합니다.",
    difficulty: 1,
    sql: `SELECT p.plant_name,
  COUNT(DISTINCT pl.line_id) AS line_cnt,
  COUNT(DISTINCT e.equipment_id) AS equip_cnt,
  SUM(CASE WHEN e.status = 'RUNNING'     THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN e.status = 'IDLE'        THEN 1 ELSE 0 END) AS idle,
  SUM(CASE WHEN e.status = 'MAINTENANCE' THEN 1 ELSE 0 END) AS maintenance
FROM ${S_FACTORY}.plants p
JOIN ${S_FACTORY}.production_lines pl ON p.plant_id = pl.plant_id
JOIN ${S_FACTORY}.equipments e ON pl.line_id = e.line_id
GROUP BY p.plant_name
ORDER BY p.plant_name`,
    insight: "MAINTENANCE 설비가 많은 공장은 생산 차질 위험 — 예비 설비 배치 또는 정비 일정 조율 필요",
  },
  {
    title: "설비 가동 상태별 현황",
    description: "설비 유형(CNC / 용접 / 프레스 등)별 가동(RUNNING) · 유휴(IDLE) · 정비(MAINTENANCE) 분포를 분석합니다.",
    difficulty: 1,
    sql: `SELECT equip_type, status, COUNT(*) AS cnt
FROM ${S_FACTORY}.equipments
GROUP BY equip_type, status
ORDER BY equip_type, cnt DESC`,
    insight: "IDLE 설비가 많으면 생산 계획 재조정 또는 가동률 개선 필요; MAINTENANCE는 예방 정비 주기 확인",
  },
  {
    title: "미해결 불량 우선순위 목록",
    description: "아직 조치되지 않은 불량(resolved_at IS NULL)을 심각도(CRITICAL → MAJOR → MINOR) 순으로 표시합니다.",
    difficulty: 2,
    sql: `SELECT dl.defect_id, p.plant_name, pl.line_name, e.equip_name,
  dl.defect_type, dl.severity, dl.defect_qty,
  dl.detected_at, dl.root_cause, dl.is_reworkable
FROM ${S_FACTORY}.defect_logs dl
JOIN ${S_FACTORY}.production_lines pl ON dl.line_id = pl.line_id
JOIN ${S_FACTORY}.plants p ON pl.plant_id = p.plant_id
JOIN ${S_FACTORY}.equipments e ON dl.equipment_id = e.equipment_id
WHERE dl.resolved_at IS NULL
ORDER BY CASE dl.severity WHEN 'CRITICAL' THEN 1 WHEN 'MAJOR' THEN 2 ELSE 3 END,
         dl.detected_at DESC`,
    insight: "CRITICAL + is_reworkable=false 인 항목은 즉시 교체/폐기 대상; root_cause 패턴으로 재발 방지책 수립 필요",
  },
  {
    title: "라인별 불량 심각도 분포",
    description: "생산 라인별로 CRITICAL / MAJOR / MINOR 불량 건수와 총 불량 수량을 집계합니다.",
    difficulty: 2,
    sql: `SELECT pl.line_name, dl.severity,
  COUNT(*) AS defect_cnt,
  SUM(dl.defect_qty) AS total_qty
FROM ${S_FACTORY}.defect_logs dl
JOIN ${S_FACTORY}.production_lines pl ON dl.line_id = pl.line_id
GROUP BY pl.line_name, dl.severity
ORDER BY pl.line_name,
  CASE dl.severity WHEN 'CRITICAL' THEN 1 WHEN 'MAJOR' THEN 2 ELSE 3 END`,
    insight: "CRITICAL 불량이 집중된 라인은 즉시 공정 점검 필요; MINOR 비율이 높으면 공정 파라미터 미세 조정 검토",
  },
  {
    title: "불량 유형별 재작업 가능 비율",
    description: "불량 유형(치수 불량 / 용접 균열 / 외관 불량 등)별 발생 건수와 재작업 가능 여부를 분석합니다.",
    difficulty: 2,
    sql: `SELECT defect_type, severity,
  COUNT(*) AS cnt,
  SUM(defect_qty) AS total_qty,
  SUM(CASE WHEN is_reworkable THEN 1 ELSE 0 END) AS reworkable_cnt,
  ROUND(SUM(CASE WHEN is_reworkable THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS rework_rate
FROM ${S_FACTORY}.defect_logs
GROUP BY defect_type, severity
ORDER BY cnt DESC`,
    insight: "rework_rate 0% + severity CRITICAL 조합은 폐기 비용 직결 — 해당 공정 파라미터 즉시 검토",
  },
  {
    title: "설비별 이상 발생률 (공정 로그 기반)",
    description: "설비별 공정 로그 중 이상(is_anomaly=true) 비율을 계산해 위험 설비를 식별합니다.",
    difficulty: 2,
    sql: `SELECT e.equip_code, e.equip_name, e.equip_type, e.status,
  COUNT(*) AS total_logs,
  SUM(CASE WHEN pl.is_anomaly THEN 1 ELSE 0 END) AS anomaly_cnt,
  ROUND(SUM(CASE WHEN pl.is_anomaly THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS anomaly_rate_pct
FROM ${S_FACTORY}.process_logs pl
JOIN ${S_FACTORY}.equipments e ON pl.equipment_id = e.equipment_id
GROUP BY e.equip_code, e.equip_name, e.equip_type, e.status
ORDER BY anomaly_rate_pct DESC`,
    insight: "anomaly_rate_pct > 20% 설비는 예방 정비 즉시 스케줄링 필요; 정비 이력(last_maint_date)과 비교 검토",
  },
  {
    title: "이상 발생 시 센서값 패턴 분석",
    description: "정상(is_anomaly=false) vs 이상(is_anomaly=true) 상태의 온도·압력·진동·RPM·전력 평균값을 비교합니다.",
    difficulty: 3,
    sql: `SELECT is_anomaly,
  COUNT(*) AS log_cnt,
  ROUND(AVG(temperature), 1) AS avg_temp_c,
  ROUND(AVG(pressure), 2) AS avg_pressure_bar,
  ROUND(AVG(vibration), 3) AS avg_vibration_mm,
  ROUND(AVG(rpm), 0) AS avg_rpm,
  ROUND(AVG(power_kw), 1) AS avg_power_kw,
  ROUND(MAX(temperature), 1) AS max_temp_c,
  ROUND(MAX(vibration), 3) AS max_vibration_mm
FROM ${S_FACTORY}.process_logs
GROUP BY is_anomaly`,
    insight: "이상 시 진동·온도·압력이 급등하는 패턴을 임계값으로 설정하면 실시간 이상 감지 알람 기준으로 활용 가능",
  },
];

/** Returns true when the user is asking for analysis recommendations */
function detectAnalysisIntent(text: string): boolean {
  const lo = text.toLowerCase();
  return (
    /(분석|analysis|analytics)\s*(추천|제안|아이디어|뭐|무엇|어떤|어때|해줘|해봐)/.test(lo) ||
    /(추천|제안)\s*(분석|analysis|쿼리|query)/.test(lo) ||
    /어떤\s*(분석|analysis|insight|인사이트)\s*(을|를|이|가|할)/.test(lo) ||
    /난이도|고급\s*분석|심화\s*분석|어려운\s*분석/.test(lo) ||
    /(뭘|무엇을)\s*(분석|analysis)\s*(할|해)/.test(lo)
  );
}

function sqlReferencesSource(sql: string, sourceName: string): boolean {
  const normalized = sql.toLowerCase();
  const source = sourceName.toLowerCase();
  return normalized.includes(`"${source}"`) || normalized.includes(source);
}

function isDirectSql(text: string): boolean {
  return /^\s*(select|with|show|describe|desc|explain)\b/i.test(text);
}

const ANALYSIS_RECOMMENDATIONS: Suggestion[] = [
  // ── Basic ───────────────────────────────────────────────────────────────────
  {
    title: "데이터 전체 현황",
    description: "5개 테이블의 행 수를 한눈에 확인합니다.",
    difficulty: 1,
    sql: `SELECT 'customers'     AS table_name, COUNT(*) AS row_count FROM ${H}.customers
UNION ALL SELECT 'products',      COUNT(*) FROM ${H}.products
UNION ALL SELECT 'orders',        COUNT(*) FROM ${H}.orders
UNION ALL SELECT 'order_items',   COUNT(*) FROM ${H}.order_items
UNION ALL SELECT 'commerce_data', COUNT(*) FROM ${H}.commerce_data`,
    insight: "데이터 규모와 밀도를 파악하는 첫 번째 단계",
  },
  {
    title: "주문 상태별 매출 분포",
    description: "Pending / Completed / Cancelled 주문의 금액 비중을 비교합니다.",
    difficulty: 1,
    sql: `SELECT
  status,
  COUNT(*) AS order_count,
  SUM(CAST(total_amount AS DOUBLE)) AS total_amount,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM ${H}.orders
GROUP BY status
ORDER BY total_amount DESC`,
    insight: "취소율이 높다면 프로세스 개선이 필요한 시그널",
  },
  // ── Intermediate ────────────────────────────────────────────────────────────
  {
    title: "월별 매출 추이 (시계열)",
    description: "월 단위 주문 건수와 매출 흐름을 분석합니다.",
    difficulty: 2,
    sql: `SELECT
  DATE_TRUNC('MONTH', CAST(order_date AS DATE)) AS order_month,
  COUNT(*)                                       AS order_count,
  SUM(CAST(total_amount AS DOUBLE))              AS revenue,
  AVG(CAST(total_amount AS DOUBLE))              AS avg_order_amount
FROM ${H}.orders
WHERE status = 'Completed'
GROUP BY DATE_TRUNC('MONTH', CAST(order_date AS DATE))
ORDER BY DATE_TRUNC('MONTH', CAST(order_date AS DATE))`,
    insight: "계절성, 성장 추세, 이상치(급락·급등) 발견 가능",
  },
  {
    title: "카테고리별 성과 상세",
    description: "카테고리별 판매량·총매출·평균할인율을 비교합니다.",
    difficulty: 2,
    sql: `SELECT
  p.category,
  COUNT(DISTINCT p.product_id)                                         AS product_count,
  SUM(CAST(oi.quantity AS INTEGER))                                    AS units_sold,
  SUM(CAST(oi.quantity AS INTEGER) * CAST(oi.unit_price AS DOUBLE))   AS gross_revenue,
  SUM(CAST(oi.quantity AS INTEGER) * CAST(oi.unit_price AS DOUBLE)
      * (1 - CAST(oi.discount_pct AS DOUBLE) / 100))                  AS net_revenue,
  ROUND(AVG(CAST(oi.discount_pct AS DOUBLE)), 1)                      AS avg_discount_pct
FROM ${H}.products p
JOIN ${H}.order_items oi ON p.product_id = oi.product_id
GROUP BY p.category
ORDER BY net_revenue DESC`,
    insight: "수익성 높은 카테고리 vs 할인 의존도가 높은 카테고리 비교",
  },
  {
    title: "고객 등급별 구매 패턴",
    description: "Gold / Silver / Bronze 고객의 주문 빈도와 객단가를 비교합니다.",
    difficulty: 2,
    sql: `SELECT
  c.tier,
  COUNT(DISTINCT c.customer_id)                        AS customers,
  COUNT(o.order_id)                                    AS total_orders,
  ROUND(1.0 * COUNT(o.order_id) /
        COUNT(DISTINCT c.customer_id), 1)              AS orders_per_customer,
  ROUND(AVG(CAST(o.total_amount AS DOUBLE)), 0)        AS avg_order_amount,
  SUM(CAST(o.total_amount AS DOUBLE))                  AS total_revenue
FROM ${H}.customers c
LEFT JOIN ${H}.orders o ON c.customer_id = o.customer_id
  AND o.status = 'Completed'
GROUP BY c.tier
ORDER BY total_revenue DESC`,
    insight: "VIP(Gold) 고객의 실제 가치 vs 하위 등급 잠재 고객 발굴",
  },
  // ── Advanced ────────────────────────────────────────────────────────────────
  {
    title: "RFM 고객 세그멘테이션",
    description: "Recency(최근성) · Frequency(구매 빈도) · Monetary(구매 금액)으로 고객 가치를 측정합니다.",
    difficulty: 3,
    sql: `SELECT
  c.customer_id,
  c.name,
  c.tier,
  MAX(o.order_date)                                  AS last_order_date,
  COUNT(o.order_id)                                  AS frequency,
  SUM(CAST(o.total_amount AS DOUBLE))                AS monetary,
  CASE
    WHEN COUNT(o.order_id) >= 5
      AND SUM(CAST(o.total_amount AS DOUBLE)) >= 1000 THEN 'Champions'
    WHEN COUNT(o.order_id) >= 3 THEN 'Loyal'
    WHEN COUNT(o.order_id) = 1 THEN 'New'
    ELSE 'At Risk'
  END AS rfm_segment
FROM ${H}.customers c
JOIN ${H}.orders o ON c.customer_id = o.customer_id
WHERE o.status = 'Completed'
GROUP BY c.customer_id, c.name, c.tier
ORDER BY monetary DESC, frequency DESC
LIMIT 50`,
    insight: "Champions → 리텐션 전략 / At Risk → 윈백 캠페인 대상",
  },
  {
    title: "매출 기여도 분석 (파레토)",
    description: "상위 20% 고객이 전체 매출의 몇 %를 기여하는지 검증합니다.",
    difficulty: 3,
    sql: `SELECT
  c.customer_id,
  c.name,
  c.tier,
  SUM(CAST(o.total_amount AS DOUBLE))               AS revenue,
  ROUND(100.0 * SUM(CAST(o.total_amount AS DOUBLE))
    / SUM(SUM(CAST(o.total_amount AS DOUBLE))) OVER (), 2) AS revenue_pct,
  SUM(SUM(CAST(o.total_amount AS DOUBLE))) OVER (
    ORDER BY SUM(CAST(o.total_amount AS DOUBLE)) DESC
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS cumulative_revenue
FROM ${H}.customers c
JOIN ${H}.orders o ON c.customer_id = o.customer_id
WHERE o.status = 'Completed'
GROUP BY c.customer_id, c.name, c.tier
ORDER BY revenue DESC
LIMIT 20`,
    insight: "파레토 법칙(80/20)이 실제로 적용되는지 데이터로 검증",
  },
  {
    title: "상품 교차 구매 패턴",
    description: "같은 주문에서 함께 구매되는 상품 조합을 분석합니다.",
    difficulty: 3,
    sql: `SELECT
  p1.name                                           AS product_a,
  p2.name                                           AS product_b,
  p1.category                                       AS category_a,
  p2.category                                       AS category_b,
  COUNT(*)                                          AS co_purchase_count
FROM ${H}.order_items oi1
JOIN ${H}.order_items oi2
  ON oi1.order_id = oi2.order_id
  AND oi1.product_id < oi2.product_id
JOIN ${H}.products p1 ON oi1.product_id = p1.product_id
JOIN ${H}.products p2 ON oi2.product_id = p2.product_id
GROUP BY p1.name, p2.name, p1.category, p2.category
ORDER BY co_purchase_count DESC
LIMIT 15`,
    insight: "번들 상품 기획, 추천 알고리즘(\"같이 산 상품\") 기반 데이터",
  },
  {
    title: "코호트 분석 (첫 이벤트 월 × 구매 월)",
    description: "최초 방문 월별 사용자 그룹(코호트)이 이후 월에 얼마나 구매를 유지하는지 리텐션을 측정합니다.",
    difficulty: 3,
    sql: `WITH first_event AS (
  SELECT user_id, MIN(SUBSTRING("time", 1, 7)) AS cohort_month
  FROM ${H}.commerce_data
  GROUP BY user_id
),
monthly_purchase AS (
  SELECT user_id, SUBSTRING("time", 1, 7) AS activity_month
  FROM ${H}.commerce_data
  WHERE event_name = 'purchase'
  GROUP BY user_id, SUBSTRING("time", 1, 7)
)
SELECT
  f.cohort_month,
  m.activity_month,
  COUNT(DISTINCT m.user_id) AS returning_buyers,
  COUNT(DISTINCT f.user_id) AS cohort_size
FROM first_event f
JOIN monthly_purchase m ON f.user_id = m.user_id
GROUP BY f.cohort_month, m.activity_month
ORDER BY f.cohort_month, m.activity_month`,
    insight: "cohort_month = activity_month 는 첫 달 구매자, 이후 달의 returning_buyers / cohort_size 비율이 리텐션율",
  },
  // ── Commerce event log ──────────────────────────────────────────────────────
  {
    title: "이커머스 이벤트 유형 분포",
    description: "view / cart / remove_from_cart / purchase 이벤트 건수와 비율을 분석합니다.",
    difficulty: 1,
    sql: `SELECT
  event_name,
  COUNT(*) AS cnt,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) AS pct
FROM ${H}.commerce_data
GROUP BY event_name
ORDER BY cnt DESC`,
    insight: "view-to-purchase 깔때기(funnel) 형태로 전환율을 직관적으로 파악",
  },
  {
    title: "카테고리별 view→purchase 전환율",
    description: "카테고리별 조회 수 대비 구매 전환율을 계산합니다.",
    difficulty: 2,
    sql: `SELECT
  category_1,
  COUNT(CASE WHEN event_name = 'view'     THEN 1 END) AS views,
  COUNT(CASE WHEN event_name = 'cart'     THEN 1 END) AS carts,
  COUNT(CASE WHEN event_name = 'purchase' THEN 1 END) AS purchases,
  ROUND(COUNT(CASE WHEN event_name = 'purchase' THEN 1 END) * 100.0
    / NULLIF(COUNT(CASE WHEN event_name = 'view' THEN 1 END), 0), 2) AS conversion_rate
FROM ${H}.commerce_data
WHERE category_1 != 'Not defined'
GROUP BY category_1
ORDER BY conversion_rate DESC
LIMIT 20`,
    insight: "전환율이 낮은 카테고리는 상품 페이지 개선 또는 프로모션 대상",
  },
  {
    title: "브랜드별 구매 현황",
    description: "브랜드별 구매 건수, 평균 가격을 내림차순으로 분석합니다.",
    difficulty: 2,
    sql: `SELECT
  brand,
  COUNT(CASE WHEN event_name = 'purchase' THEN 1 END) AS purchases,
  COUNT(*) AS total_events,
  ROUND(AVG(CAST(price AS DOUBLE)), 2) AS avg_price
FROM ${H}.commerce_data
WHERE brand != 'Not defined'
GROUP BY brand
ORDER BY purchases DESC
LIMIT 20`,
    insight: "구매 기여도가 높은 브랜드와 저가·고빈도 브랜드 패턴 파악",
  },
  {
    title: "장바구니 이탈 분석",
    description: "장바구니 추가(cart) 대비 제거(remove_from_cart) 비율로 이탈을 측정합니다.",
    difficulty: 2,
    sql: `SELECT
  category_1,
  COUNT(CASE WHEN event_name = 'cart' THEN 1 END)             AS cart_adds,
  COUNT(CASE WHEN event_name = 'remove_from_cart' THEN 1 END) AS cart_removes,
  COUNT(CASE WHEN event_name = 'purchase' THEN 1 END)         AS purchases,
  ROUND(COUNT(CASE WHEN event_name = 'remove_from_cart' THEN 1 END) * 100.0
    / NULLIF(COUNT(CASE WHEN event_name = 'cart' THEN 1 END), 0), 1) AS abandon_rate_pct
FROM ${H}.commerce_data
WHERE category_1 != 'Not defined'
GROUP BY category_1
ORDER BY cart_adds DESC
LIMIT 15`,
    insight: "이탈률 높은 카테고리는 가격/UX 문제 진단 필요",
  },
  {
    title: "이커머스 일별 시계열 추이",
    description: "날짜별 view / cart / purchase 이벤트 흐름을 시계열로 분석합니다.",
    difficulty: 2,
    sql: `SELECT
  SUBSTRING("time", 1, 10) AS event_date,
  COUNT(*) AS total_events,
  SUM(CASE WHEN event_name = 'view'     THEN 1 ELSE 0 END) AS views,
  SUM(CASE WHEN event_name = 'cart'     THEN 1 ELSE 0 END) AS carts,
  SUM(CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END) AS purchases
FROM ${H}.commerce_data
GROUP BY SUBSTRING("time", 1, 10)
ORDER BY event_date`,
    insight: "피크 날짜, 구매 급등/급락 시점 파악 → 프로모션 효과 검증 가능",
  },
  {
    title: "사용자 구매 빈도 세그멘테이션",
    description: "구매 횟수 기준으로 사용자를 no_purchase / one_time / occasional / frequent 세그먼트로 분류합니다.",
    difficulty: 3,
    sql: `WITH user_stats AS (
  SELECT
    user_id,
    COUNT(*) AS total_events,
    SUM(CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END) AS purchase_cnt
  FROM ${H}.commerce_data
  GROUP BY user_id
)
SELECT
  CASE
    WHEN purchase_cnt = 0  THEN 'no_purchase'
    WHEN purchase_cnt = 1  THEN 'one_time'
    WHEN purchase_cnt <= 5 THEN 'occasional'
    ELSE                        'frequent'
  END AS segment,
  COUNT(*)                     AS user_cnt,
  ROUND(AVG(total_events), 1)  AS avg_events_per_user
FROM user_stats
GROUP BY
  CASE
    WHEN purchase_cnt = 0  THEN 'no_purchase'
    WHEN purchase_cnt = 1  THEN 'one_time'
    WHEN purchase_cnt <= 5 THEN 'occasional'
    ELSE                        'frequent'
  END
ORDER BY user_cnt DESC`,
    insight: "no_purchase 비율이 높다면 첫 구매 유도 전략(쿠폰, 추천) 필요; frequent 세그먼트는 VIP 프로그램 대상",
  },
  {
    title: "가격대별 구매 세그멘테이션",
    description: "상품 가격 구간별로 이벤트 수와 구매 전환을 비교합니다.",
    difficulty: 2,
    sql: `SELECT
  CASE
    WHEN CAST(price AS DOUBLE) < 10   THEN 'under_10'
    WHEN CAST(price AS DOUBLE) < 50   THEN '10_to_50'
    WHEN CAST(price AS DOUBLE) < 200  THEN '50_to_200'
    ELSE                                   'over_200'
  END AS price_segment,
  COUNT(*)                                                     AS event_cnt,
  SUM(CASE WHEN event_name = 'purchase' THEN 1 ELSE 0 END)    AS purchases,
  ROUND(AVG(CAST(price AS DOUBLE)), 2)                         AS avg_price
FROM ${H}.commerce_data
WHERE price IS NOT NULL AND price != ''
GROUP BY
  CASE
    WHEN CAST(price AS DOUBLE) < 10   THEN 'under_10'
    WHEN CAST(price AS DOUBLE) < 50   THEN '10_to_50'
    WHEN CAST(price AS DOUBLE) < 200  THEN '50_to_200'
    ELSE                                   'over_200'
  END
ORDER BY purchases DESC`,
    insight: "저가 상품이 구매 건수를 주도하나, 고가 상품의 매출 기여도 확인 필요",
  },
];

/** Detect "list available sources/databases" intent */
function detectListSourcesIntent(text: string): boolean {
  const lo = text.toLowerCase().trim();
  return (
    /(접근|접속|연결|사용)\s*(가능한|할\s*수\s*있는)?\s*(db|데이터베이스|소스|source|database)/.test(lo) ||
    /(어떤|무슨|뭔|어느)\s*(db|데이터베이스|소스|source|database)/.test(lo) ||
    /(db|데이터베이스|소스|source|database)\s*(목록|리스트|종류|현황|있|알려|보여)/.test(lo) ||
    /(뭐가|무엇이|어디가)\s*(있|연결|접속)/.test(lo) ||
    /available\s*(db|database|source)/.test(lo) ||
    /list\s*(db|database|source)/.test(lo)
  );
}

/** Detect "what is the current connected DB info?" intent */
function detectCurrentSourceInfoIntent(text: string): boolean {
  const lo = text.toLowerCase().trim();
  return (
    /(현재|지금|접속된|연결된|활성|active)\s*(db|데이터베이스|소스|source)/.test(lo) ||
    /(db|데이터베이스|소스|source)\s*(정보|info|상태|현황|뭐|무엇|어디|어떤)/.test(lo) ||
    /어떤\s*(db|데이터베이스|소스).*?(접속|연결)/.test(lo) ||
    /접속\s*(중|되어있|된\s*db|된\s*소스|된\s*데이터베이스)/.test(lo) ||
    /연결\s*(중|되어있|된\s*db|된\s*소스|된\s*데이터베이스)/.test(lo) ||
    /(지금|현재)\s*(뭐|무엇|어떤|어디).*(쓰|사용|접속|연결)/.test(lo) ||
    /current\s*(db|database|source|connection)/.test(lo)
  );
}

/** Detect general chat intent (greeting, help, etc.) */
function detectChatIntent(text: string): string | null {
  const lo = text.toLowerCase().trim();
  if (/^(안녕|hello|hi\b|hey\b|반가|반갑|좋은\s*(아침|오후|저녁))/.test(lo)) {
    return "안녕하세요! 저는 Dremio AI Agent입니다. 샘플DB에 대해 자연어로 질문하시면 데이터를 조회해 드립니다.\n\n예: \"고객 목록을 보여줘\", \"총 매출은 얼마야?\", \"이커머스 이벤트 유형 분포 보여줘\"";
  }
  if (/도움(말|이 필요|이 되)|help|뭘\s*(할 수|도와|해줄)|기능|할 수 있|어떻게 사용/.test(lo)) {
    return [
      "다음 질문을 자연어로 입력하면 자동으로 데이터를 조회해 드립니다:",
      "",
      "📋 목록 조회",
      "  · 고객 목록을 보여줘",
      "  · 상품 목록 조회해줘",
      "  · 최근 주문 보여줘",
      "",
      "📊 집계 · 분석",
      "  · 총 매출이 얼마야?",
      "  · 카테고리별 상품 수를 알려줘",
      "  · 가장 많이 주문한 고객은?",
      "  · 주문 상태별 현황 알려줘",
      "  · 월별 매출 추이 보여줘",
      "",
      "🛒 이커머스 이벤트 분석 (commerce_data, ~700만 행)",
      "  · 이커머스 이벤트 유형별 분포 보여줘",
      "  · 카테고리별 구매 전환율 분석해줘",
      "  · 브랜드별 구매 현황 상위 20개",
      "  · 장바구니 이탈 분석",
      "",
      "🔍 필터 · 조건",
      "  · 재고가 20개 미만인 상품은?",
      "  · 결제 수단별 주문 건수는?",
      "",
      "💡 직접 SQL 입력도 가능합니다.",
      '  · SELECT * FROM "@dremio1".orders LIMIT 10',
      '  · SELECT * FROM "@dremio1".commerce_data LIMIT 10',
    ].join("\n");
  }
  if (/감사|고마|thanks|thank you/.test(lo)) {
    return "천만에요! 다른 데이터가 궁금하시면 언제든지 질문해 주세요. 😊";
  }
  if (/어떤\s*(테이블|데이터)이\s*있|어떤\s*데이터를/.test(lo)) {
    return [
      "샘플DB에는 다음 5개 테이블이 있습니다:",
      "",
      "① customers     – 고객 정보 (이름, 이메일, 도시, 국가, 나이)",
      "② products      – 상품 정보 (카테고리, 가격, 재고)",
      "③ orders        – 주문 정보 (날짜, 상태, 금액, 결제수단)",
      "④ order_items   – 주문 상세 (수량, 단가, 할인율)",
      "⑤ commerce_data – 이커머스 이벤트 로그 (~700만 행, view/cart/purchase 등)",
    ].join("\n");
  }
  return null;
}

// ── SuggestionCards ───────────────────────────────────────────────────────────

const DIFFICULTY_LABEL = ["", "⭐ 기초", "⭐⭐ 중급", "⭐⭐⭐ 고급"];
const DIFFICULTY_COLOR: Record<number, { bg: string; text: string }> = {
  1: { bg: "#f0fdf4", text: "#15803d" },
  2: { bg: "#eff6ff", text: "#1d4ed8" },
  3: { bg: "#fdf4ff", text: "#7e22ce" },
};

function SuggestionCards({
  suggestions,
  onRun,
}: {
  suggestions: Suggestion[];
  onRun: (s: Suggestion) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
      {suggestions.map((s, i) => {
        const dc = DIFFICULTY_COLOR[s.difficulty];
        return (
          <div
            key={i}
            style={{
              background: "#fafafa",
              border: "1px solid #e5e7eb",
              borderRadius: 12,
              overflow: "hidden",
              transition: "box-shadow 0.15s",
            }}
          >
            {/* Card header */}
            <div
              style={{
                alignItems: "flex-start",
                display: "flex",
                gap: 10,
                justifyContent: "space-between",
                padding: "12px 14px 10px",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Difficulty badge */}
                <span
                  style={{
                    background: dc.bg,
                    borderRadius: 999,
                    color: dc.text,
                    display: "inline-block",
                    fontSize: 10,
                    fontWeight: 700,
                    marginBottom: 5,
                    padding: "2px 8px",
                  }}
                >
                  {DIFFICULTY_LABEL[s.difficulty]}
                </span>
                <div
                  style={{
                    color: "#111827",
                    fontSize: 13,
                    fontWeight: 700,
                    lineHeight: 1.3,
                    marginBottom: 4,
                  }}
                >
                  {s.title}
                </div>
                <div style={{ color: "#6b7280", fontSize: 12, lineHeight: 1.5 }}>
                  {s.description}
                </div>
                <div
                  style={{
                    color: "#9ca3af",
                    fontSize: 11,
                    fontStyle: "italic",
                    marginTop: 4,
                  }}
                >
                  💡 {s.insight}
                </div>
              </div>
              {/* Run button */}
              <button
                onClick={() => onRun(s)}
                style={{
                  alignItems: "center",
                  background: "#43b8c9",
                  border: "none",
                  borderRadius: 8,
                  color: "#fff",
                  cursor: "pointer",
                  display: "flex",
                  flexShrink: 0,
                  fontSize: 12,
                  fontWeight: 700,
                  gap: 4,
                  padding: "7px 12px",
                  whiteSpace: "nowrap",
                }}
                type="button"
              >
                ▶ 실행
              </button>
            </div>
            {/* SQL preview */}
            <details style={{ borderTop: "1px solid #f0f1f3" }}>
              <summary
                style={{
                  color: "#6b7280",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "7px 14px",
                  userSelect: "none",
                }}
              >
                SQL 미리보기
              </summary>
              <pre
                style={{
                  background: "#f8fafc",
                  color: "#1e293b",
                  fontSize: 11,
                  lineHeight: 1.5,
                  margin: 0,
                  overflowX: "auto",
                  padding: "10px 14px 12px",
                  whiteSpace: "pre-wrap",
                }}
              >
                {s.sql}
              </pre>
            </details>
          </div>
        );
      })}
    </div>
  );
}

// ── ResultTabs (Table + Chart) ────────────────────────────────────────────────

function ResultTabs({ data }: { data: JobResults }) {
  const chartAvailable = useMemo(() => {
    if (!data.rows?.length) return false;
    return data.schema?.some((c) =>
      ["INTEGER", "BIGINT", "FLOAT", "DOUBLE", "DECIMAL", "REAL"].includes(
        (c.type?.name ?? "").toUpperCase(),
      ),
    );
  }, [data]);

  return (
    <div style={{ marginTop: 14 }}>
      {/* 결과 데이터 — 항상 표로 표시 */}
      <div
        style={{
          color: "#374151",
          fontSize: 12,
          fontWeight: 700,
          marginBottom: 6,
        }}
      >
        결과 데이터
      </div>
      <ResultTable data={data} />

      {/* 차트 — 숫자형 컬럼이 있을 때만 추가 표시 */}
      {chartAvailable && (
        <div style={{ marginTop: 20 }}>
          <SmartChart data={data} />
        </div>
      )}
    </div>
  );
}

// ── ResultTable ───────────────────────────────────────────────────────────────

function ResultTable({ data }: { data: JobResults }) {
  if (!data.rows?.length) {
    return (
      <p style={{ color: "#9ca3af", fontStyle: "italic", margin: "10px 0 0", fontSize: 13 }}>
        결과 없음 (0 rows)
      </p>
    );
  }
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
        총 <strong>{data.rowCount.toLocaleString()}</strong>건 중{" "}
        {data.rows.length}건 표시
      </div>
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          maxHeight: 320,
          overflow: "auto",
          background: "#fff",
          boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
        }}
      >
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              {data.schema.map((col) => (
                <th
                  key={col.name}
                  style={{
                    background: "#f8fafc",
                    borderBottom: "1px solid #e5e7eb",
                    color: "#374151",
                    fontWeight: 700,
                    padding: "9px 12px",
                    position: "sticky",
                    textAlign: "left",
                    top: 0,
                    whiteSpace: "nowrap",
                  }}
                  title={col.type?.name}
                >
                  {col.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, ri) => (
              <tr
                key={ri}
                style={{ background: ri % 2 === 0 ? "#fff" : "#fafafa" }}
              >
                {data.schema.map((col) => (
                  <td
                    key={col.name}
                    style={{
                      borderBottom: "1px solid #f0f1f3",
                      color: "#111827",
                      padding: "7px 12px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row[col.name] == null ? (
                      <span style={{ color: "#d1d5db", fontStyle: "italic" }}>
                        NULL
                      </span>
                    ) : (
                      String(row[col.name])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── PhaseTag ──────────────────────────────────────────────────────────────────

function PhaseTag({ phase, jobStatus }: { phase?: AgentPhase; jobStatus?: JobStatus }) {
  if (!phase || phase === "done" || phase === "chat" || phase === "error") return null;
  const labels: Record<string, string> = {
    thinking: "🧠 의도 분석 중...",
    generating: "✍️ SQL 생성 중...",
    running: jobStatus ? `⚙️ ${JOB_STATUS_LABEL[jobStatus] ?? jobStatus}` : "⚙️ 실행 중...",
  };
  return (
    <div
      style={{
        alignItems: "center",
        color: "#6b7280",
        display: "flex",
        fontSize: 12,
        gap: 6,
        marginTop: 6,
      }}
    >
      <span
        style={{
          animation: "aap-spin 1s linear infinite",
          borderRadius: "50%",
          border: "2px solid #d1d5db",
          borderTopColor: "#43b8c9",
          display: "inline-block",
          flexShrink: 0,
          height: 12,
          width: 12,
        }}
      />
      {labels[phase] ?? phase}
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  onRunSql,
}: {
  msg: Message;
  onRunSql?: (sql: string, label: string) => void;
}) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  const avatarBg = isUser ? "#2f80ed" : isSystem ? "#e5e7eb" : "#43b8c9";
  const avatarColor = isSystem ? "#6b7280" : "#fff";
  const avatarLabel = isUser ? "You" : isSystem ? "i" : "AI";

  const bubbleBg = isUser ? "#eff6ff" : "#fff";
  const bubbleRadius = isUser
    ? "18px 18px 4px 18px"
    : "18px 18px 18px 4px";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: isUser ? "row-reverse" : "row",
        gap: 10,
        marginBottom: 20,
        maxWidth: "86%",
        alignSelf: isUser ? "flex-end" : "flex-start",
      }}
    >
      {/* Avatar */}
      <div
        style={{
          alignItems: "center",
          background: avatarBg,
          borderRadius: "50%",
          color: avatarColor,
          display: "flex",
          flexShrink: 0,
          fontSize: 10,
          fontWeight: 800,
          height: 32,
          justifyContent: "center",
          width: 32,
        }}
      >
        {avatarLabel}
      </div>

      {/* Bubble */}
      <div
        style={{
          background: bubbleBg,
          border: "1px solid #e5e7eb",
          borderRadius: bubbleRadius,
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          maxWidth: "100%",
          padding: "12px 16px",
        }}
      >
        {/* Main text */}
        {msg.text && (
          <pre
            style={{
              fontFamily: "inherit",
              fontSize: 14,
              lineHeight: 1.65,
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "#111827",
            }}
          >
            {msg.text}
          </pre>
        )}

        {/* Phase indicator */}
        {msg.phase && msg.phase !== "done" && msg.phase !== "chat" && (
          <PhaseTag phase={msg.phase} jobStatus={msg.jobStatus} />
        )}

        {/* Error */}
        {msg.error && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 8,
              color: "#dc2626",
              fontSize: 13,
              marginTop: 10,
              padding: "8px 12px",
            }}
          >
            ❌ {msg.error}
          </div>
        )}

        {/* SQL block */}
        {msg.sql && (
          <details style={{ marginTop: 12 }}>
            <summary
              style={{
                color: "#6b7280",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                userSelect: "none",
              }}
            >
              실행된 SQL 보기
            </summary>
            <pre
              style={{
                background: "#f8fafc",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                color: "#1e293b",
                fontSize: 12,
                lineHeight: 1.5,
                margin: "8px 0 0",
                overflow: "auto",
                padding: "10px 12px",
                whiteSpace: "pre-wrap",
              }}
            >
              {msg.sql}
            </pre>
          </details>
        )}

        {/* Results — Table / Chart tabs */}
        {msg.result && <ResultTabs data={msg.result} />}

        {/* Analysis suggestion cards */}
        {msg.suggestions && msg.suggestions.length > 0 && onRunSql && (
          <SuggestionCards
            suggestions={msg.suggestions}
            onRun={(s) => onRunSql(s.sql, s.title)}
          />
        )}
      </div>
    </div>
  );
}

// ── AgentDrawer ───────────────────────────────────────────────────────────────

type AgentDrawerProps = { open: boolean; onClose: () => void };

const AgentDrawer = ({ open, onClose }: AgentDrawerProps) => {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  const [messages, setMessages] = useState<Message[]>(() => [
    {
      id: nextId(),
      role: "system",
      text: [
        "안녕하세요! Dremio AI Agent입니다.",
        "",
        "자연어로 질문하시면 데이터를 자동으로 조회해 드립니다.",
        "",
        "🗄️ DB 연결 & 탐색",
        '  · "접근 가능한 DB가 뭐가 있어?"',
        '  · "factory_db에 접속해"',
        "",
        "📊 데이터 조회 (샘플DB)",
        '  · "고객 목록을 보여줘"',
        '  · "총 매출이 얼마야?"',
        '  · "가장 많이 판매된 상품은?"',
        "",
        "🛒 이커머스 이벤트 분석 (commerce_data, ~700만 행)",
        '  · "이커머스 이벤트 유형별 분포 보여줘"',
        '  · "카테고리별 구매 전환율 분석해줘"',
        '  · "브랜드별 구매 현황 상위 20개"',
        "",
        '"도움말"을 입력하면 전체 기능을 확인할 수 있습니다.',
      ].join("\n"),
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [llmMode, setLlmMode] = useState<LlmMode | null>(null);
  const [llmModel, setLlmModel] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [activeSourceSchema, setActiveSourceSchema] = useState<SourceSchema | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [searchQuery, setSearchQuery] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Keep messages ref in sync for use inside async handlers
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ── open/close animation ───────────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(t);
  }, [open]);

  // ── LLM health check ───────────────────────────────────────────────────────
  useEffect(() => {
    if (mounted) {
      checkLLMHealth().then(({ mode, model }) => {
        setLlmMode(mode);
        setLlmModel(model);
      });
    }
  }, [mounted]);

  const refreshLLMHealth = useCallback(async () => {
    const { mode, model } = await checkLLMHealth();
    setLlmMode(mode);
    setLlmModel(model);
    return mode === "qwen" || mode === "server-rules";
  }, []);

  // ── auto scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);


  // ── focus input on open, and refocus after every response ─────────────────
  const focusInput = useCallback(() => {
    setTimeout(() => textareaRef.current?.focus(), 60);
  }, []);

  useEffect(() => {
    if (visible) focusInput();
  }, [visible, focusInput]);

  // ── Esc closes panel ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);

  const modelLabel = useMemo(() => {
    if (llmMode === "qwen" || llmMode === "server-rules") {
      return `${formatModelName(llmModel)}-based`;
    }
    return "LLM-based";
  }, [llmMode, llmModel]);

  /** True when LLM server is reachable (qwen or server-rules mode) */
  const llmReady = llmMode === "qwen" || llmMode === "server-rules";

  // ── Sidebar: filtered + grouped history ───────────────────────────────────
  const sidebarGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? history.filter((h) => h.text.toLowerCase().includes(q))
      : history;
    return groupByDate(filtered);
  }, [history, searchQuery]);

  // ── Message state helpers ──────────────────────────────────────────────────
  const patchLast = useCallback((patch: Partial<Message>) => {
    setMessages((prev) => {
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  }, []);

  const buildHistory = () =>
    messagesRef.current
      .filter((m) => m.role !== "system" && m.text)
      .map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      }))
      .slice(-10);

  const startNewChat = () => {
    setMessages([
      {
        id: nextId(),
        role: "system",
        text: "새 대화를 시작합니다. 무엇이든 질문해 주세요!",
      },
    ]);
    setInput("");
    focusInput();
  };

  /** Clicking a history item fills the input with that text */
  const fillFromHistory = (item: HistoryItem) => {
    setInput(item.text);
    focusInput();
  };

  const handleClose = useCallback(
    (e: React.MouseEvent) => { e.stopPropagation(); onClose(); },
    [onClose],
  );

  // ── Execute SQL directly (used by suggestion card ▶ 실행 button) ──────────
  const runSqlDirectly = useCallback(
    async (sql: string, label: string) => {
      if (busy) return;
      if (activeSource && !sqlReferencesSource(sql, activeSource)) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "user", text: `▶ ${label}` },
          {
            id: nextId(),
            role: "agent",
            text: `현재 "${activeSource}" 데이터베이스에 접속되어 있어 해당 데이터베이스에 대한 쿼리만 실행할 수 있습니다.`,
            phase: "chat",
          },
        ]);
        return;
      }
      setBusy(true);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: `▶ ${label}` },
        { id: nextId(), role: "agent", text: label, phase: "running", sql },
      ]);

      try {
        const jobId = await submitSql(sql);
        patchLast({ jobStatus: "RUNNING" });
        const finalJob = await waitForJob(jobId, (state) =>
          patchLast({ jobStatus: state }),
        );
        if (finalJob.state === "FAILED") {
          logAgentError("runSqlDirectly.jobFailed", finalJob.errorMessage ?? "쿼리 실패", { label, sql });
          patchLast({ phase: "error", jobStatus: undefined, error: finalJob.errorMessage ?? "쿼리 실패" });
          return;
        }
        if (finalJob.state === "CANCELLED") {
          logAgentError("runSqlDirectly.jobCancelled", "쿼리가 취소되었습니다.", { label, sql });
          patchLast({ phase: "error", jobStatus: undefined, error: "쿼리가 취소되었습니다." });
          return;
        }
        const result = await fetchJobResults(jobId);
        patchLast({
          phase: "done",
          jobStatus: undefined,
          text: `${label}\n\n✅ 조회 완료 — 총 ${result.rowCount.toLocaleString()}건`,
          result,
        });
      } catch (err: any) {
        logAgentError("runSqlDirectly.catch", err, { label, sql });
        patchLast({ phase: "error", jobStatus: undefined, error: err?.message ?? "오류 발생" });
      } finally {
        setBusy(false);
        focusInput();
      }
    },
    [activeSource, busy, patchLast, focusInput],
  );

  // ── Core submit handler ────────────────────────────────────────────────────
  const handleSubmit = async (e?: FormEvent | React.KeyboardEvent) => {
    e?.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy) return;

    setInput("");
    setBusy(true);

    // ── Prepend to history (newest at top, max 20) ─────────────────────────
    setHistory((prev) => {
      const newItem: HistoryItem = { id: Date.now(), text: prompt, ts: Date.now() };
      const next = [newItem, ...prev].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });

    // Add user message + placeholder agent message
    const agentMsgId = nextId();
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: "user", text: prompt },
      { id: agentMsgId, role: "agent", text: "", phase: "thinking" },
    ]);

    try {
      // ── Step -2: Disconnect intent ────────────────────────────────────────
      if (detectDisconnectIntent(prompt)) {
        if (activeSource) {
          const prev = activeSource;
          setActiveSource(null);
          setActiveSourceSchema(null);
          patchLast({
            phase: "chat",
            text: `🔌 "${prev}" 연결을 해제했습니다.\n\n다른 소스에 접속하거나 샘플DB를 사용할 수 있습니다.\n  · "접근 가능한 DB 목록 알려줘"\n  · "factory_db에 접속해"`,
          });
        } else {
          patchLast({
            phase: "chat",
            text: "현재 접속된 데이터베이스가 없습니다.",
          });
        }
        return;
      }

      // ── Step -1: Source connect intent ─────────────────────────────────────
      const connectTarget = detectConnectIntent(prompt);
      if (connectTarget) {
        patchLast({ phase: "running", text: `"${connectTarget}" 소스에 접속 중...` });
        setSourceLoading(true);
        try {
          const schema = await fetchSourceSchema(connectTarget);
          if (schema.tables.length === 0) {
            logAgentError("sourceConnect.emptySchema", "소스를 찾을 수 없거나 테이블이 없습니다.", {
              source: connectTarget,
            });
            patchLast({
              phase: "chat",
              text: `❌ "${connectTarget}" 소스를 찾을 수 없거나 테이블이 없습니다.\n사용 가능한 소스: @dremio1, factory_db 등`,
            });
          } else {
            setActiveSource(connectTarget);
            setActiveSourceSchema(schema);
            const tableList = schema.tables
              .slice(0, 20)
              .map((t) => `  • ${t.schema}.${t.name}` + (t.columns.length ? ` (${t.columns.length}개 컬럼)` : ""))
              .join("\n");
            const more = schema.tables.length > 20 ? `\n  ... 외 ${schema.tables.length - 20}개` : "";
            patchLast({
              phase: "chat",
              text: `✅ "${connectTarget}" 소스에 접속했습니다.\n\n📋 테이블 목록 (${schema.tables.length}개):\n${tableList}${more}\n\n이제 자연어로 데이터를 조회할 수 있습니다.\n예: "분석 추천해줘", "미해결 불량 목록 보여줘", "설비별 이상 발생률 분석해줘"`,
            });
          }
        } catch (err: any) {
          logAgentError("sourceConnect.catch", err, { source: connectTarget });
          patchLast({ phase: "error", error: err?.message ?? "소스 접속 실패" });
        } finally {
          setSourceLoading(false);
        }
        return;
      }

      // ── Step 0-A: List available sources intent ────────────────────────────
      if (detectListSourcesIntent(prompt)) {
        patchLast({ phase: "running", text: "접근 가능한 데이터베이스 목록을 조회하고 있습니다..." });
        try {
          const sources: SourceInfo[] = await listSources();

          // Source type → human-readable label
          const typeLabel = (t: string) => {
            const m: Record<string, string> = {
              POSTGRES: "PostgreSQL", MYSQL: "MySQL", MONGODB: "MongoDB",
              ORACLE: "Oracle", MSSQL: "SQL Server", REDSHIFT: "Redshift",
              S3: "Amazon S3", ADLS: "Azure Data Lake", GCS: "Google Cloud Storage",
              HOME: "개인 홈", SPACE: "스페이스", INTERNAL: "내부 소스",
            };
            const upper = (t ?? "").toUpperCase();
            return m[upper] ?? t ?? "알 수 없음";
          };

          if (sources.length === 0) {
            patchLast({
              phase: "chat",
              text: "현재 접근 가능한 데이터베이스 소스가 없습니다.\nDremio 관리자에게 소스 등록을 요청하세요.",
            });
          } else {
            const lines: string[] = [
              `✅ Dremio에서 접근 가능한 소스 ${sources.length}개를 찾았습니다.\n`,
            ];
            sources.forEach((src, i) => {
              const icon =
                src.type?.toUpperCase().includes("POSTGRES") ? "🐘" :
                src.type?.toUpperCase().includes("MYSQL")    ? "🐬" :
                src.type?.toUpperCase() === "HOME"           ? "🏠" :
                src.type?.toUpperCase() === "SPACE"          ? "📁" :
                src.type?.toUpperCase().includes("S3")       ? "☁️" : "🗄️";
              lines.push(`${icon} ${i + 1}. ${src.name}  (${typeLabel(src.type)})`);
            });
            lines.push("");
            lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            lines.push("접속하려면: \"<소스명>에 접속해\" 라고 입력하세요.");
            lines.push("예: \"factory_db에 접속해\"");

            patchLast({ phase: "chat", text: lines.join("\n") });
          }
        } catch (err: any) {
          logAgentError("listSources.catch", err, { prompt });
          patchLast({ phase: "error", error: err?.message ?? "소스 목록 조회 실패" });
        }
        return;
      }

      // ── Step 0-B: Current source info intent ──────────────────────────────
      if (detectCurrentSourceInfoIntent(prompt)) {
        const lo = prompt.toLowerCase().trim();
        // 단순 이름 질문인지 구분 (db명, db 이름, 이름이 뭐야 등)
        const isNameOnly =
          /(db명|데이터베이스명|소스명|db\s*이름|데이터베이스\s*이름|소스\s*이름|database\s*name|db\s*name)/.test(lo) ||
          /(현재|지금).*(db|데이터베이스|소스).*(이름|명)\s*(이?뭐|은?뭐|가?뭐|은|이|가)/.test(lo) ||
          /^(현재|지금)\s*(db|데이터베이스|소스).*?(명|이름)\s*/.test(lo);

        if (!activeSource || !activeSourceSchema) {
          patchLast({
            phase: "chat",
            text: [
              "현재 접속된 데이터베이스가 없습니다.",
              "",
              "접속하려면 아래와 같이 입력하세요:",
              '  · "factory_db에 접속해"',
              '  · "접근 가능한 DB가 뭐가 있어?" — 사용 가능한 소스 목록 확인',
            ].join("\n"),
          });
        } else if (isNameOnly) {
          // 단순 이름 질문 → 한 줄 간결 응답
          patchLast({
            phase: "chat",
            text: [
              `현재 접속된 데이터베이스: ${activeSource}`,
              "",
              `자세한 정보를 보려면 "현재 접속된 DB 정보 알려줘" 라고 입력하세요.`,
            ].join("\n"),
          });
        } else {
          // 상세 정보 질문 → 테이블 목록 + 통계 표시
          const schema = activeSourceSchema;
          const tableCount = schema.tables.length;
          const totalCols = schema.tables.reduce((s, t) => s + t.columns.length, 0);
          const tableLines = schema.tables.map((t) => {
            const colInfo = t.columns.length ? `${t.columns.length}개 컬럼` : "컬럼 정보 없음";
            return `  • ${t.name}  (${colInfo})`;
          });

          const lines: string[] = [
            `🔌 현재 접속된 데이터베이스: ${activeSource}`,
            "",
            `📋 테이블 수: ${tableCount}개`,
            `📊 전체 컬럼 수: ${totalCols > 0 ? totalCols.toLocaleString() + "개" : "조회 중..."}`,
            "",
            "─── 테이블 목록 ───",
            ...tableLines.slice(0, 15),
            ...(tableCount > 15 ? [`  ... 외 ${tableCount - 15}개 테이블`] : []),
            "",
            "─── 빠른 명령 예시 ───",
            `  · "분석 추천해줘"  — ${activeSource} 전용 분석 카드 표시`,
            `  · "미해결 불량 목록 보여줘"`,
            `  · "설비별 이상 발생률 분석해줘"`,
            `  · "접속 해제"  — ${activeSource} 연결 해제`,
          ];
          patchLast({ phase: "chat", text: lines.join("\n") });
        }
        return;
      }

      // ── Step 0: Analysis recommendation intent ─────────────────────────────
      // factory_db 접속 중일 때 전용 분석 카드 표시
      if (activeSource === "factory_db" && detectAnalysisIntent(prompt)) {
        patchLast({ phase: "running", text: "factory_db 분석 시나리오를 준비하고 있습니다..." });
        try {
          const overviewSql = `SELECT 'plants' AS tbl, COUNT(*) AS cnt FROM factory_db.public.plants
UNION ALL SELECT 'production_lines', COUNT(*) FROM factory_db.public.production_lines
UNION ALL SELECT 'equipments', COUNT(*) FROM factory_db.public.equipments
UNION ALL SELECT 'process_logs', COUNT(*) FROM factory_db.public.process_logs
UNION ALL SELECT 'defect_logs', COUNT(*) FROM factory_db.public.defect_logs`;
          const jobId = await submitSql(overviewSql);
          const finalJob = await waitForJob(jobId, (s) => patchLast({ jobStatus: s }));
          const overview = finalJob.state === "COMPLETED" ? await fetchJobResults(jobId) : null;
          patchLast({
            phase: "chat",
            jobStatus: undefined,
            text: "🏭 **factory_db** 데이터를 분석했습니다. 아래 분석 시나리오를 추천합니다.\n▶ 실행 버튼을 클릭하면 즉시 쿼리를 실행합니다.",
            result: overview ?? undefined,
            suggestions: FACTORY_DB_ANALYSIS,
          });
        } catch {
          patchLast({
            phase: "chat",
            jobStatus: undefined,
            text: "🏭 **factory_db** 분석 시나리오를 추천합니다.\n▶ 실행 버튼을 클릭하면 즉시 쿼리를 실행합니다.",
            suggestions: FACTORY_DB_ANALYSIS,
          });
        }
        return;
      }

      // Only use built-in sample recommendations when no external source is connected.
      if (!activeSourceSchema && detectAnalysisIntent(prompt)) {
        // Show table overview first, then recommendations
        patchLast({ phase: "running", text: "테이블 현황을 분석하고 있습니다..." });
        try {
          const overviewSql = `SELECT 'customers' AS t, COUNT(*) AS n FROM ${H}.customers
UNION ALL SELECT 'products', COUNT(*) FROM ${H}.products
UNION ALL SELECT 'orders', COUNT(*) FROM ${H}.orders
UNION ALL SELECT 'order_items', COUNT(*) FROM ${H}.order_items`;
          const jobId = await submitSql(overviewSql);
          const finalJob = await waitForJob(jobId, (s) => patchLast({ jobStatus: s }));
          const overview = finalJob.state === "COMPLETED"
            ? await fetchJobResults(jobId)
            : null;
          patchLast({
            phase: "chat",
            jobStatus: undefined,
            text: [
              "현재 샘플DB를 분석한 결과, 아래 분석 시나리오를 추천합니다.",
              "▶ 실행 버튼을 클릭하면 즉시 쿼리를 실행합니다.",
            ].join("\n"),
            result: overview ?? undefined,
            suggestions: ANALYSIS_RECOMMENDATIONS,
          });
        } catch (err) {
          logAgentError("analysisRecommendation.overviewFailed", err, { prompt });
          patchLast({
            phase: "chat",
            jobStatus: undefined,
            text: "샘플DB 기반으로 아래 분석 시나리오를 추천합니다.\n▶ 실행 버튼을 클릭하면 즉시 쿼리를 실행합니다.",
            suggestions: ANALYSIS_RECOMMENDATIONS,
          });
        }
        return;
      }

      // ── Step 0-C: Insight intent (data interpretation questions) ─────────────
      // Only applies when no external source is connected (sample DB context).
      if (!activeSourceSchema) {
        const insightTarget = detectInsightIntent(prompt);
        if (insightTarget) {
          patchLast({ phase: "running", text: `"${insightTarget.label}" 데이터를 조회하고 인사이트를 분석하고 있습니다...` });
          try {
            // 1) Run the SQL to get actual data
            const jobId = await submitSql(insightTarget.sql);
            const finalJob = await waitForJob(jobId, (s) => patchLast({ jobStatus: s }));
            if (finalJob.state !== "COMPLETED") {
              throw new Error(finalJob.errorMessage ?? "쿼리 실행 실패");
            }
            const result = await fetchJobResults(jobId);

            // 2) Send data to /insight for LLM interpretation
            patchLast({ phase: "running", text: "AI가 데이터를 분석하고 인사이트를 생성하고 있습니다..." });
            let insightText: string;
            try {
              const insightResp = await callInsight(
                prompt,
                result.rows ?? [],
                insightTarget.sql,
                insightTarget.context,
              );
              insightText = insightResp.response;
            } catch {
              // fallback: show result with generic message
              insightText = `📊 **${insightTarget.label}** 분석 결과입니다. 위 데이터를 기반으로 인사이트를 도출하세요.`;
            }

            patchLast({
              phase: "done",
              jobStatus: undefined,
              text: insightText,
              result,
              sql: insightTarget.sql,
            });
          } catch (err: any) {
            logAgentError("insightFlow.catch", err, { prompt });
            patchLast({ phase: "error", error: err?.message ?? "인사이트 생성 실패" });
          }
          return;
        }
      }

      // ── Step 1: Check general chat intent ──────────────────────────────────
      const chatReply = detectChatIntent(prompt);
      if (chatReply) {
        patchLast({ text: chatReply, phase: "chat" });
        return;
      }

      // ── Step 2: Generate SQL ────────────────────────────────────────────────
      patchLast({ phase: "generating", text: "질문을 분석하고 있습니다..." });

      let sql: string;
      let explanation: string;

      if (isDirectSql(prompt)) {
        sql = prompt.replace(/;\s*$/, "");
        explanation = "입력한 SQL을 실행합니다.";
      } else if (activeSourceSchema) {
        // Health state can be stale in the browser. When a DB is connected,
        // try /nl2sql directly and let the actual request determine availability.
        await refreshLLMHealth().catch(() => undefined);
        const history = buildHistory();
        const schemaCtx = formatSchemaForLLM(activeSourceSchema);
        let llmRes: LlmResponse;
        try {
          llmRes = await callLLM(
            `${prompt}\n\n현재 접속된 데이터베이스 "${activeSource}"의 테이블만 사용해서 답변하세요. 다른 소스나 샘플DB는 절대 사용하지 마세요.`,
            history,
            schemaCtx,
          );
        } catch (err: any) {
          logAgentError("llm.connectedSource.catch", err, {
            prompt,
            activeSource,
            tableCount: activeSourceSchema.tables.length,
          });
          patchLast({
            phase: "error",
            text: `"${activeSource}" 데이터베이스에 접속되어 있지만 SQL 생성 요청에 실패했습니다.`,
            error: err?.message ?? "LLM 서버 호출 실패",
          });
          return;
        }

        if (llmRes.type !== "sql" || !llmRes.sql) {
          patchLast({ text: llmRes.response, phase: "chat" });
          return;
        }
        sql = llmRes.sql.trim();
        explanation = llmRes.response || llmRes.explanation || "접속된 데이터베이스 기준으로 SQL을 생성했습니다.";
      } else {
        const ruleResult = naturalLanguageToSql(prompt);
        if (ruleResult.kind === "sql") {
          sql = ruleResult.sql;
          explanation = ruleResult.explanation;
        } else if (llmReady) {
          // ── Step 3 (fallback): LLM SQL generation ─────────────────────────
          const history = buildHistory();
          const llmRes = await callLLM(prompt, history);

          if (llmRes.type !== "sql" || !llmRes.sql) {
            patchLast({ text: llmRes.response, phase: "chat" });
            return;
          }
          sql = llmRes.sql.trim();
          explanation = llmRes.response || llmRes.explanation || "SQL을 생성했습니다.";
        } else {
          // ── Unrecognized, no LLM ──────────────────────────────────────────
          patchLast({
            phase: "chat",
            text: [
              "질문 의도를 파악하지 못했습니다.",
              "",
              "다음과 같이 질문해 보세요:",
              '  · "고객 목록을 보여줘"',
              '  · "총 매출이 얼마야?"',
              '  · "가장 많이 판매된 상품은?"',
              '  · "카테고리별 상품 수"',
              '  · "월별 매출 추이"',
              "",
              '"도움말"을 입력하면 전체 예시를 볼 수 있습니다.',
            ].join("\n"),
          });
          return;
        }
      }

      if (activeSource && !sqlReferencesSource(sql, activeSource)) {
        logAgentError("sql.sourceGuard.blocked", "SQL이 현재 접속 소스를 참조하지 않습니다.", {
          activeSource,
          prompt,
          sql,
        });
        patchLast({
          phase: "error",
          error: `현재 "${activeSource}" 데이터베이스에 접속되어 있어 해당 데이터베이스를 참조하는 SQL만 실행할 수 있습니다.`,
          text: explanation,
          sql,
        });
        return;
      }

      // ── Step 4: Show generated SQL, start execution ────────────────────────
      patchLast({
        phase: "running",
        text: explanation,
        sql,
      });

      // ── Step 5: Submit SQL to Dremio ───────────────────────────────────────
      const jobId = await submitSql(sql);
      patchLast({ jobStatus: "RUNNING" });

      const finalJob = await waitForJob(jobId, (state) => {
        patchLast({ jobStatus: state });
      });

      if (finalJob.state === "FAILED") {
        logAgentError("submit.jobFailed", finalJob.errorMessage ?? "쿼리 실행에 실패했습니다.", {
          prompt,
          sql,
          activeSource,
        });
        patchLast({
          phase: "error",
          jobStatus: undefined,
          error: finalJob.errorMessage ?? "쿼리 실행에 실패했습니다.",
          text: explanation,
        });
        return;
      }
      if (finalJob.state === "CANCELLED") {
        logAgentError("submit.jobCancelled", "쿼리가 취소되었습니다.", {
          prompt,
          sql,
          activeSource,
        });
        patchLast({
          phase: "error",
          jobStatus: undefined,
          error: "쿼리가 취소되었습니다.",
          text: explanation,
        });
        return;
      }

      // ── Step 6: Fetch and display results ──────────────────────────────────
      const result = await fetchJobResults(jobId);
      const resultSummary =
        result.rowCount === 0
          ? "조회 결과가 없습니다."
          : `조회 완료 — 총 ${result.rowCount.toLocaleString()}건`;

      patchLast({
        phase: "done",
        jobStatus: undefined,
        text: `${explanation}\n\n✅ ${resultSummary}`,
        result,
      });
    } catch (err: any) {
      logAgentError("handleSubmit.catch", err, { prompt, activeSource });
      patchLast({
        phase: "error",
        jobStatus: undefined,
        text: "",
        error: err?.message ?? "알 수 없는 오류가 발생했습니다.",
      });
    } finally {
      setBusy(false);
      // ── Always refocus input so user can keep chatting ───────────────────
      focusInput();
    }
  };

  if (!mounted) return null;

  // ── Layout ─────────────────────────────────────────────────────────────────
  const panelStyle: React.CSSProperties = {
    background: "#f9fafb",
    bottom: 0,
    boxShadow: "4px 0 32px rgba(15, 23, 42, 0.15)",
    display: "flex",
    flexDirection: "column",
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    left: 56,
    overflow: "hidden",
    position: "fixed",
    right: 0,
    top: 0,
    transform: visible ? "translateX(0)" : "translateX(-100%)",
    transition: "transform 0.26s cubic-bezier(0.4, 0, 0.2, 1)",
    zIndex: 9999,
  };

  return createPortal(
    <aside aria-label="AI Agent" style={panelStyle}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          alignItems: "center",
          background: "#fff",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          flexShrink: 0,
          height: 54,
          justifyContent: "space-between",
          padding: "0 20px",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
          <span style={{ color: "#43b8c9", fontSize: 20, lineHeight: 1 }}>✦</span>
          <strong style={{ color: "#111827", fontSize: 15, letterSpacing: "-0.01em" }}>
            AI Agent
          </strong>
          <span
            style={{
              background:
                llmMode === "qwen"         ? "#dcfce7" :
                llmMode === "server-rules" ? "#dbeafe" : "#fef9c3",
              borderRadius: 999,
              color:
                llmMode === "qwen"         ? "#15803d" :
                llmMode === "server-rules" ? "#1d4ed8" : "#854d0e",
              fontSize: 11,
              fontWeight: 700,
              padding: "3px 9px",
            }}
          >
            {modelLabel}
          </span>
          {/* Active source badge */}
          {activeSource && (
            <span
              style={{
                alignItems: "center",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 999,
                color: "#1d4ed8",
                display: "inline-flex",
                fontSize: 11,
                fontWeight: 600,
                gap: 4,
                padding: "3px 9px",
              }}
              title={`현재 접속 소스: ${activeSource}`}
            >
              {sourceLoading ? "⟳" : "🔌"} {activeSource}
              <button
                onClick={() => { setActiveSource(null); setActiveSourceSchema(null); }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#6b7280",
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1,
                  padding: "0 0 0 2px",
                }}
                title="소스 연결 해제"
                type="button"
              >
                ×
              </button>
            </span>
          )}
        </div>
        <button
          aria-label="닫기"
          onClick={handleClose}
          style={{
            background: "transparent",
            border: "none",
            borderRadius: 8,
            color: "#6b7280",
            cursor: "pointer",
            fontSize: 20,
            height: 36,
            lineHeight: 1,
            width: 36,
          }}
          type="button"
        >
          ×
        </button>
      </header>

      {/* ── Body (sidebar + chat) ───────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>

        {/* ── Sidebar ───────────────────────────────────────────────────────── */}
        <nav
          style={{
            background: "#f1f3f5",
            borderRight: "1px solid #e5e7eb",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            overflow: "hidden",
            width: 248,
          }}
        >
          {/* New chat button */}
          <div style={{ flexShrink: 0, padding: "14px 14px 10px" }}>
            <button
              onClick={startNewChat}
              style={{
                alignItems: "center",
                background: "#fff",
                border: "1.5px dashed #43b8c9",
                borderRadius: 10,
                color: "#0369a1",
                cursor: "pointer",
                display: "flex",
                fontSize: 13,
                fontWeight: 600,
                gap: 6,
                padding: "10px 12px",
                width: "100%",
              }}
              type="button"
            >
              <span style={{ fontSize: 17, lineHeight: 1 }}>+</span>
              New chat
            </button>
          </div>

          {/* Search */}
          <div style={{ flexShrink: 0, padding: "0 14px 10px" }}>
            <input
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="대화 검색..."
              style={{
                background: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                boxSizing: "border-box",
                color: "#374151",
                fontSize: 12,
                padding: "8px 10px",
                width: "100%",
              }}
              type="text"
              value={searchQuery}
            />
          </div>

          {/* History list — scrollable, max 20, newest on top */}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 14px" }}>
            {sidebarGroups.length === 0 ? (
              <div
                style={{
                  color: "#9ca3af",
                  fontSize: 12,
                  padding: "20px 6px",
                  textAlign: "center",
                }}
              >
                {searchQuery ? "검색 결과 없음" : "아직 입력 기록이 없습니다"}
              </div>
            ) : (
              sidebarGroups.map(({ label, items }) => (
                <div key={label}>
                  <div
                    style={{
                      color: "#9ca3af",
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: "0.08em",
                      margin: "12px 4px 5px",
                      textTransform: "uppercase",
                    }}
                  >
                    {label}
                  </div>

                  {items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => fillFromHistory(item)}
                      style={{
                        background: "transparent",
                        border: "1px solid transparent",
                        borderRadius: 9,
                        color: "#111827",
                        cursor: "pointer",
                        display: "block",
                        marginBottom: 2,
                        padding: "7px 10px",
                        textAlign: "left",
                        transition: "background 0.1s",
                        width: "100%",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background =
                          "rgba(67,184,201,0.08)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.background =
                          "transparent";
                      }}
                      title={item.text}
                      type="button"
                    >
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: "#374151",
                        }}
                      >
                        {item.text}
                      </div>
                      <div
                        style={{ color: "#9ca3af", fontSize: 10, marginTop: 2 }}
                      >
                        {relativeTime(item.ts)}
                      </div>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </nav>

        {/* ── Main chat area ────────────────────────────────────────────────── */}
        <main
          style={{
            background: "#fff",
            display: "flex",
            flex: 1,
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          {/* Subheader */}
          <div
            style={{
              alignItems: "baseline",
              borderBottom: "1px solid #f3f4f6",
              display: "flex",
              flexShrink: 0,
              gap: 10,
              padding: "12px 24px",
            }}
          >
            <span style={{ color: "#111827", fontSize: 15, fontWeight: 700 }}>
              자연어 데이터 조회
            </span>
            <span style={{ color: "#9ca3af", fontSize: 12 }}>
              질문 → SQL 생성 → 실행 → 결과 표시
            </span>
          </div>

          {/* Messages */}
          <div
            style={{
              display: "flex",
              flex: 1,
              flexDirection: "column",
              overflowY: "auto",
              padding: "20px clamp(16px, 5vw, 64px)",
            }}
          >
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} onRunSql={runSqlDirectly} />
            ))}
            <div ref={bottomRef} />
          </div>

          {/* ── Composer ──────────────────────────────────────────────────── */}
          <form
            onSubmit={handleSubmit}
            style={{
              background: "#fff",
              borderTop: "1px solid #f3f4f6",
              flexShrink: 0,
              padding: "14px clamp(16px, 5vw, 64px) 18px",
            }}
          >
            <div
              style={{
                border: `1.5px solid ${busy ? "#d1d5db" : "#43b8c9"}`,
                borderRadius: 16,
                boxShadow: busy ? "none" : "0 2px 12px rgba(67,184,201,0.12)",
                overflow: "hidden",
                transition: "border-color 0.2s, box-shadow 0.2s",
              }}
            >
              <textarea
                disabled={busy}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder={
                  busy
                    ? "응답을 기다리는 중..."
                    : "질문을 입력하세요. 예: 가장 많이 주문한 고객은? (Enter 전송 / Shift+Enter 줄바꿈)"
                }
                ref={textareaRef}
                rows={2}
                style={{
                  background: busy ? "#f9fafb" : "#fff",
                  border: "none",
                  boxSizing: "border-box",
                  color: "#111827",
                  fontFamily: "inherit",
                  fontSize: 14,
                  lineHeight: 1.55,
                  outline: "none",
                  padding: "14px 16px 8px",
                  resize: "none",
                  transition: "background 0.2s",
                  width: "100%",
                }}
                value={input}
              />
              <div
                style={{
                  alignItems: "center",
                  background: busy ? "#f9fafb" : "#fff",
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "4px 10px 10px 14px",
                  transition: "background 0.2s",
                }}
              >
                <span style={{ color: "#9ca3af", fontSize: 11 }}>
                  {activeSource
                    ? `🔌 ${activeSource} 연결됨 · ${formatModelName(llmModel)}`
                    : llmMode === "qwen"
                    ? `${formatModelName(llmModel)} · Ollama`
                    : llmMode === "server-rules"
                    ? `${formatModelName(llmModel)} · rule-based fallback`
                    : "Frontend LLM-based NL2SQL"}
                </span>
                <button
                  aria-label="전송"
                  disabled={busy || !input.trim()}
                  style={{
                    alignItems: "center",
                    background:
                      busy || !input.trim() ? "#e5e7eb" : "#43b8c9",
                    border: "none",
                    borderRadius: "50%",
                    color: "#fff",
                    cursor: busy || !input.trim() ? "default" : "pointer",
                    display: "flex",
                    fontSize: 16,
                    fontWeight: 900,
                    height: 36,
                    justifyContent: "center",
                    transition: "background 0.15s",
                    width: 36,
                  }}
                  type="submit"
                >
                  {busy ? (
                    <span
                      style={{
                        animation: "aap-spin 0.8s linear infinite",
                        border: "2.5px solid rgba(255,255,255,0.3)",
                        borderRadius: "50%",
                        borderTopColor: "#fff",
                        display: "block",
                        height: 15,
                        width: 15,
                      }}
                    />
                  ) : (
                    "↑"
                  )}
                </button>
              </div>
            </div>
          </form>
        </main>
      </div>
    </aside>,
    document.body,
  );
};

export default AgentDrawer;
