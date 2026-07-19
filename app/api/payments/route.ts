import { NextResponse } from "next/server";
import { createPayment, YunoApiError, YunoConfigError, getAccountId } from "@/lib/yuno";
import { getOrder, updateOrderPayment } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      oneTimeToken?: string;
      merchantOrderId?: string;
    };
    const { oneTimeToken, merchantOrderId } = body;
    if (!oneTimeToken || !merchantOrderId) {
      return NextResponse.json(
        { error: "oneTimeToken and merchantOrderId are required" },
        { status: 400 },
      );
    }

    const order = getOrder(merchantOrderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (!order.checkout_session) {
      return NextResponse.json(
        { error: "Order has no checkout session" },
        { status: 409 },
      );
    }

    const payment = await createPayment(
      {
        account_id: getAccountId(),
        merchant_order_id: order.merchant_order_id,
        description: order.product ?? "Montmare Reserva 250g",
        country: "BR",
        amount: {
          currency: order.currency ?? "BRL",
          value: order.amount ?? 89, // decimal major units, NOT cents
        },
        checkout: { session: order.checkout_session },
        payment_method: { token: oneTimeToken },
        workflow: "SDK_CHECKOUT",
      },
      crypto.randomUUID(),
    );

    updateOrderPayment(order.merchant_order_id, {
      payment_id: payment.id,
      status: payment.status,
    });

    const sdkActionRequired = Boolean(
      payment.checkout?.sdk_action_required ?? payment.sdk_action_required,
    );

    return NextResponse.json({
      id: payment.id,
      status: payment.status,
      sub_status: payment.sub_status ?? null,
      sdk_action_required: sdkActionRequired,
    });
  } catch (err) {
    if (err instanceof YunoConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    if (err instanceof YunoApiError) {
      console.error(
        `[payments] Yuno API error ${err.status}:`,
        JSON.stringify(err.body),
      );
      return NextResponse.json(
        { error: `Yuno API error (${err.status})`, details: err.body },
        { status: 502 },
      );
    }
    console.error("[payments] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to create payment" },
      { status: 500 },
    );
  }
}
