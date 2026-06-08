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
 * Deterministic Text-to-SQL converter for the sample Dremio dataset.
 *
 * Actual table schemas (confirmed against live Dremio):
 *   "@dremio1".customers  – customer_id, name, email, city, country, signup_date, tier
 *   "@dremio1".products   – product_id, name, category, price, stock_qty, supplier
 *   "@dremio1".orders     – order_id, customer_id, order_date, status, total_amount, payment_method
 *   "@dremio1".order_items – item_id, order_id, product_id, quantity, unit_price, discount_pct
 *
 * status values  : 'Pending' | 'Completed' | 'Cancelled'
 * tier values    : 'Gold' | 'Silver' | 'Bronze'
 *
 * All numeric columns are VARCHAR (from CSV upload), so explicit CAST is required.
 */

// ── Constants ──────────────────────────────────────────────────────────────────

const SQL_PREFIXES = [
  "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH",
  "CREATE", "INSERT", "UPDATE", "DELETE", "DROP", "ALTER",
];

export type NlResult =
  | { kind: "sql"; sql: string; explanation: string }
  | { kind: "unrecognized" };

const H = '"@dremio1"';  // home namespace

const T = {
  customers: `${H}.customers`,
  products:  `${H}.products`,
  orders:    `${H}.orders`,
  items:     `${H}.order_items`,
} as const;

const TABLE_OVERVIEW = `
SELECT 'customers'   AS table_name, COUNT(*) AS row_count FROM ${T.customers}
UNION ALL
SELECT 'products'    AS table_name, COUNT(*) AS row_count FROM ${T.products}
UNION ALL
SELECT 'orders'      AS table_name, COUNT(*) AS row_count FROM ${T.orders}
UNION ALL
SELECT 'order_items' AS table_name, COUNT(*) AS row_count FROM ${T.items}
`.trim();

// ── Helpers ────────────────────────────────────────────────────────────────────

type Rule = {
  test: RegExp | ((lo: string) => boolean);
  sql: string | ((lo: string) => string);
  explanation: string;
};

const has = (lo: string, words: string[]) => words.some((w) => lo.includes(w));

const limit = (lo: string, fallback = 100) => {
  const m = /(\d+)\s*(?:개|건|명|rows?|records?)/i.exec(lo);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 500) : fallback;
};

/** Identify which table the question is most likely about */
const tableOf = (lo: string) => {
  if (/order[_\s-]?items?|주문\s*(상세|항목|아이템)/i.test(lo))
    return { sql: T.items,     label: "주문 상세" };
  if (/customers?|고객|회원/i.test(lo))
    return { sql: T.customers, label: "고객" };
  if (/products?|상품|제품|재고|카테고리/i.test(lo))
    return { sql: T.products,  label: "상품" };
  if (/orders?|주문|매출|결제|상태/i.test(lo))
    return { sql: T.orders,    label: "주문" };
  return null;
};

/** Check if query is clearly data-oriented */
const isDataQ = (lo: string) =>
  has(lo, [
    "데이터", "테이블", "샘플", "db", "database",
    "조회", "보여", "알려", "분석", "통계", "집계",
    "목록", "건수", "개수", "몇", "총", "합계", "평균",
    "매출", "주문", "고객", "상품", "제품", "카테고리",
    "재고", "결제", "상태", "도시", "국가", "등급", "티어",
    "고르", "많이", "가장", "상위", "하위",
    "customer", "product", "order", "revenue", "sales",
    "count", "average", "avg", "sum", "top", "most", "list", "show",
  ]);

// ── Sample-data rules (priority order) ────────────────────────────────────────

