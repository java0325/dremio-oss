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
 * SmartChart — auto-selects the best Recharts chart for a given JobResults payload.
 *
 * Chart selection priority:
 *   1. Single-value result  → MetricCard (big number)
 *   2. Date/month column + numerics → LineChart
 *   3. Categorical (≤12) + 1 numeric → BarChart  |  PieChart (≤8 slices, pct/rate hint)
 *   4. 2 numerics + optional categorical → ScatterChart
 *   5. Fallback → HorizontalBarChart
 */

import { useMemo, useState } from "react";
import {
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie, Cell,
  ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";
import type { JobResults } from "./agentApi";

// ── Colour palette ────────────────────────────────────────────────────────────

const PALETTE = [
  "#43b8c9", "#2f80ed", "#7c3aed", "#10b981", "#f59e0b",
  "#ef4444", "#8b5cf6", "#06b6d4", "#84cc16", "#f97316",
  "#ec4899", "#14b8a6",
];

const color = (i: number) => PALETTE[i % PALETTE.length];

// ── Column classification ─────────────────────────────────────────────────────

type ColKind = "date" | "numeric" | "pct" | "categorical" | "ignore";

const DATE_PAT   = /date|time|month|year|week|day|period|cohort|signup|order_date/i;
const NUM_TYPES  = new Set(["INTEGER", "BIGINT", "DOUBLE", "FLOAT", "DECIMAL", "NUMERIC"]);
const PCT_PAT    = /pct|percent|rate|ratio|share|portion/i;
const IGNORE_PAT = /id$|_id|uuid|email|phone|address/i;

function classifyCol(name: string, typeName: string): ColKind {
  if (IGNORE_PAT.test(name))              return "ignore";
  if (DATE_PAT.test(name))                return "date";
  if (NUM_TYPES.has(typeName.toUpperCase())) {
    return PCT_PAT.test(name) ? "pct" : "numeric";
  }
  return "categorical";
}

// ── toNumber helper ───────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(1) + "K";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function shortLabel(s: string, max = 14): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// ── Chart-type selector ───────────────────────────────────────────────────────

export type ChartKind =
  | "metric"
  | "line"
  | "bar"
  | "hbar"
  | "pie"
  | "scatter"
  | "multi-bar";

export function detectChartKind(data: JobResults): ChartKind {
  const { schema, rows } = data;
  if (!rows.length) return "bar";

  const cols = schema.map((c) => ({
    name: c.name,
    kind: classifyCol(c.name, c.type?.name ?? "VARCHAR"),
  }));

  const dateCols  = cols.filter((c) => c.kind === "date");
  const numCols   = cols.filter((c) => c.kind === "numeric" || c.kind === "pct");
  const catCols   = cols.filter((c) => c.kind === "categorical");
  const pctCols   = cols.filter((c) => c.kind === "pct");

  // Single numeric value → metric card
  if (rows.length === 1 && numCols.length >= 1 && catCols.length === 0) {
    return "metric";
  }

  // Date column present → line chart
  if (dateCols.length >= 1 && numCols.length >= 1) return "line";

  // Pie: categorical + 1 numeric, few rows, pct hint
  if (
    catCols.length === 1 &&
    (numCols.length === 1 || pctCols.length >= 1) &&
    rows.length <= 8
  ) {
    return "pie";
  }

  // Multi-series bar: categorical + multiple numerics
  if (catCols.length >= 1 && numCols.length >= 2) return "multi-bar";

  // Horizontal bar: categorical + 1 numeric, many rows
  if (catCols.length >= 1 && numCols.length === 1 && rows.length > 6) return "hbar";

  // Vertical bar: categorical + 1 numeric
  if (catCols.length >= 1 && numCols.length === 1) return "bar";

  // Scatter: 2+ numerics
  if (numCols.length >= 2) return "scatter";

  return "bar";
}

// ── Tooltip formatter ─────────────────────────────────────────────────────────

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
        fontSize: 12,
        padding: "10px 14px",
      }}
    >
      {label && (
        <div style={{ color: "#374151", fontWeight: 700, marginBottom: 6 }}>
          {label}
        </div>
      )}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.fill ?? p.stroke ?? color(i), marginTop: 3 }}>
          {p.name}: <strong>{fmtNum(Number(p.value))}</strong>
        </div>
      ))}
    </div>
  );
};

// ── Chart components ──────────────────────────────────────────────────────────

