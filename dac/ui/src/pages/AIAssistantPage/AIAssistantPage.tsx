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
import { FormEvent, useMemo, useState } from "react";
import DocumentTitle from "react-document-title";
import { SonarSideNav } from "#oss/exports/components/SideNav/SonarSideNav";
import { intl } from "#oss/utils/intl";
import { getResourceTree } from "#oss/endpoints/SourceAPI/listSources";
import { getCatalogContent } from "#oss/endpoints/CatalogContent/listCatalogContent";
import { listJobs } from "#oss/exports/endpoints/JobsListing/listJobs";

import "./AIAssistantPage.less";

type ChatRole = "assistant" | "user";

type ChatMessage = {
  id: number;
  role: ChatRole;
  text: string;
};

const HELP_TEXT = [
  "안녕하세요. 데이터 조회용 AI Assistant입니다.",
  "",
  "사용 예시:",
  "- sources : 등록된 소스 목록 조회",
  "- catalog : 카탈로그 상위 엔티티 조회",
  "- jobs : 최근 작업 5건 조회",
].join("\n");

const toListText = (items: Array<{ name?: string; type?: string }>) => {
  if (!items.length) {
    return "조회 결과가 없습니다.";
  }
  return items
    .slice(0, 10)
    .map((item) => `- ${item.name || "unknown"} (${item.type || "UNKNOWN"})`)
    .join("\n");
};

const normalizeItems = (payload: any): any[] => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.entities)) return payload.entities;
  if (Array.isArray(payload?.children)) return payload.children;
  return [];
};

const getAssistantReply = async (prompt: string): Promise<string> => {
  const normalized = prompt.trim().toLowerCase();

  if (!normalized) {
    return "질문을 입력해 주세요. 예: sources / catalog / jobs";
  }

  if (
    normalized.includes("sources") ||
    normalized.includes("source") ||
    normalized.includes("소스")
  ) {
    const response = await getResourceTree(false);
    const items = normalizeItems(response).map((item: any) => ({
      name: item.name,
      type: item.type,
    }));
    return `현재 소스 목록입니다.\n${toListText(items)}`;
  }

  if (normalized.includes("catalog") || normalized.includes("카탈로그")) {
    const response = await getCatalogContent(false);
    const items = normalizeItems(response).map((item: any) => ({
      name: item.name,
      type: item.type,
    }));
    return `카탈로그 상위 엔티티입니다.\n${toListText(items)}`;
  }

  if (
    normalized.includes("jobs") ||
    normalized.includes("job") ||
    normalized.includes("작업")
  ) {
    const response = await listJobs({
      pageToken: { limit: 5, offset: 0 },
      sort: "st",
      order: "DESCENDING",
      filter: "",
    });

    const jobs = normalizeItems(response);
    if (!jobs.length) {
      return "최근 작업 정보가 없습니다.";
    }

    const result = jobs
      .slice(0, 5)
      .map((job: any) => {
        const state = job?.state || "UNKNOWN";
        const user = job?.user || "-";
        const id = job?.id || "-";
        return `- [${state}] ${id} (user: ${user})`;
      })
      .join("\n");

    return `최근 작업 5건입니다.\n${result}`;
  }

  return [
    "지원하는 조회 명령을 찾지 못했습니다.",
    "다음 중 하나로 요청해 주세요:",
    "- sources",
    "- catalog",
    "- jobs",
  ].join("\n");
};

const AIAssistantPage = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, role: "assistant", text: HELP_TEXT },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const nextId = useMemo(
    () => (messages.length ? messages[messages.length - 1].id + 1 : 1),
    [messages],
  );

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { id: nextId, role: "user", text: prompt }]);
    setLoading(true);

    try {
      const reply = await getAssistantReply(prompt);
      setMessages((prev) => [
        ...prev,
        { id: nextId + 1, role: "assistant", text: reply },
      ]);
    } catch (error: any) {
      const message =
        error?.message ||
        "조회 중 오류가 발생했습니다. 권한 또는 연결 상태를 확인해 주세요.";
      setMessages((prev) => [
        ...prev,
        { id: nextId + 1, role: "assistant", text: message },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ai-assistant-page">
      <DocumentTitle title={intl.formatMessage({ id: "SideNav.AIAssistant" })} />
      <SonarSideNav />
      <div className="ai-assistant-page__content dremio-layout-container --vertical">
        <div className="ai-assistant-page__header">
          <h1>AI Assistant</h1>
          <p>대화형으로 Dremio 메타데이터/작업 상태를 조회할 수 있습니다.</p>
        </div>
        <div className="ai-assistant-page__messages" aria-live="polite">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`ai-assistant-page__message ai-assistant-page__message--${message.role}`}
            >
              <div className="ai-assistant-page__messageRole">
                {message.role === "assistant" ? "Assistant" : "You"}
              </div>
              <pre>{message.text}</pre>
            </div>
          ))}
          {loading && (
            <div className="ai-assistant-page__message ai-assistant-page__message--assistant">
              <div className="ai-assistant-page__messageRole">Assistant</div>
              <pre>조회 중...</pre>
            </div>
          )}
        </div>
        <form className="ai-assistant-page__composer" onSubmit={onSubmit}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="질문을 입력하세요 (예: sources)"
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            전송
          </button>
        </form>
      </div>
    </div>
  );
};

export default AIAssistantPage;
