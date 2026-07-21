import Link from "next/link";
import { GlassCard, Badge } from "@/components/ui";
import { getOrder, updateOrderPayment } from "@/lib/db";
import { getPayment } from "@/lib/yuno";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUCCESS_STATUSES = new Set(["SUCCEEDED", "APPROVED"]);
const FAIL_STATUSES = new Set([
  "DECLINED",
  "REJECTED",
  "ERROR",
  "FAIL",
  "REJECT",
  "CANCELLED",
  "CANCELED",
  "EXPIRED",
]);

export default async function ResultPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; status?: string }>;
}) {
  const { order: orderId } = await searchParams;
  const order = orderId ? getOrder(orderId) : undefined;

  let status = order?.status ?? null;
  let paymentId = order?.payment_id ?? null;

  // Live-refresh the payment status from Yuno when we have a payment id.
  if (order?.payment_id) {
    try {
      const payment = await getPayment(order.payment_id);
      if (payment?.status) {
        status = payment.status;
        paymentId = payment.id ?? paymentId;
        if (status && status !== order.status) {
          updateOrderPayment(order.merchant_order_id, {
            payment_id: order.payment_id,
            status,
          });
        }
      }
    } catch {
      // Credentials missing or API unavailable — fall back to stored status.
    }
  }

  const outcome: "success" | "declined" | "pending" =
    status && SUCCESS_STATUSES.has(status)
      ? "success"
      : status && FAIL_STATUSES.has(status)
        ? "declined"
        : "pending";

  return (
    <div className="max-w-xl mx-auto">
      <GlassCard className="p-8 sm:p-10 text-center">
        {!order ? (
          <>
            <h1 className="font-display uppercase tracking-tight text-2xl mb-2">
              Order not found
            </h1>
            <p className="text-sm text-neutral-400 mb-6">
              We could not find that order in the demo database.
            </p>
          </>
        ) : (
          <>
            <div className="mb-6 grid place-items-center" aria-hidden>
              {outcome === "success" ? (
                <span className="stamp-ink stamp-in text-primary text-4xl sm:text-5xl [--tilt:-7deg]">
                  Approved ✓
                </span>
              ) : outcome === "declined" ? (
                <span className="stamp-ink stamp-in text-red-600 text-4xl sm:text-5xl [--tilt:5deg]">
                  Denied
                </span>
              ) : (
                <span className="stamp-ink text-neutral-400 text-3xl [--tilt:-3deg]">
                  Pending…
                </span>
              )}
            </div>
            <h1 className="font-display uppercase tracking-tight text-2xl mb-1">
              {outcome === "success"
                ? "Payment approved"
                : outcome === "declined"
                  ? "Payment declined"
                  : "Payment pending"}
            </h1>
            <p className="text-sm text-neutral-400 mb-6">
              {outcome === "success"
                ? "Your 10X Blend is on its way (in sandbox spirit)."
                : outcome === "declined"
                  ? "The transaction was not approved. Try another test card."
                  : "We are waiting for the payment to settle."}
            </p>

            <div className="text-left bg-white/50 border border-white/60 rounded-2xl p-5 mb-6">
              <dl className="flex flex-col gap-3 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-neutral-400">Order</dt>
                  <dd className="font-mono font-semibold">
                    {order.merchant_order_id}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-neutral-400">Customer</dt>
                  <dd className="font-semibold">{order.customer_name}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-neutral-400">Amount</dt>
                  <dd className="font-semibold">R$ 89,00</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-neutral-400">Payment ID</dt>
                  <dd className="font-mono text-xs break-all">
                    {paymentId ?? "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 items-center">
                  <dt className="text-neutral-400">Status</dt>
                  <dd>
                    <Badge
                      tone={
                        outcome === "success"
                          ? "success"
                          : outcome === "declined"
                            ? "error"
                            : "pending"
                      }
                    >
                      {status ?? "UNKNOWN"}
                    </Badge>
                  </dd>
                </div>
              </dl>
            </div>
          </>
        )}
        <Link
          href="/"
          className="inline-flex items-center justify-center px-6 py-3 rounded-btn font-semibold bg-primary text-white hover:bg-primary-dark transition-colors"
        >
          Back to store
        </Link>
      </GlassCard>
    </div>
  );
}