const rules: Rule[] = [

  // ── Overview ─────────────────────────────────────────────────────────────────
  {
    test: (lo) => /샘플|sample/i.test(lo) && /(테이블|데이터|db|overview|현황|요약|구성)/i.test(lo),
    sql: TABLE_OVERVIEW,
    explanation: "샘플DB 테이블별 데이터 건수를 요약합니다.",
  },

  // ── Customer queries ──────────────────────────────────────────────────────────
  {
    test: (lo) => /고객|customer/i.test(lo) && /(목록|리스트|보여|조회|전체|all|list)/i.test(lo),
    sql: (lo) => `SELECT * FROM ${T.customers} ORDER BY customer_id LIMIT ${limit(lo)}`,
    explanation: "고객 전체 목록을 조회합니다.",
  },
  {
    test: (lo) => /(골드|gold)\s*(고객|회원|등급)/i.test(lo) || /tier.*gold/i.test(lo) || /고객.*골드|회원.*gold/i.test(lo),
    sql: `SELECT * FROM ${T.customers} WHERE tier = 'Gold' ORDER BY name LIMIT 100`,
    explanation: "Gold 등급 고객 목록을 조회합니다.",
  },
  {
    test: (lo) => /(실버|silver)\s*(고객|회원|등급)/i.test(lo) || /tier.*silver/i.test(lo),
    sql: `SELECT * FROM ${T.customers} WHERE tier = 'Silver' ORDER BY name LIMIT 100`,
    explanation: "Silver 등급 고객 목록을 조회합니다.",
  },
  {
    test: (lo) => /(브론즈|bronze)\s*(고객|회원|등급)/i.test(lo) || /tier.*bronze/i.test(lo),
    sql: `SELECT * FROM ${T.customers} WHERE tier = 'Bronze' ORDER BY name LIMIT 100`,
    explanation: "Bronze 등급 고객 목록을 조회합니다.",
  },
  {
    test: (lo) => /등급|티어|tier/i.test(lo) && /(별|현황|분포|건수|수|count)/i.test(lo),
    sql: `
SELECT
  tier,
  COUNT(*) AS customer_count
FROM ${T.customers}
GROUP BY tier
ORDER BY customer_count DESC
`.trim(),
    explanation: "고객 등급(tier)별 인원 수를 집계합니다.",
  },
  {
    test: (lo) => /도시|city/i.test(lo) && /(고객|customer|분포|별|건수)/i.test(lo),
    sql: `
SELECT
  city,
  country,
  COUNT(*) AS customer_count
FROM ${T.customers}
GROUP BY city, country
ORDER BY customer_count DESC
`.trim(),
    explanation: "도시별 고객 수를 집계합니다.",
  },
  {
    test: (lo) => /국가|country/i.test(lo) && /(고객|customer|분포|별|건수)/i.test(lo),
    sql: `
SELECT
  country,
  COUNT(*) AS customer_count
FROM ${T.customers}
GROUP BY country
ORDER BY customer_count DESC
`.trim(),
    explanation: "국가별 고객 수를 집계합니다.",
  },
  {
    test: (lo) =>
      /(가장|최다|top|most)/i.test(lo) &&
      /고객|customer/i.test(lo) &&
      /주문|구매|order|buy/i.test(lo),
    sql: `
SELECT
  c.customer_id,
  c.name,
  c.email,
  c.tier,
  COUNT(o.order_id)              AS order_count,
  SUM(CAST(o.total_amount AS DOUBLE)) AS total_spent
FROM ${T.customers} c
JOIN ${T.orders} o ON c.customer_id = o.customer_id
GROUP BY c.customer_id, c.name, c.email, c.tier
ORDER BY order_count DESC, total_spent DESC
LIMIT 10
`.trim(),
    explanation: "주문이 가장 많은 고객 상위 10명을 조회합니다.",
  },

  // ── Product queries ────────────────────────────────────────────────────────────
  {
    test: (lo) => /상품|제품|product/i.test(lo) && /(목록|리스트|보여|조회|전체|all|list)/i.test(lo),
    sql: (lo) => `SELECT * FROM ${T.products} ORDER BY product_id LIMIT ${limit(lo)}`,
    explanation: "상품 전체 목록을 조회합니다.",
  },
  {
    test: (lo) => /카테고리|category/i.test(lo) && /(별|수|개수|건수|분포|count)/i.test(lo),
    sql: `
SELECT
  category,
  COUNT(*) AS product_count,
  AVG(CAST(price AS DOUBLE))     AS avg_price,
  SUM(CAST(stock_qty AS INTEGER)) AS total_stock
FROM ${T.products}
GROUP BY category
ORDER BY product_count DESC
`.trim(),
    explanation: "카테고리별 상품 수, 평균 가격, 총 재고를 집계합니다.",
  },
  {
    test: (lo) => /재고|stock/i.test(lo) && /(부족|적은|낮은|미만|under|low)/i.test(lo),
    sql: (lo) => {
      const n = limit(lo, 20);
      return `
SELECT *
FROM ${T.products}
WHERE CAST(stock_qty AS INTEGER) < ${n}
ORDER BY CAST(stock_qty AS INTEGER) ASC
LIMIT 100
`.trim();
    },
    explanation: "재고가 기준치보다 낮은 상품을 조회합니다.",
  },
  {
    test: (lo) =>
      /(가장|많이|최다|top|most|best)/i.test(lo) &&
      /상품|제품|product/i.test(lo) &&
      /팔|판매|sold|sales|order/i.test(lo),
    sql: `
SELECT
  p.product_id,
  p.name,
  p.category,
  SUM(CAST(oi.quantity AS INTEGER))                                      AS total_qty,
  SUM(CAST(oi.quantity AS INTEGER) * CAST(oi.unit_price AS DOUBLE)
      * (1 - CAST(oi.discount_pct AS DOUBLE) / 100))                    AS total_sales
FROM ${T.items} oi
JOIN ${T.products} p ON oi.product_id = p.product_id
GROUP BY p.product_id, p.name, p.category
ORDER BY total_qty DESC, total_sales DESC
LIMIT 10
`.trim(),
    explanation: "가장 많이 판매된 상품 상위 10개를 조회합니다.",
  },

  // ── Order queries ──────────────────────────────────────────────────────────────
  {
    test: (lo) =>
      /주문|order/i.test(lo) &&
      /(목록|리스트|보여|조회|전체|all|list)/i.test(lo) &&
      !/상세|item/i.test(lo),
    sql: (lo) => `SELECT * FROM ${T.orders} ORDER BY order_date DESC LIMIT ${limit(lo)}`,
    explanation: "최근 주문 목록을 조회합니다.",
  },
  {
    test: (lo) =>
      /완료|completed/i.test(lo) && /주문|order/i.test(lo),
    sql: `SELECT * FROM ${T.orders} WHERE status = 'Completed' ORDER BY order_date DESC LIMIT 100`,
    explanation: "완료된 주문 목록을 조회합니다.",
  },
  {
    test: (lo) =>
      /취소|cancel/i.test(lo) && /주문|order/i.test(lo),
    sql: `SELECT * FROM ${T.orders} WHERE status = 'Cancelled' ORDER BY order_date DESC LIMIT 100`,
    explanation: "취소된 주문 목록을 조회합니다.",
  },
  {
    test: (lo) =>
      /대기|pending/i.test(lo) && /주문|order/i.test(lo),
    sql: `SELECT * FROM ${T.orders} WHERE status = 'Pending' ORDER BY order_date DESC LIMIT 100`,
    explanation: "대기 중인 주문 목록을 조회합니다.",
  },
  {
    test: (lo) =>
      /상태|status/i.test(lo) && /(주문|order|별|건수|현황)/i.test(lo),
    sql: `
SELECT
  status,
  COUNT(*) AS order_count,
  SUM(CAST(total_amount AS DOUBLE)) AS total_amount
FROM ${T.orders}
GROUP BY status
ORDER BY order_count DESC
`.trim(),
    explanation: "주문 상태별 건수와 금액을 집계합니다.",
  },
  {
    test: (lo) =>
      /결제|payment/i.test(lo) && /(방법|수단|별|건수|분포)/i.test(lo),
    sql: `
SELECT
  payment_method,
  COUNT(*) AS order_count,
  SUM(CAST(total_amount AS DOUBLE)) AS total_amount
FROM ${T.orders}
GROUP BY payment_method
ORDER BY order_count DESC
`.trim(),
    explanation: "결제 수단별 주문 건수와 금액을 집계합니다.",
  },

  // ── Revenue / aggregation queries ──────────────────────────────────────────────
  {
    test: (lo) =>
      /매출|revenue|sales/i.test(lo) && /(총|합계|전체|sum|total)/i.test(lo),
    sql: `
SELECT
  COUNT(*)                              AS order_count,
  SUM(CAST(total_amount AS DOUBLE))     AS total_revenue,
  AVG(CAST(total_amount AS DOUBLE))     AS avg_order_amount,
  MAX(CAST(total_amount AS DOUBLE))     AS max_order_amount
FROM ${T.orders}
WHERE status = 'Completed'
`.trim(),
    explanation: "완료 주문 기준 총 매출, 주문 수, 평균 · 최대 주문 금액을 계산합니다.",
  },
  {
    test: (lo) =>
      /평균|average|avg/i.test(lo) && /주문|금액|amount|order/i.test(lo),
    sql: `
SELECT
  AVG(CAST(total_amount AS DOUBLE)) AS avg_amount,
  MIN(CAST(total_amount AS DOUBLE)) AS min_amount,
  MAX(CAST(total_amount AS DOUBLE)) AS max_amount,
  COUNT(*)                          AS order_count
FROM ${T.orders}
`.trim(),
    explanation: "주문 금액 평균, 최소, 최대값을 계산합니다.",
  },
  {
    test: (lo) =>
      /월별|month|monthly/i.test(lo) && /매출|주문|revenue|order/i.test(lo),
    sql: `
SELECT
  DATE_TRUNC('MONTH', CAST(order_date AS DATE)) AS order_month,
  COUNT(*)                                       AS order_count,
  SUM(CAST(total_amount AS DOUBLE))              AS total_revenue,
  AVG(CAST(total_amount AS DOUBLE))              AS avg_order_amount
FROM ${T.orders}
WHERE status = 'Completed'
GROUP BY DATE_TRUNC('MONTH', CAST(order_date AS DATE))
ORDER BY DATE_TRUNC('MONTH', CAST(order_date AS DATE)) ASC
`.trim(),
    explanation: "월별 주문 건수와 매출을 집계합니다.",
  },

  // ── Order items ────────────────────────────────────────────────────────────────
  {
    test: (lo) =>
      /주문\s*(상세|항목|아이템)|order[_\s-]?items?/i.test(lo) &&
      /(목록|보여|조회|list|show)/i.test(lo),
    sql: (lo) => `SELECT * FROM ${T.items} LIMIT ${limit(lo)}`,
    explanation: "주문 상세 목록을 조회합니다.",
  },
];