function MetricCard({ data }: { data: JobResults }) {
  const numCols = data.schema.filter(
    (c) => NUM_TYPES.has((c.type?.name ?? "").toUpperCase()),
  );
  const row = data.rows[0] ?? {};
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 14,
        marginTop: 12,
        justifyContent: "center",
      }}
    >
      {numCols.map((col, i) => (
        <div
          key={col.name}
          style={{
            background: `linear-gradient(135deg, ${color(i)}20, ${color(i)}08)`,
            border: `1px solid ${color(i)}30`,
            borderRadius: 14,
            flex: "1 1 140px",
            padding: "18px 20px",
            textAlign: "center",
          }}
        >
          <div style={{ color: "#6b7280", fontSize: 11, fontWeight: 700, marginBottom: 8, textTransform: "uppercase" }}>
            {col.name.replace(/_/g, " ")}
          </div>
          <div style={{ color: color(i), fontSize: 28, fontWeight: 800 }}>
            {fmtNum(toNum(row[col.name]))}
          </div>
        </div>
      ))}
    </div>
  );
}

function buildChartData(data: JobResults) {
  const { schema, rows } = data;
  const cols = schema.map((c) => ({
    name: c.name,
    kind: classifyCol(c.name, c.type?.name ?? "VARCHAR"),
  }));
  const dateCol = cols.find((c) => c.kind === "date");
  const catCol  = cols.find((c) => c.kind === "categorical");
  const numCols = cols.filter((c) => c.kind === "numeric" || c.kind === "pct");

  const labelKey = (dateCol ?? catCol)?.name ?? schema[0]?.name ?? "";
  const chartRows = rows.map((row) => {
    const entry: Record<string, number | string> = {
      _label: shortLabel(String(row[labelKey] ?? ""), 18),
    };
    for (const col of numCols) {
      entry[col.name] = toNum(row[col.name]);
    }
    return entry;
  });

  return { chartRows, numCols, labelKey };
}

