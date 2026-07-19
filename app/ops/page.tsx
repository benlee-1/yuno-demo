"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { Badge, Button, GlassCard, Input } from "@/components/ui";
import { TOOL_SCOPES, isDestructiveTool } from "@/lib/agent/permissions";

// ---------------------------------------------------------------------------
// Markdown-lite renderer (bold, inline code, tables, lists, headings, fences)
// ---------------------------------------------------------------------------

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((chunk, i) => {
    if (chunk.startsWith("**") && chunk.endsWith("**")) {
      return <strong key={`${keyPrefix}-${i}`}>{chunk.slice(2, -2)}</strong>;
    }
    if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 2) {
      return (
        <code
          key={`${keyPrefix}-${i}`}
          className="px-1.5 py-0.5 rounded-md bg-primary/8 text-primary-dark font-mono text-[0.85em]"
        >
          {chunk.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{chunk}</span>;
  });
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // fenced code
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre
          key={key++}
          className="my-2 p-3 rounded-xl bg-ink/90 text-white text-xs font-mono overflow-x-auto"
        >
          {code.join("\n")}
        </pre>,
      );
      continue;
    }

    // table
    if (line.trimStart().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const cells = lines[i]
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={key++} className="my-2 overflow-x-auto rounded-xl border border-white/60">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-white/60">
                {head?.map((c, ci) => (
                  <th key={ci} className="px-3 py-2 text-left font-semibold text-primary-dark whitespace-nowrap">
                    {renderInline(c, `th${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri} className="border-t border-white/50 odd:bg-white/30">
                  {row.map((c, ci) => (
                    <td key={ci} className="px-3 py-1.5 whitespace-nowrap">
                      {renderInline(c, `td${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-1.5 pl-5 list-disc space-y-0.5">
          {items.map((item, ii) => (
            <li key={ii}>{renderInline(item, `li${ii}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <p key={key++} className="mt-2 mb-1 font-bold text-ink">
          {renderInline(heading[2], "h")}
        </p>,
      );
      i++;
      continue;
    }

    // paragraph (consume consecutive plain lines)
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("|") &&
      !lines[i].trimStart().startsWith("```") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^#{1,4}\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="my-1 leading-relaxed">
        {para.map((p, pi) => (
          <span key={pi}>
            {pi > 0 && <br />}
            {renderInline(p, `p${pi}`)}
          </span>
        ))}
      </p>,
    );
  }

  return <div className="text-sm text-ink/90">{blocks}</div>;
}

// ---------------------------------------------------------------------------
// Tool call cards
// ---------------------------------------------------------------------------

type ToolInvocation = ToolUIPart | DynamicToolUIPart;

function toolNameOf(part: ToolInvocation): string {
  return part.type === "dynamic-tool"
    ? part.toolName
    : part.type.slice("tool-".length);
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function Collapsible({ label, content }: { label: string; content: string }) {
  const [open, setOpen] = useState(false);
  const preview = content.length > 300 ? `${content.slice(0, 300)}…` : content;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-semibold text-primary/70 hover:text-primary cursor-pointer"
      >
        {open ? "▾" : "▸"} {label}
      </button>
      {open && (
        <pre className="mt-1 p-2.5 rounded-xl bg-white/70 border border-white/60 text-[11px] font-mono text-ink/80 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
          {content}
        </pre>
      )}
      {!open && content.length > 0 && (
        <div className="mt-0.5 text-[11px] font-mono text-neutral-400 truncate">
          {preview.split("\n").join(" ").slice(0, 120)}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
  );
}

function ToolCallCard({ part }: { part: ToolInvocation }) {
  const name = toolNameOf(part);
  const gated = isDestructiveTool(name);
  const accent = gated ? "border-l-lime" : "border-l-primary/60";

  let icon: ReactNode = <Spinner />;
  let statusLabel = "running";
  if (part.state === "output-available") {
    icon = <span className="text-primary font-bold">✓</span>;
    statusLabel = "done";
  } else if (part.state === "output-error") {
    icon = <span className="text-red-500 font-bold">✗</span>;
    statusLabel = "error";
  } else if (part.state === "output-denied") {
    icon = <span className="text-neutral-400 font-bold">⊘</span>;
    statusLabel = "denied";
  } else if (part.state === "input-streaming") {
    statusLabel = "preparing";
  } else if (part.state === "approval-responded") {
    statusLabel = part.approval.approved ? "approved — executing" : "denied";
  }

  return (
    <div
      className={`my-2 px-3.5 py-2.5 rounded-2xl bg-white/45 backdrop-blur-md border border-white/50 border-l-4 ${accent} shadow-glass`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <Badge tone={gated ? "success" : "pending"} className="font-mono normal-case tracking-normal">
          {name}
        </Badge>
        <span className="text-[11px] text-neutral-400">{statusLabel}</span>
        {gated && (
          <span className="text-[10px] uppercase tracking-wide text-ink/50 font-semibold ml-auto">
            gated
          </span>
        )}
      </div>
      {part.input !== undefined && (
        <Collapsible label="input" content={pretty(part.input)} />
      )}
      {part.state === "output-available" && (
        <Collapsible label="result" content={pretty(part.output)} />
      )}
      {part.state === "output-error" && (
        <div className="mt-1.5 text-xs text-red-600 font-mono break-all">
          {part.errorText}
        </div>
      )}
      {part.state === "output-denied" && (
        <div className="mt-1.5 text-xs text-neutral-500">
          User denied this action.
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  part,
  onRespond,
  busy,
}: {
  part: ToolInvocation & { state: "approval-requested" };
  onRespond: (id: string, approved: boolean) => void;
  busy: boolean;
}) {
  const name = toolNameOf(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  const highlight: Array<[string, unknown]> = Object.entries(input).filter(
    ([k]) => /id|amount|reason|order/i.test(k),
  );

  return (
    <div className="my-2 p-4 rounded-2xl bg-white/60 backdrop-blur-xl border border-lime/70 border-l-4 border-l-lime shadow-[0_8px_32px_rgba(199,233,86,0.25)]">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">⚠️</span>
        <span className="text-sm font-bold text-ink">Confirmation required</span>
        <Badge tone="success" className="font-mono normal-case tracking-normal">
          {name}
        </Badge>
      </div>
      <p className="text-xs text-ink/70 mb-2">
        The agent wants to run a destructive Yuno operation. It will not execute
        until you confirm.
      </p>
      {highlight.length > 0 && (
        <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {highlight.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-neutral-400 font-medium">{k}</dt>
              <dd className="font-mono text-ink/80 break-all">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <Collapsible label="full input" content={pretty(part.input)} />
      <div className="flex gap-2 mt-3">
        <Button
          variant="lime"
          className="px-4 py-2 text-sm"
          disabled={busy}
          onClick={() => onRespond(part.approval.id, true)}
        >
          Confirm
        </Button>
        <Button
          variant="ghost"
          className="px-4 py-2 text-sm text-ink/70 border-neutral-300"
          disabled={busy}
          onClick={() => onRespond(part.approval.id, false)}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  "Show recent orders",
  "Refund Maria's coffee order",
  "Create a payment link for R$ 150",
  "Summarize today's payments",
];

function friendlyError(error: Error): string {
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch {
    // not a JSON body — fall through
  }
  return error.message || "Something went wrong.";
}

export default function OpsPage() {
  const [input, setInput] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  const {
    messages,
    sendMessage,
    addToolApprovalResponse,
    status,
    error,
    clearError,
  } = useChat<UIMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
  };

  const respond = (id: string, approved: boolean) => {
    void addToolApprovalResponse({
      id,
      approved,
      reason: approved ? undefined : "User denied this action",
    });
  };

  return (
    <div className="grid lg:grid-cols-[1fr_240px] gap-4 items-start">
      {/* Chat column */}
      <div className="flex flex-col h-[calc(100vh-11.5rem)] min-h-[28rem]">
        <GlassCard className="px-6 py-4 mb-3 shrink-0">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-2xl bg-primary text-white grid place-items-center text-lg">
              ⚙️
            </span>
            <div>
              <h1 className="text-lg font-extrabold leading-tight">
                Payment Ops Agent
              </h1>
              <p className="text-xs text-neutral-400">
                Claude + Yuno Agent Toolkit — least-privilege tools
              </p>
            </div>
          </div>
        </GlassCard>

        {/* Thread */}
        <GlassCard className="flex-1 flex flex-col overflow-hidden">
          <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
                <p className="text-sm text-neutral-400 max-w-sm">
                  Ask about orders, payments, refunds, payment links, or
                  subscriptions. Destructive actions always ask for your
                  confirmation first.
                </p>
                <div className="flex flex-wrap justify-center gap-2 max-w-md">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void sendMessage({ text: s })}
                      className="px-4 py-2 rounded-full bg-white/60 backdrop-blur-md border border-white/60 text-xs font-medium text-primary-dark hover:bg-white/90 hover:border-primary-light/40 transition-all cursor-pointer shadow-glass"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <div key={message.id} className="mb-4">
                {message.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md bg-primary text-white text-sm shadow-[0_4px_16px_rgba(62,79,224,0.3)]">
                      {message.parts.map((part, pi) =>
                        part.type === "text" ? (
                          <span key={pi}>{part.text}</span>
                        ) : null,
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="max-w-[92%]">
                    {message.parts.map((part, pi) => {
                      if (part.type === "text") {
                        return <MarkdownLite key={pi} text={part.text} />;
                      }
                      if (part.type === "dynamic-tool" || isToolUIPart(part)) {
                        const inv = part as ToolInvocation;
                        if (inv.state === "approval-requested") {
                          return (
                            <ApprovalCard
                              key={pi}
                              part={inv as ToolInvocation & { state: "approval-requested" }}
                              onRespond={respond}
                              busy={busy}
                            />
                          );
                        }
                        return <ToolCallCard key={pi} part={inv} />;
                      }
                      return null;
                    })}
                  </div>
                )}
              </div>
            ))}

            {status === "submitted" && (
              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <Spinner /> thinking…
              </div>
            )}

            {error && (
              <div className="my-2 px-4 py-3 rounded-2xl bg-red-50/80 border border-red-200 text-xs text-red-700">
                <span className="font-semibold">Agent error:</span>{" "}
                {friendlyError(error)}
                <button
                  type="button"
                  onClick={clearError}
                  className="ml-2 underline cursor-pointer"
                >
                  dismiss
                </button>
              </div>
            )}
          </div>

          {/* Input bar */}
          <form
            onSubmit={submit}
            className="shrink-0 flex gap-2 px-4 py-3 border-t border-white/50 bg-white/40 backdrop-blur-xl"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Try "Refund Maria&apos;s coffee order"'
              disabled={busy}
              autoFocus
            />
            <Button type="submit" disabled={busy || input.trim() === ""} className="px-5 py-2.5">
              Send
            </Button>
          </form>
        </GlassCard>
      </div>

      {/* Scopes sidebar */}
      <GlassCard className="p-4 lg:sticky lg:top-24">
        <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-400 mb-2">
          Enabled tool scopes
        </p>
        <ul className="space-y-1">
          {TOOL_SCOPES.map(({ scope, gated }) => (
            <li key={scope} className="flex items-center gap-1.5 text-[11px] font-mono text-ink/70">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${gated ? "bg-lime" : "bg-primary/50"}`}
              />
              <span className="truncate">{scope}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[10px] text-neutral-400 leading-relaxed">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-lime mr-1" />
          = requires human confirmation. Everything else is read-only or
          non-destructive. All other Yuno operations are disabled.
        </p>
      </GlassCard>
    </div>
  );
}