// ── Main export ────────────────────────────────────────────────────────────────

export function naturalLanguageToSql(input: string): NlResult {
  const raw = input.trim();
  const up  = raw.toUpperCase();

  // Pass raw SQL through directly
  if (SQL_PREFIXES.some((p) => up.startsWith(p + " ") || up === p)) {
    return { kind: "sql", sql: raw, explanation: "SQL 쿼리를 직접 실행합니다." };
  }

  const lo = raw.toLowerCase();

  // ── Try specific rules first ───────────────────────────────────────────────
  for (const rule of rules) {
    const matched =
      rule.test instanceof RegExp ? rule.test.test(lo) : rule.test(lo);
    if (matched) {
      return {
        kind: "sql",
        sql: typeof rule.sql === "function" ? rule.sql(lo) : rule.sql,
        explanation: rule.explanation,
      };
    }
  }

  // ── SHOW TABLES ────────────────────────────────────────────────────────────
  if (
    /테이블\s*(목록|리스트|보여|알려|조회)/u.test(lo) ||
    /show\s+tables?/i.test(lo) ||
    /어떤\s*테이블|무슨\s*테이블/u.test(lo)
  ) {
    return { kind: "sql", sql: TABLE_OVERVIEW, explanation: "테이블 목록과 행 수를 조회합니다." };
  }

  // ── DESCRIBE <table> ───────────────────────────────────────────────────────
  if (/구조|컬럼|스키마|describe|desc/i.test(lo)) {
    const tbl = tableOf(lo);
    if (tbl) {
      return {
        kind: "sql",
        sql: `DESCRIBE ${tbl.sql}`,
        explanation: `${tbl.label} 테이블의 컬럼 구조를 조회합니다.`,
      };
    }
  }

  // ── Generic data question fallback ────────────────────────────────────────
  if (isDataQ(lo)) {
    const tbl = tableOf(lo);
    if (tbl) {
      return {
        kind: "sql",
        sql: `SELECT * FROM ${tbl.sql} LIMIT ${limit(lo)}`,
        explanation: `${tbl.label} 테이블에서 최대 ${limit(lo)}건을 조회합니다.`,
      };
    }
    return {
      kind: "sql",
      sql: TABLE_OVERVIEW,
      explanation: "데이터 조회 의도가 감지되어 샘플DB 전체 현황을 먼저 조회합니다.",
    };
  }

  return { kind: "unrecognized" };
}