function ChartLine({ data }: { data: JobResults }) {
  const { chartRows, numCols } = buildChartData(data);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartRows} margin={{ top: 8, right: 20, bottom: 40, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f1f3" />
        <XAxis dataKey="_label" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtNum} width={55} />
        <Tooltip content={<CustomTooltip />} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        {numCols.map((col, i) => (
          <Line
            key={col.name}
            type="monotone"
            dataKey={col.name}
            stroke={color(i)}
            strokeWidth={2.5}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function ChartBar({ data, horizontal }: { data: JobResults; horizontal?: boolean }) {
  const { chartRows, numCols } = buildChartData(data);
  return (
    <ResponsiveContainer width="100%" height={Math.max(260, horizontal ? chartRows.length * 32 : 260)}>
      <BarChart
        data={chartRows}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 8, right: 20, bottom: horizontal ? 8 : 44, left: horizontal ? 80 : 10 }}
        barCategoryGap="30%"
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f1f3" horizontal={!horizontal} vertical={horizontal} />
        {horizontal ? (
          <>
            <YAxis dataKey="_label" type="category" tick={{ fontSize: 11 }} width={80} />
            <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={fmtNum} />
          </>
        ) : (
          <>
            <XAxis dataKey="_label" tick={{ fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtNum} width={55} />
          </>
        )}
        <Tooltip content={<CustomTooltip />} />
        {numCols.length > 1 && <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />}
        {numCols.map((col, i) => (
          <Bar key={col.name} dataKey={col.name} fill={color(i)} radius={[4, 4, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function ChartMultiBar({ data }: { data: JobResults }) {
  return <ChartBar data={data} />;
}

const RADIAN = Math.PI / 180;
function ChartPie({ data }: { data: JobResults }) {
  const { chartRows, numCols } = buildChartData(data);
  const key = numCols[0]?.name ?? "";
  const total = chartRows.reduce((s, r) => s + (r[key] as number), 0);

  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie
          data={chartRows}
          dataKey={key}
          nameKey="_label"
          cx="50%"
          cy="50%"
          outerRadius={90}
          labelLine={false}
          label={({ cx, cy, midAngle, innerRadius, outerRadius, value }) => {
            const pct = total ? ((value / total) * 100).toFixed(1) : 0;
            if (Number(pct) < 4) return null;
            const r = innerRadius + (outerRadius - innerRadius) * 0.5;
            const x = cx + r * Math.cos(-midAngle * RADIAN);
            const y = cy + r * Math.sin(-midAngle * RADIAN);
            return (
              <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700}>
                {pct}%
              </text>
            );
          }}
        >
          {chartRows.map((_, i) => (
            <Cell key={i} fill={color(i)} />
          ))}
        </Pie>
        <Tooltip formatter={(v: any) => fmtNum(Number(v))} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function ChartScatter({ data }: { data: JobResults }) {
  const { schema, rows } = data;
  const numCols = schema
    .filter((c) => NUM_TYPES.has((c.type?.name ?? "").toUpperCase()))
    .slice(0, 2);
  if (numCols.length < 2) return <ChartBar data={data} />;

  const [xKey, yKey] = [numCols[0].name, numCols[1].name];
  const catCol = schema.find(
    (c) => !NUM_TYPES.has((c.type?.name ?? "").toUpperCase()) && !IGNORE_PAT.test(c.name),
  );

  const points = rows.map((r) => ({
    x: toNum(r[xKey]),
    y: toNum(r[yKey]),
    name: catCol ? shortLabel(String(r[catCol.name] ?? ""), 14) : "",
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ScatterChart margin={{ top: 8, right: 20, bottom: 20, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f1f3" />
        <XAxis dataKey="x" name={xKey} tick={{ fontSize: 11 }} tickFormatter={fmtNum} label={{ value: xKey, position: "insideBottom", offset: -10, fontSize: 11 }} />
        <YAxis dataKey="y" name={yKey} tick={{ fontSize: 11 }} tickFormatter={fmtNum} width={55} />
        <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0]?.payload;
          return (
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 12, padding: "8px 12px" }}>
              {p?.name && <div style={{ fontWeight: 700, marginBottom: 4 }}>{p.name}</div>}
              <div>{xKey}: <strong>{fmtNum(p?.x)}</strong></div>
              <div>{yKey}: <strong>{fmtNum(p?.y)}</strong></div>
            </div>
          );
        }} />
        <Scatter data={points} fill={color(0)} opacity={0.75} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

// ── Switcher buttons ──────────────────────────────────────────────────────────

const CHART_OPTIONS: { kind: ChartKind; label: string }[] = [
  { kind: "bar",       label: "막대" },
  { kind: "hbar",      label: "가로막대" },
  { kind: "line",      label: "선" },
  { kind: "pie",       label: "파이" },
  { kind: "scatter",   label: "산점도" },
  { kind: "multi-bar", label: "복합막대" },
  { kind: "metric",    label: "지표" },
];

// ── Main SmartChart export ────────────────────────────────────────────────────

export function SmartChart({ data }: { data: JobResults }) {
  const autoKind = useMemo(() => detectChartKind(data), [data]);
  const [kind, setKind] = useState<ChartKind>(autoKind);

  if (!data.rows.length) return null;

  const numericCols = data.schema.filter((c) =>
    NUM_TYPES.has((c.type?.name ?? "").toUpperCase()),
  );
  if (!numericCols.length) return null;

  return (
    <div style={{ marginTop: 16 }}>
      {/* Chart type switcher */}
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 12,
        }}
      >
        <span style={{ color: "#6b7280", fontSize: 11, fontWeight: 700, marginRight: 4 }}>
          차트 유형
        </span>
        {CHART_OPTIONS.map((opt) => (
          <button
            key={opt.kind}
            onClick={() => setKind(opt.kind)}
            style={{
              background: kind === opt.kind ? "#43b8c9" : "#f3f4f6",
              border: "none",
              borderRadius: 999,
              color: kind === opt.kind ? "#fff" : "#374151",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: kind === opt.kind ? 700 : 500,
              padding: "4px 10px",
              transition: "background 0.15s",
            }}
            type="button"
          >
            {opt.label}
            {opt.kind === autoKind && kind !== opt.kind && (
              <span style={{ color: "#9ca3af", marginLeft: 3 }}>✦</span>
            )}
          </button>
        ))}
        <span style={{ color: "#9ca3af", fontSize: 10, marginLeft: 4 }}>
          ✦ 자동 추천
        </span>
      </div>

      {/* Chart rendering */}
      <div
        style={{
          background: "#fafafa",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: "16px 8px 8px",
        }}
      >
        {kind === "metric"    && <MetricCard  data={data} />}
        {kind === "line"      && <ChartLine   data={data} />}
        {kind === "bar"       && <ChartBar    data={data} />}
        {kind === "hbar"      && <ChartBar    data={data} horizontal />}
        {kind === "pie"       && <ChartPie    data={data} />}
        {kind === "scatter"   && <ChartScatter data={data} />}
        {kind === "multi-bar" && <ChartMultiBar data={data} />}
      </div>
    </div>
  );
}
