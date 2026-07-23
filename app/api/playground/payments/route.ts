import { NextResponse } from "next/server";
import { createPayment, YunoApiError } from "@/lib/yuno";
import { getOrder, updateOrderPayment } from "@/lib/db";
import {
  paymentCapReached,
  requireWorkspaceFeature,
  workspaceCredentials,
} from "@/lib/workspaces";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string;
      oneTimeToken?: string;
      merchantOrderId?: string;
    };

    const gate = requireWorkspaceFeature(body.token, "checkout");
    if (!gate.ok) {
      return NextResponse.json(
        { error: gate.error },
        { status: gate.status, headers: NO_STORE },
      );
    }
    const { workspace } = gate;

    const { oneTimeToken, merchantOrderId } = body;
    if (!oneTimeToken || !merchantOrderId) {
      return NextResponse.json(
        { error: "oneTimeToken and merchantOrderId are required" },
        { status: 400, headers: NO_STORE },
      );
    }

    const order = getOrder(merchantOrderId);
    // Tenant isolation: an order is only payable through its own workspace.
    if (!order || order.workspace_id !== workspace.id) {
      return NextResponse.json(
        { error: "Order not found" },
        { status: 404, headers: NO_STORE },
      );
    }
    if (!order.checkout_session) {
      return NextResponse.json(
        { error: "Order has no checkout session" },
        { status: 409, headers: NO_STORE },
      );
    }

    if (paymentCapReached(workspace.id)) {
      return NextResponse.json(
        {
          error:
            "This workspace reached its payment cap. Ask your Yuno contact to raise it.",
        },
        { status: 429, headers: NO_STORE },
      );
    }

    const creds = workspaceCredentials(workspace);
    // auth_only holds the authorization for a later capture (Post-payment ops);
    // every other scenario lets the account's default capture behavior run.
    const authOnly = order.scenario === "auth_only";

    const payment = await createPayment(
      {
        account_id: creds.accountId,
        merchant_order_id: order.merchant_order_id,
        description: order.product ?? "Playground payment",
        country: order.country ?? workspace.default_country,
        amount: {
          currency: order.currency ?? workspace.default_currency,
          value: order.amount ?? 0, // decimal major units, NOT cents
        },
        checkout: { session: order.checkout_session },
        payment_method: {
          token: oneTimeToken,
          ...(authOnly ? { detail: { card: { capture: false } } } : {}),
        },
        workflow: "SDK_CHECKOUT",
        // Required or Yuno 400s INVALID_CUSTOMER_FOR_TOKEN (see api/payments).
        ...(order.customer_id
          ? { customer_payer: { id: order.customer_id } }
          : {}),
      },
      crypto.randomUUID(),
      creds,
    );

    updateOrderPayment(order.merchant_order_id, {
      payment_id: payment.id,
      status: payment.status,
    });

    const sdkActionRequired = Boolean(
      payment.checkout?.sdk_action_required ?? payment.sdk_action_required,
    );

    return NextResponse.json(
      {
        id: payment.id,
        status: payment.status,
        sub_status: payment.sub_status ?? null,
        sdk_action_required: sdkActionRequired,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof YunoApiError) {
      console.error(
        `[playground/payments] Yuno API error ${err.status}:`,
        JSON.stringify(err.body),
      );
      return NextResponse.json(
        { error: `Yuno API error (${err.status})`, details: err.body },
        { status: 502, headers: NO_STORE },
      );
    }
    console.error("[playground/payments] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to create payment" },
      { status: 500, headers: NO_STORE },
    );
  }
}
