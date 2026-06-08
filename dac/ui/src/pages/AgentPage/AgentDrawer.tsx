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
import { submitSql, waitForJob, fetchJobResults } from "./agentApi";
import type { JobResults, JobStatus } from "./agentApi";
import { naturalLanguageToSql } from "./nlToSql";
import { SmartChart } from "./SmartChart";
import "./AgentDrawer.less";

// ── LLM ───────────────────────────────────────────────────────────────────────

const LLM_BASE = "http://localhost:8765";

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
): Promise<LlmResponse> {
  const res = await fetch(`${LLM_BASE}/nl2sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, history }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`LLM 서버 오류 (${res.status})`);
  return res.json();
}

async function checkLLMMode(): Promise<LlmMode> {
  try {
    const res = await fetch(`${LLM_BASE}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return "offline";
    const data = await res.json();
    if (data.ollama === true && data.model_ready === true) return "qwen";
    if (data.status === "degraded" || data.fallback === "rule-based") return "server-rules";
    return "offline";
  } catch {
    return "offline";
  }
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

const ANALYSIS_RECOMMENDATIONS: Suggestion[] = [
  // ── Basic ───────────────────────────────────────────────────────────────────
  {
    title: "데이터 전체 현황",
    description: "4개 테이블의 행 수를 한눈에 확인합니다.",
    difficulty: 1,
    sql: `SELECT 'customers'   AS table_name, COUNT(*) AS row_count FROM ${H}.customers
UNION ALL SELECT 'products',    COUNT(*) FROM ${H}.products
UNION ALL SELECT 'orders',      COUNT(*) FROM ${H}.orders
UNION ALL SELECT 'order_items', COUNT(*) FROM ${H}.order_items`,
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
    title: "코호트 분석 (가입월 × 주문월)",
    description: "고객 가입 월과 주문 월의 교차 분석으로 리텐션 패턴을 파악합니다.",
    difficulty: 3,
    sql: `SELECT
  DATE_TRUNC('MONTH', CAST(c.signup_date AS DATE))   AS signup_cohort,
  DATE_TRUNC('MONTH', CAST(o.order_date  AS DATE))   AS order_month,
  COUNT(DISTINCT c.customer_id)                       AS active_customers,
  COUNT(o.order_id)                                   AS orders,
  SUM(CAST(o.total_amount AS DOUBLE))                 AS revenue
FROM ${H}.customers c
JOIN ${H}.orders o ON c.customer_id = o.customer_id
WHERE o.status = 'Completed'
GROUP BY
  DATE_TRUNC('MONTH', CAST(c.signup_date AS DATE)),
  DATE_TRUNC('MONTH', CAST(o.order_date  AS DATE))
ORDER BY signup_cohort, order_month`,
    insight: "가입 후 몇 개월 만에 재구매하는지, 어느 코호트가 LTV가 높은지 측정",
  },
];

/** Detect general chat intent (greeting, help, etc.) */
function detectChatIntent(text: string): string | null {
  const lo = text.toLowerCase().trim();
  if (/^(안녕|hello|hi\b|hey\b|반가|반갑|좋은\s*(아침|오후|저녁))/.test(lo)) {
    return "안녕하세요! 저는 Dremio AI Agent입니다. 샘플DB에 대해 자연어로 질문하시면 데이터를 조회해 드립니다.\n\n예: \"고객 목록을 보여줘\", \"총 매출은 얼마야?\", \"가장 많이 팔린 상품은?\"";
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
      "🔍 필터 · 조건",
      "  · 재고가 20개 미만인 상품은?",
      "  · 결제 수단별 주문 건수는?",
      "",
      "💡 직접 SQL 입력도 가능합니다.",
      '  · SELECT * FROM "@dremio1".orders LIMIT 10',
    ].join("\n");
  }
  if (/감사|고마|thanks|thank you/.test(lo)) {
    return "천만에요! 다른 데이터가 궁금하시면 언제든지 질문해 주세요. 😊";
  }
  if (/어떤\s*(테이블|데이터)이\s*있|어떤\s*데이터를/.test(lo)) {
    return [
      "샘플DB에는 다음 4개 테이블이 있습니다:",
      "",
      "① customers  – 고객 정보 (이름, 이메일, 도시, 국가, 나이)",
      "② products   – 상품 정보 (카테고리, 가격, 재고)",
      "③ orders     – 주문 정보 (날짜, 상태, 금액, 결제수단)",
      "④ order_items – 주문 상세 (수량, 단가, 할인율)",
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
  const [tab, setTab] = useState<"table" | "chart">("table");
  const chartAvailable = useMemo(
    () =>
      data.rows?.length > 0 &&
      data.schema?.some((c) =>
        ["INTEGER", "BIGINT", "FLOAT", "DOUBLE", "DECIMAL", "REAL"].includes(
          (c.type?.name ?? "").toUpperCase(),
        ),
      ),
    [data],
  );

  const tabBtn = (id: "table" | "chart", label: string) => (
    <button
      disabled={id === "chart" && !chartAvailable}
      onClick={() => setTab(id)}
      style={{
        background: tab === id ? "#43b8c9" : "transparent",
        border: "none",
        borderRadius: 999,
        color: tab === id ? "#fff" : "#6b7280",
        cursor: id === "chart" && !chartAvailable ? "not-allowed" : "pointer",
        opacity: id === "chart" && !chartAvailable ? 0.45 : 1,
        fontSize: 12,
        fontWeight: tab === id ? 700 : 500,
        padding: "4px 14px",
        transition: "background 0.15s, color 0.15s",
      }}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <div style={{ marginTop: 14 }}>
      {/* Tab bar */}
      <div
        style={{
          alignItems: "center",
          background: "#f3f4f6",
          borderRadius: 999,
          display: "inline-flex",
          gap: 2,
          marginBottom: 10,
          padding: 3,
        }}
      >
        {tabBtn("chart", "📊 차트")}
        {tabBtn("table", "📋 표")}
      </div>

      {tab === "chart" &&
        (chartAvailable ? (
          <SmartChart data={data} />
        ) : (
          <p style={{ color: "#6b7280", fontSize: 12, marginTop: 6 }}>
            차트를 생성할 수 있는 숫자형 컬럼이 없어 표로 표시합니다.
          </p>
        ))}
      {tab === "table" && <ResultTable data={data} />}
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
        "자연어로 질문하시면 샘플DB 데이터를 자동으로 조회해 드립니다.",
        "",
        "예시:",
        '  · "고객 목록을 보여줘"',
        '  · "총 매출이 얼마야?"',
        '  · "가장 많이 판매된 상품은?"',
        '  · "카테고리별 상품 수를 알려줘"',
        '  · "월별 매출 추이 보여줘"',
        "",
        '"도움말"을 입력하면 전체 기능을 확인할 수 있습니다.',
      ].join("\n"),
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [llmMode, setLlmMode] = useState<LlmMode | null>(null);
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
    if (mounted) checkLLMMode().then(setLlmMode);
  }, [mounted]);

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
    if (llmMode === "qwen")         return "Qwen3 8B";
    if (llmMode === "server-rules") return "LLM Server";
    return "LLM-based";
  }, [llmMode]);

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
          patchLast({ phase: "error", jobStatus: undefined, error: finalJob.errorMessage ?? "쿼리 실패" });
          return;
        }
        if (finalJob.state === "CANCELLED") {
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
        patchLast({ phase: "error", jobStatus: undefined, error: err?.message ?? "오류 발생" });
      } finally {
        setBusy(false);
        focusInput();
      }
    },
    [busy, patchLast, focusInput],
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
      // ── Step 0: Analysis recommendation intent ─────────────────────────────
      if (detectAnalysisIntent(prompt)) {
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
        } catch {
          patchLast({
            phase: "chat",
            jobStatus: undefined,
            text: "샘플DB 기반으로 아래 분석 시나리오를 추천합니다.\n▶ 실행 버튼을 클릭하면 즉시 쿼리를 실행합니다.",
            suggestions: ANALYSIS_RECOMMENDATIONS,
          });
        }
        return;
      }

      // ── Step 1: Check general chat intent ──────────────────────────────────
      const chatReply = detectChatIntent(prompt);
      if (chatReply) {
        patchLast({ text: chatReply, phase: "chat" });
        return;
      }

      // ── Step 2: Attempt rule-based Text2SQL first ──────────────────────────
      patchLast({ phase: "generating", text: "질문을 분석하고 있습니다..." });
      const ruleResult = naturalLanguageToSql(prompt);

      let sql: string;
      let explanation: string;

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
        patchLast({
          phase: "error",
          jobStatus: undefined,
          error: finalJob.errorMessage ?? "쿼리 실행에 실패했습니다.",
          text: explanation,
        });
        return;
      }
      if (finalJob.state === "CANCELLED") {
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
                  {llmMode === "qwen"
                    ? "Qwen3 8B · Ollama"
                    : llmMode === "server-rules"
                    ? "LLM Server · rule-based fallback"
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
