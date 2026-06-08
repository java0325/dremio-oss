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
  useEffect,
  useRef,
  useState,
} from "react";
// @ts-ignore
import DocumentTitle from "react-document-title";
import { SonarSideNav } from "#oss/exports/components/SideNav/SonarSideNav";
import { intl } from "#oss/utils/intl";
import { submitSql, waitForJob, fetchJobResults } from "./agentApi";
import type { JobStatus, JobResults } from "./agentApi";
import { naturalLanguageToSql } from "./nlToSql";
import "./AgentPage.less";

// ── Types ─────────────────────────────────────────────────────────────────────

type MessageRole = "user" | "agent" | "system";

type ResultPayload = {
  sql: string;
  jobId: string;
  data: JobResults;
};

type Message = {
  id: number;
  role: MessageRole;
  text: string;
  status?: JobStatus;
  result?: ResultPayload;
  error?: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Partial<Record<JobStatus, string>> = {
  PLANNING: "쿼리 계획 중…",
  RUNNING: "실행 중…",
  STARTING: "시작 중…",
  QUEUED: "대기 중…",
  ENQUEUED: "대기 중…",
  METADATA_RETRIEVAL: "메타데이터 로드 중…",
  EXECUTION_PLANNING: "실행 계획 수립 중…",
};

const statusLabel = (s: JobStatus) => STATUS_LABEL[s] ?? s;

let _msgId = 100;
const nextId = () => ++_msgId;

const WELCOME: Message = {
  id: nextId(),
  role: "system",
  text: [
    "안녕하세요! Dremio AI Agent입니다.",
    "자연어로 DB를 조회하거나 직접 SQL을 입력할 수 있습니다.",
    "",
    "예시:",
    "  • 테이블 목록 보여줘",
    "  • 스키마 목록 조회",
    "  • Samples.samples.dremio.com.\"SF weather 2018-2019.csv\" 데이터 조회해줘",
    "  • SELECT * FROM sys.options LIMIT 10",
    "  • SELECT count(*) FROM INFORMATION_SCHEMA.TABLES",
  ].join("\n"),
};

// ── Result table ──────────────────────────────────────────────────────────────

function ResultTable({ data }: { data: JobResults }) {
  const { schema, rows, rowCount } = data;
  if (!rows?.length) {
    return <p className="agent-result__empty">결과 없음 (0 rows)</p>;
  }
  return (
    <div className="agent-result__table-wrap">
      <p className="agent-result__meta">
        총 {rowCount.toLocaleString()}건 중 {rows.length}건 표시
      </p>
      <table className="agent-result__table">
        <thead>
          <tr>
            {schema.map((col) => (
              <th key={col.name} title={col.type?.name}>
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {schema.map((col) => (
                <td key={col.name}>
                  {row[col.name] == null
                    ? <span className="agent-result__null">NULL</span>
                    : String(row[col.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  return (
    <div className={`agent-msg agent-msg--${msg.role}`}>
      <div className="agent-msg__label">
        {msg.role === "user" ? "You" : msg.role === "agent" ? "Agent" : "System"}
      </div>
      <div className="agent-msg__body">
        {msg.text && <pre>{msg.text}</pre>}
        {msg.status && !msg.result && !msg.error && (
          <p className="agent-msg__status">⏳ {statusLabel(msg.status)}</p>
        )}
        {msg.result && (
          <div className="agent-result">
            <details open>
              <summary className="agent-result__sql">
                SQL: <code>{msg.result.sql}</code>
                <span className="agent-result__jobid">
                  &nbsp;(job: {msg.result.jobId})
                </span>
              </summary>
              <ResultTable data={msg.result.data} />
            </details>
          </div>
        )}
        {msg.error && (
          <p className="agent-msg__error">❌ {msg.error}</p>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const AgentPage = () => {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const updateLast = (updater: (m: Message) => Message) => {
    setMessages((prev) => {
      const copy = [...prev];
      copy[copy.length - 1] = updater(copy[copy.length - 1]);
      return copy;
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || busy) return;

    setInput("");
    setBusy(true);

    // append user message
    const userMsg: Message = { id: nextId(), role: "user", text: prompt };
    const agentMsg: Message = {
      id: nextId(),
      role: "agent",
      text: "처리 중…",
    };
    setMessages((prev) => [...prev, userMsg, agentMsg]);

    try {
      // ── NL → SQL ───────────────────────────────────────────────────────────
      const nlResult = naturalLanguageToSql(prompt);

      if (nlResult.kind === "unrecognized") {
        updateLast((m) => ({
          ...m,
          text: [
            "SQL로 변환할 수 없는 입력입니다.",
            "",
            "다음처럼 입력해 보세요:",
            "  • 테이블 목록 보여줘",
            '  • SELECT * FROM "Space"."Table" LIMIT 10',
            "  • <테이블명> 데이터 조회해줘",
          ].join("\n"),
        }));
        return;
      }

      const { sql, explanation } = nlResult;

      updateLast((m) => ({
        ...m,
        text: `${explanation}\n\n실행: ${sql}`,
        status: "STARTING" as JobStatus,
      }));

      // ── Submit SQL ─────────────────────────────────────────────────────────
      const jobId = await submitSql(sql);

      updateLast((m) => ({ ...m, status: "RUNNING" as JobStatus }));

      // ── Poll ───────────────────────────────────────────────────────────────
      const finalJob = await waitForJob(jobId, (state) => {
        updateLast((m) => ({ ...m, status: state }));
      });

      if (finalJob.state === "FAILED") {
        updateLast((m) => ({
          ...m,
          text: explanation,
          status: undefined,
          error: finalJob.errorMessage ?? "쿼리 실패",
        }));
        return;
      }

      if (finalJob.state === "CANCELLED") {
        updateLast((m) => ({
          ...m,
          text: explanation,
          status: undefined,
          error: "쿼리가 취소되었습니다.",
        }));
        return;
      }

      // ── Fetch results ──────────────────────────────────────────────────────
      const data = await fetchJobResults(jobId);

      updateLast((m) => ({
        ...m,
        text: explanation,
        status: undefined,
        result: { sql, jobId, data },
      }));
    } catch (err: any) {
      updateLast((m) => ({
        ...m,
        text: "",
        status: undefined,
        error: err?.message ?? "알 수 없는 오류가 발생했습니다.",
      }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-page">
      <DocumentTitle
        title={intl.formatMessage({ id: "SideNav.Agent" })}
      />
      <SonarSideNav />

      <div className="agent-page__main">
        {/* Header */}
        <div className="agent-page__header">
          <h1>AI Agent</h1>
          <p>
            자연어로 Dremio DB를 조회합니다.&nbsp;
            SQL을 직접 입력할 수도 있습니다.
          </p>
        </div>

        {/* Message list */}
        <div className="agent-page__messages" aria-live="polite">
          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <form className="agent-page__composer" onSubmit={handleSubmit}>
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as any);
              }
            }}
            placeholder="질문 또는 SQL 입력 (Enter 전송 / Shift+Enter 줄바꿈)"
            disabled={busy}
          />
          <button type="submit" disabled={busy || !input.trim()}>
            {busy ? "…" : "전송"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default AgentPage;
