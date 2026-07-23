import { NextResponse } from "next/server";
import {
  capturePayment,
  cancelOrRefundPayment,
  extractTransactions,
  getPayment,
  refundPayment,
  YunoApiError,
  type YunoPayment,
} from "@/lib/yuno";
import { listWorkspaceOrders, updateOrderPayment } from "@/lib/db";
import {
  requireOwnedPayment,
  requireWorkspaceFeature,
  workspaceCredentials,
} from "@/lib/workspaces";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Post-payment ops, one endpoint multiplexed on `op` (shared gate + error
 * shape): list | inspect | capture | void | refund. Every op except `list`
 * takes a paymentId that MUST belong to an order of this workspace
 * (requireOwnedPayment) — cross-tenant ids 404.
 */

type OpsBody = {
  token?: string;
  op?: string;
  paymentId?: string;
  transactionId?: string;
  /** capture: required. refund: present = partial, absent = full. */
  amount?: number;
};

/** What the tester's browser gets — ids/status/amount, nothing else. */
function trimPayment(payment: YunoPayment) {
  const amount = payment.amount as
    | { currency?: string; value?: number }
    | undefined;
  return {
    id: payment.id,
    status: payment.status,
    sub_status: payment.sub_status ?? null,
    amount: amount
      ? { currency: amount.currency, value: Number(amount.value) }
      : null,
    transactions: extractTransactions(payment).map((t) => ({
      id: t.id,
      type: t.type ?? null,
      status: t.status ?? null,
      amount:
        t.amount && typeof t.amount === "object"
          ? (t.amount as { currency?: string; value?: number })
          : null,
    })),
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as OpsBody;

    const gate = requireWorkspaceFeature(body.token, "ops");
    if (!gate.ok) {
      return NextResponse.json(
        { error: gate.error },
        { status: gate.status, headers: NO_STORE },
      );
    }
    const { workspace } = gate;

    if (body.op === "list") {
      const orders = listWorkspaceOrders(workspace.id).map((o) => ({
        merchantOrderId: o.merchant_order_id,
        product: o.product,
        scenario: o.scenario,
        amount: o.amount,
        currency: o.currency,
        status: o.status,
        paymentId: o.payment_id,
        createdAt: o.created_at,
      }));
      return NextResponse.json({ orders }, { headers: NO_STORE });
    }

    const owned = requireOwnedPayment(workspace, body.paymentId);
    if (!owned.ok) {
      return NextResponse.json(
        { error: owned.error },
        { status: owned.status, headers: NO_STORE },
      );
    }
    const { order } = owned;
    const paymentId = body.paymentId as string;
    const creds = workspaceCredentials(workspace);

    if (body.op === "inspect") {
      const payment = await getPayment(paymentId, creds);
      updateOrderPayment(order.merchant_order_id, {
        payment_id: paymentId,
        status: payment.status,
      });
      return NextResponse.json(
        { payment: trimPayment(payment) },
        { headers: NO_STORE },
      );
    }

    // Mutations below need a transaction id from a prior inspect.
    const transactionId = body.transactionId;
    if (!transactionId) {
      return NextResponse.json(
        { error: "transactionId is required — inspect the payment first" },
        { status: 400, headers: NO_STORE },
      );
    }
    const currency = order.currency ?? workspace.default_currency;

    let result: YunoPayment;
    if (body.op === "capture") {
      const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
      if (!(amount > 0)) {
        return NextResponse.json(
          { error: "capture requires a positive amount (major units)" },
          { status: 400, headers: NO_STORE },
        );
      }
      result = await capturePayment(
        paymentId,
        transactionId,
        { currency, value: amount },
        crypto.randomUUID(),
        creds,
      );
    } else if (body.op === "void") {
      result = await cancelOrRefundPayment(
        paymentId,
        transactionId,
        crypto.randomUUID(),
        creds,
      );
    } else if (body.op === "refund") {
      const partial = body.amount !== undefined && body.amount !== null;
      const amount = partial
        ? Math.round(Number(body.amount) * 100) / 100
        : undefined;
      if (partial && !(amount! > 0)) {
        return NextResponse.json(
          { error: "partial refund requires a positive amount" },
          { status: 400, headers: NO_STORE },
        );
      }
      result = await refundPayment(
        paymentId,
        transactionId,
        amount ? { currency, value: amount } : undefined,
        crypto.randomUUID(),
        creds,
      );
    } else {
      return NextResponse.json(
        { error: "op must be one of: list, inspect, capture, void, refund" },
        { status: 400, headers: NO_STORE },
      );
    }

    // Refresh the local order row with the live status (best effort).
    let refreshed = null;
    try {
      const payment = await getPayment(paymentId, creds);
      updateOrderPayment(order.merchant_order_id, {
        payment_id: paymentId,
        status: payment.status,
      });
      refreshed = trimPayment(payment);
    } catch {
      // action succeeded; refresh is cosmetic
    }

    return NextResponse.json(
      {
        op: body.op,
        status: result.status ?? null,
        sub_status: result.sub_status ?? null,
        payment: refreshed,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof YunoApiError) {
      console.error(
        `[playground/ops] Yuno API error ${err.status}:`,
        JSON.stringify(err.body),
      );
      return NextResponse.json(
        { error: `Yuno API error (${err.status})`, details: err.body },
        { status: 502, headers: NO_STORE },
      );
    }
    console.error("[playground/ops] unexpected error:", err);
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
