"use client";

import { useState, useRef, useEffect } from "react";
import {
  Header,
  HeaderName,
  HeaderNavigation,
  HeaderMenuItem,
  Content,
  Grid,
  Column,
  TextInput,
  Button,
  Tag,
  Tile,
} from "@carbon/react";
import { Send, ArrowLeft } from "@carbon/icons-react";

type TagType = "blue" | "red" | "purple" | "teal" | "cyan" | "green" | "gray" | "magenta" | "cool-gray" | "warm-gray" | "high-contrast" | "outline";

const ENTITY_TYPE_COLORS: Record<string, TagType> = {
  decision: "blue",
  gap: "red",
  dependency: "purple",
  stakeholder: "teal",
  milestone: "cyan",
  workflow: "green",
};

const STATUS_COLORS: Record<string, TagType> = {
  open: "red",
  resolved: "green",
  blocked: "magenta",
  unknown: "gray",
};

interface Source {
  document: string;
  section: string;
  domain: string;
  distance: number;
}

interface EntityRef {
  id: number;
  entity_type: string;
  content: string;
  status: string;
  owner: string | null;
  domain: string;
  source_document: string;
  relation_type?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  entities?: EntityRef[];
  intent?: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", sources: [], entities: [] },
    ]);

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error ?? `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error("No response stream");

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === "sources") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant") {
                  last.sources = event.sources;
                }
                return updated;
              });
            } else if (event.type === "entities") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant") {
                  last.entities = event.entities;
                  last.intent = event.intent;
                }
                return updated;
              });
            } else if (event.type === "text") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant") {
                  last.content += event.text;
                }
                return updated;
              });
            } else if (event.type === "error") {
              throw new Error(event.error);
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }
    } catch (error) {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === "assistant") {
          last.content = `Error: ${error instanceof Error ? error.message : "Something went wrong"}`;
        }
        return updated;
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Header aria-label="RepoIntel Chat">
        <HeaderName href="/" prefix="">
          RepoIntel
        </HeaderName>
        <HeaderNavigation aria-label="Navigation">
          <HeaderMenuItem href="/">Dashboard</HeaderMenuItem>
          <HeaderMenuItem href="/chat">Chat</HeaderMenuItem>
        </HeaderNavigation>
      </Header>

      <div style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        paddingTop: "3rem",
      }}>
        {/* Sub-header */}
        <div style={{
          borderBottom: "1px solid var(--cds-border-subtle)",
          background: "var(--cds-layer-01)",
          padding: "0.75rem 1.5rem",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
        }}>
          <Button kind="ghost" size="sm" renderIcon={ArrowLeft} href="/">
            Home
          </Button>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>Chat</h2>
        </div>

        {/* Messages area */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "1.5rem",
        }}>
          <div style={{ maxWidth: "768px", margin: "0 auto" }}>
            {messages.length === 0 && (
              <div style={{
                textAlign: "center",
                marginTop: "6rem",
                color: "var(--cds-text-secondary)",
              }}>
                <h2 style={{ fontSize: "1.75rem", fontWeight: 300, marginBottom: "0.5rem" }}>
                  Ask RepoIntel
                </h2>
                <p style={{ fontSize: "0.875rem", marginBottom: "1.5rem" }}>
                  Ask questions about your indexed project documents.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "center" }}>
                  {[
                    "What are the key decisions documented?",
                    "Summarize the project status",
                    "What should I be worried about?",
                  ].map((q) => (
                    <Button
                      key={q}
                      kind="ghost"
                      size="sm"
                      onClick={() => {
                        setInput(q);
                      }}
                      style={{ fontSize: "0.75rem" }}
                    >
                      {q}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                  marginBottom: "1rem",
                }}
              >
                {msg.role === "user" ? (
                  <div style={{
                    maxWidth: "75%",
                    padding: "0.75rem 1rem",
                    background: "var(--cds-interactive)",
                    color: "var(--cds-text-on-color)",
                    fontSize: "0.875rem",
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  }}>
                    {msg.content}
                  </div>
                ) : (
                  <Tile style={{ maxWidth: "85%", padding: "1rem" }}>
                    {/* Intent badge */}
                    {msg.intent && (
                      <div style={{ marginBottom: "0.5rem" }}>
                        <Tag type="high-contrast" size="sm">
                          {msg.intent} query
                        </Tag>
                      </div>
                    )}

                    {/* Response text */}
                    <div style={{
                      fontSize: "0.875rem",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                    }}>
                      {msg.content}
                      {loading && i === messages.length - 1 && (
                        <span style={{
                          display: "inline-block",
                          width: "8px",
                          height: "16px",
                          background: "var(--cds-text-secondary)",
                          marginLeft: "2px",
                          animation: "pulse 1s infinite",
                        }} />
                      )}
                    </div>

                    {/* Entity references */}
                    {msg.entities && msg.entities.length > 0 && msg.content && (
                      <details style={{
                        marginTop: "1rem",
                        paddingTop: "0.75rem",
                        borderTop: "1px solid var(--cds-border-subtle)",
                      }}>
                        <summary style={{
                          cursor: "pointer",
                          fontSize: "0.75rem",
                          color: "var(--cds-text-secondary)",
                          marginBottom: "0.5rem",
                        }}>
                          {msg.entities.length} entities referenced
                        </summary>
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                          {msg.entities.slice(0, 10).map((entity, j) => (
                            <div
                              key={j}
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: "0.375rem",
                                fontSize: "0.75rem",
                                padding: "0.375rem 0",
                                borderBottom: j < Math.min(msg.entities!.length, 10) - 1
                                  ? "1px solid var(--cds-border-subtle)"
                                  : "none",
                              }}
                            >
                              <Tag
                                type={ENTITY_TYPE_COLORS[entity.entity_type] ?? "gray"}
                                size="sm"
                                style={{ flexShrink: 0 }}
                              >
                                {entity.entity_type}
                              </Tag>
                              <Tag
                                type={STATUS_COLORS[entity.status] ?? "gray"}
                                size="sm"
                                style={{ flexShrink: 0 }}
                              >
                                {entity.status}
                              </Tag>
                              <span style={{ color: "var(--cds-text-primary)", lineHeight: 1.4 }}>
                                {entity.content.length > 120
                                  ? entity.content.substring(0, 120) + "..."
                                  : entity.content}
                              </span>
                              {entity.owner && (
                                <Tag type="cool-gray" size="sm" style={{ flexShrink: 0 }}>
                                  {entity.owner}
                                </Tag>
                              )}
                            </div>
                          ))}
                          {msg.entities.length > 10 && (
                            <span style={{ fontSize: "0.6875rem", color: "var(--cds-text-secondary)" }}>
                              +{msg.entities.length - 10} more entities
                            </span>
                          )}
                        </div>
                      </details>
                    )}

                    {/* Source citations */}
                    {msg.sources && msg.sources.length > 0 && msg.content && (
                      <details style={{
                        marginTop: "0.75rem",
                        paddingTop: "0.75rem",
                        borderTop: "1px solid var(--cds-border-subtle)",
                      }}>
                        <summary style={{
                          cursor: "pointer",
                          fontSize: "0.75rem",
                          color: "var(--cds-text-secondary)",
                          marginBottom: "0.5rem",
                        }}>
                          {msg.sources.length} sources referenced
                        </summary>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                          {msg.sources.map((s, j) => (
                            <Tag key={j} type="cool-gray" size="sm" title={`${s.document} > ${s.section}`}>
                              {s.document}
                            </Tag>
                          ))}
                        </div>
                      </details>
                    )}
                  </Tile>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input area */}
        <div style={{
          borderTop: "1px solid var(--cds-border-subtle)",
          background: "var(--cds-layer-01)",
          padding: "1rem 1.5rem",
        }}>
          <form
            onSubmit={handleSubmit}
            style={{
              display: "flex",
              gap: "0.75rem",
              maxWidth: "768px",
              margin: "0 auto",
              alignItems: "flex-end",
            }}
          >
            <div style={{ flex: 1 }}>
              <TextInput
                id="chat-input"
                labelText=""
                hideLabel
                placeholder="Ask a question about your project..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={loading}
                size="lg"
              />
            </div>
            <Button
              type="submit"
              kind="primary"
              size="lg"
              renderIcon={Send}
              disabled={loading || !input.trim()}
              hasIconOnly
              iconDescription={loading ? "Thinking..." : "Send"}
            />
          </form>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </>
  );
}
