import "server-only";
import type { StepResult, ToolExecutionEndEvent, ToolSet, UIMessage } from "ai";
import {
  type AgentAuditInsert,
  hasAgentAuditRow,
  insertAgentAudit,
} from "@/lib/db";
import { isDestructiveTool } from "@/lib/agent/permissions";

/**
 * AGENT AUDIT LOG — persists every agent run to SQLite (`agent_audit`).
 *
 * The /ops chat transcript lives only in browser state; an agent holding
 * refund power needs a server-side record that survives a refresh. One row
 * per interesting part: the operator's prompt, each tool call/result/error,
 * each approval request and Confirm/Deny decision, and the assistant's text —
 * grouped by `run_id` (one UUID per /api/chat request) with per-step token
 * usage. Inspect with:
 *   sqlite3 data/demo.db "SELECT * FROM agent_audit ORDER BY id DESC LIMIT 20;"
 *
 * Writes are best-effort: an audit failure must never break the stream.
 */

const MAX_PAYLOAD = 16_000;

function asPayload(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  return text.length > MAX_PAYLOAD
    ? `${text.slice(0, MAX_PAYLOAD)}…[truncated]`
    : text;
}

const emptyRow = {
  step_number: null as number | null,
  tool_name: null as string | null,
  tool_call_id: null as string | null,
  gated: null as number | null,
  approved: null as number | null,
  payload: null as string | null,
  model: null as string | null,
  finish_reason: null as string | null,
  input_tokens: null as number | null,
  output_tokens: null as number | null,
};

/**
 * Record what the operator sent to start this run: the prompt (if the last
 * message is a user turn) and any Confirm/Deny decisions.
 *
 * Approval decisions travel INSIDE the resubmitted assistant message (tool
 * parts in state `approval-responded`, later `output-available`/`output-denied`
 * — all carrying `approval.approved`), not as step content, so this is the
 * only place they are visible to the server. The full history is resent on
 * every request, so decisions are deduped on tool_call_id.
 */
export function auditRequest(run_id: string, messages: UIMessage[]): void {
  try {
    const rows: AgentAuditInsert[] = [];

    const last = messages[messages.length - 1];
    if (last?.role === "user") {
      const text = last.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      rows.push({
        ...emptyRow,
        run_id,
        part_type: "user-message",
        payload: asPayload(text),
      });
    }

    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (!part.type.startsWith("tool-")) continue;
        const tool = part as {
          type: string;
          toolCallId?: string;
          approval?: { approved?: boolean; reason?: string };
        };
        if (
          typeof tool.approval?.approved !== "boolean" ||
          !tool.toolCallId ||
          hasAgentAuditRow("approval-response", tool.toolCallId)
        )
          continue;
        rows.push({
          ...emptyRow,
          run_id,
          part_type: "approval-response",
          tool_name: part.type.slice("tool-".length),
          tool_call_id: tool.toolCallId,
          gated: 1,
          approved: tool.approval.approved ? 1 : 0,
          payload: asPayload(tool.approval.reason),
        });
      }
    }

    insertAgentAudit(rows);
  } catch (err) {
    console.error("[ops-agent] audit write failed (request):", err);
  }
}

/**
 * Record a gated tool's execution result. After a Confirm round-trip the
 * approved tool executes BEFORE the first model step of the resumed run, so
 * its result never appears in step content — this hook is the only coverage.
 * Ungated tools are skipped: their results are already audited per step.
 */
export function auditToolExecution(
  run_id: string,
  event: ToolExecutionEndEvent<ToolSet>,
): void {
  try {
    const toolName = event.toolCall.toolName;
    if (!isDestructiveTool(toolName)) return;
    const output = event.toolOutput;
    insertAgentAudit([
      {
        ...emptyRow,
        run_id,
        part_type: output.type === "tool-error" ? "tool-error" : "tool-result",
        tool_name: toolName,
        tool_call_id: event.toolCall.toolCallId,
        gated: 1,
        payload: asPayload(
          output.type === "tool-error" ? output.error : output.output,
        ),
      },
    ]);
  } catch (err) {
    console.error("[ops-agent] audit write failed (tool-execution):", err);
  }
}

/** Record one finished step: tool activity, approvals, and assistant text. */
export function auditStep(
  run_id: string,
  model: string,
  step: StepResult<ToolSet>,
): void {
  try {
    const base = {
      ...emptyRow,
      run_id,
      step_number: step.stepNumber,
      model,
      finish_reason: step.finishReason,
      input_tokens: step.usage.inputTokens ?? null,
      output_tokens: step.usage.outputTokens ?? null,
    };
    const rows: AgentAuditInsert[] = [];
    for (const part of step.content) {
      switch (part.type) {
        case "tool-call":
          rows.push({
            ...base,
            part_type: "tool-call",
            tool_name: part.toolName,
            tool_call_id: part.toolCallId,
            gated: isDestructiveTool(part.toolName) ? 1 : 0,
            payload: asPayload(part.input),
          });
          break;
        // Gated results/errors are recorded by auditToolExecution (they
        // execute outside step flow after a Confirm round-trip) — skip them
        // here so they can never double-record.
        case "tool-result":
          if (isDestructiveTool(part.toolName)) break;
          rows.push({
            ...base,
            part_type: "tool-result",
            tool_name: part.toolName,
            tool_call_id: part.toolCallId,
            gated: 0,
            payload: asPayload(part.output),
          });
          break;
        case "tool-error":
          if (isDestructiveTool(part.toolName)) break;
          rows.push({
            ...base,
            part_type: "tool-error",
            tool_name: part.toolName,
            tool_call_id: part.toolCallId,
            gated: 0,
            payload: asPayload(part.error),
          });
          break;
        case "tool-approval-request":
          rows.push({
            ...base,
            part_type: "approval-request",
            tool_name: part.toolCall.toolName,
            tool_call_id: part.toolCall.toolCallId,
            gated: 1,
            payload: asPayload(part.toolCall.input),
          });
          break;
        // NB: no "tool-approval-response" case — decisions arrive inside the
        // resubmitted messages and are recorded (deduped) by auditRequest.
      }
    }
    if (step.text.trim()) {
      rows.push({
        ...base,
        part_type: "assistant-text",
        payload: asPayload(step.text),
      });
    }
    insertAgentAudit(rows);
  } catch (err) {
    console.error("[ops-agent] audit write failed (step):", err);
  }
}
