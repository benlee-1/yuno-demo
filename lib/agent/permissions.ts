import type { ActionsConfiguration } from "@yuno-payments/agent-toolkit/ai-sdk";
import type { ToolApprovalStatus } from "ai";

/**
 * AGENT PERMISSION POLICY — Montmare Payments Concierge
 * =====================================================
 *
 * This module is the single place that defines what the agent MAY do.
 * The agent acts autonomously, but only within the permissions configured
 * here (the Payments Concierge pattern): the merchant grants capabilities,
 * the agent operates inside them.
 *
 * Why it is scoped this way:
 *
 * - An agent holding refund power is a production credential. Permissions
 *   are an explicit allowlist — never `ALL_TOOLS_ENABLED`. Anything not
 *   granted here (payment create, routing, recipients, installment plans,
 *   ...) simply does not exist for the model.
 * - Money-moving actions additionally require a human confirmation gate
 *   (`REQUIRES_CONFIRMATION` below), enforced SERVER-SIDE via the AI SDK's
 *   `toolApproval` flow — the tool's execute() only runs after an explicit
 *   approved:true response round-trips from the operator.
 * - The gate fails closed: unknown or renamed destructive tools are caught
 *   by a defensive pattern match and gated by default rather than
 *   executing silently.
 *
 * Isomorphic on purpose (types + constants only, no server imports) so the
 * ops UI can render the policy exactly as the server enforces it.
 */

/** What the agent may do. Everything else is invisible to the model. */
export const PERMISSIONS: ActionsConfiguration = {
  // Customers — read + create (checkout requires real customer records).
  customers: { create: true, retrieve: true },
  // Payments — read + act on payments; refunds move money → gated.
  payments: {
    retrieve: true,
    retrieveByMerchantOrderId: true,
    refund: true,
    cancelOrRefund: true,
  },
  // Payment links — create + read; cancelling a live link → gated.
  paymentLinks: { create: true, retrieve: true, cancel: true },
  // Subscriptions — read, create, resume; pause/cancel kill revenue → gated.
  subscriptions: {
    create: true,
    retrieve: true,
    pause: true,
    resume: true,
    cancel: true,
  },
};

/**
 * Actions that move money or kill revenue objects (tool-map keys as produced
 * by `toolkit.getTools()`, i.e. the MCP tool names). Every one requires an
 * explicit human Confirm click before it executes.
 */
export const REQUIRES_CONFIRMATION = [
  "paymentRefund",
  "paymentCancelOrRefund",
  "paymentLinkCancel",
  "subscriptionPause",
  "subscriptionCancel",
] as const;

export type DestructiveTool = (typeof REQUIRES_CONFIRMATION)[number];

/**
 * True when a tool name must be confirmation-gated. Exact-list match plus a
 * defensive pattern so a renamed/added destructive Yuno tool fails closed
 * (gets gated) rather than executing silently.
 */
export function isDestructiveTool(toolName: string): boolean {
  if ((REQUIRES_CONFIRMATION as readonly string[]).includes(toolName))
    return true;
  return /refund|cancel|pause|unenroll|delete/i.test(toolName);
}

/**
 * Server-enforced confirmation gate: every destructive tool in the tool map
 * is marked `user-approval`, so the AI SDK core pauses the loop, streams an
 * approval-request to the client, and only invokes the tool's execute() after
 * an explicit approved:true response comes back. Non-destructive tools stay
 * auto-executing.
 */
export function buildToolApproval(
  toolNames: string[],
): Record<string, ToolApprovalStatus> {
  const approval: Record<string, ToolApprovalStatus> = {};
  for (const name of toolNames) {
    if (isDestructiveTool(name)) approval[name] = "user-approval";
  }
  return approval;
}

/** Display list for the ops UI's permissions panel. */
export const TOOL_SCOPES: Array<{ scope: string; gated: boolean }> = [
  { scope: "customers.create", gated: false },
  { scope: "customers.retrieve", gated: false },
  { scope: "payments.retrieve", gated: false },
  { scope: "payments.retrieveByMerchantOrderId", gated: false },
  { scope: "payments.refund", gated: true },
  { scope: "payments.cancelOrRefund", gated: true },
  { scope: "paymentLinks.create", gated: false },
  { scope: "paymentLinks.retrieve", gated: false },
  { scope: "paymentLinks.cancel", gated: true },
  { scope: "subscriptions.create", gated: false },
  { scope: "subscriptions.retrieve", gated: false },
  { scope: "subscriptions.pause", gated: true },
  { scope: "subscriptions.resume", gated: false },
  { scope: "subscriptions.cancel", gated: true },
  { scope: "local.searchOrders (read-only)", gated: false },
  { scope: "local.listRecentOrders (read-only)", gated: false },
  { scope: "local.paymentsBriefing (read-only)", gated: false },
];
