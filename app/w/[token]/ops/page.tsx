"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { GlassCard, Button, Input, Badge } from "@/components/ui";

/**
 * Post-payment ops: inspect any payment made in this workspace, then
 * capture / void / refund its transactions. Every mutation has an inline
 * confirm step — these are real (sandbox) money movements on the
 * workspace's account.
 */

type OrderSummary = {
  merchantOrderId: string;
  product: string | null;
  scenario: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  paymentId: string | null;
  createdAt: string | null;
};

type Transaction = {
  id: string;
  type: string | null;
  status: string | null;
  amount: { currency?: string; value?: number } | null;
};

type PaymentDetail = {
  id: string;
  status: string;
  sub_status: string | null;
  amount: { currency?: string; value?: number } | null;
  transactions: Transaction[];
};

type PendingAction = {
  op: "capture" | "void" | "refund";
  transactionId: string;
  amount: string;
};

function toneFor(status: string | null | undefined) {
  if (!status) return "neutral" as const;
  if (/SUCCEED|APPROV|AUTHORIZ|CAPTUR/i.test(status)) return "success" as const;
  if (/DECLIN|REJECT|ERROR|CANCEL|VOID/i.test(status)) return "error" as const;
  return "pending" as const;
}

export default function PlaygroundOpsPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const call = useCallback(
    async (payload: Record<string, unknown>) => {
      const res = await fetch("/api/playground/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...payload }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      return json;
    },
    [token],
  );

  // Bump to re-run the list loader (defined inside the effect per lint rule).
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const json = await call({ op: "list" });
        if (!cancelled) setOrders(json.orders ?? []);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load payments");
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [call, reloadKey]);

  async function inspect(paymentId: string) {
    setError(null);
    setOutcome(null);
    setPending(null);
    setInspecting(paymentId);
    try {
      const json = await call({ op: "inspect", paymentId });
      setDetail(json.payment);
    } catch (e) {
      setDetail(null);
      setError(e instanceof Error ? e.message : "Failed to load payment");
    } finally {
      setInspecting(null);
    }
  }

  async function runAction() {
    if (!pending || !detail) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const payload: Record<string, unknown> = {
        op: pending.op,
        paymentId: detail.id,
        transactionId: pending.transactionId,
      };
      if (pending.op === "capture") payload.amount = Number(pending.amount);
      if (pending.op === "refund" && pending.amount.trim() !== "") {
        payload.amount = Number(pending.amount);
      }
      const json = await call(payload);
      setOutcome(
        `${pending.op} → ${json.status ?? "done"}${json.sub_status ? ` / ${json.sub_status}` : ""}`,
      );
      if (json.payment) setDetail(json.payment);
      setPending(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <GlassCard className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <h1 className="font-display uppercase tracking-tight text-2xl">
            Post-payment ops
          </h1>
          <Badge tone="success">sandbox</Badge>
        </div>
        <p className="text-sm text-neutral-400">
          Capture, void or refund any payment made in this workspace.{" "}
          <Link href={`/w/${token}`} className="text-primary underline">
            Back to playground
          </Link>
        </p>
      </GlassCard>

      {loaded && orders.length === 0 && (
        <GlassCard className="p-8 text-center">
          <p className="text-sm text-neutral-400">
            No payments yet — run a{" "}
            <Link
              href={`/w/${token}/checkout`}
              className="text-primary underline"
            >
              checkout scenario
            </Link>{" "}
            first. Auth-only payments are the interesting ones here: they wait
            for a capture.
          </p>
        </GlassCard>
      )}

      {orders.map((o) => (
        <GlassCard key={o.merchantOrderId} className="p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {o.scenario && <Badge tone="pending">{o.scenario}</Badge>}
            <span className="font-semibold text-sm text-ink">
              {o.amount} {o.currency}
            </span>
            <span className="font-mono text-xs text-neutral-400">
              {o.merchantOrderId}
            </span>
            {o.status && <Badge tone={toneFor(o.status)}>{o.status}</Badge>}
            <span className="ml-auto">
              {o.paymentId ? (
                <button
                  onClick={() => inspect(o.paymentId!)}
                  disabled={inspecting === o.paymentId}
                  className="px-3 py-1.5 rounded-btn text-xs font-semibold bg-primary text-white hover:bg-primary-dark transition-colors cursor-pointer disabled:opacity-50"
                >
                  {inspecting === o.paymentId ? "Loading…" : "Inspect"}
                </button>
              ) : (
                <span className="text-xs text-neutral-400">no payment</span>
              )}
            </span>
          </div>

          {detail && detail.id === o.paymentId && (
            <div className="mt-4 border-t border-white/60 pt-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge tone={toneFor(detail.status)}>{detail.status}</Badge>
                {detail.sub_status && (
                  <span className="text-xs font-semibold text-primary-dark">
                    {detail.sub_status}
                  </span>
                )}
                <span className="font-mono text-xs text-neutral-400">
                  {detail.id}
                </span>
              </div>

              {detail.transactions.map((t) => (
                <div
                  key={t.id}
                  className="rounded-2xl bg-white/50 border border-white/60 p-4"
                >
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <span className="font-semibold">{t.type ?? "TRANSACTION"}</span>
                    {t.status && (
                      <Badge tone={toneFor(t.status)}>{t.status}</Badge>
                    )}
                    {t.amount?.value !== undefined && (
                      <span className="text-neutral-500">
                        {t.amount.value} {t.amount.currency}
                      </span>
                    )}
                    <span className="font-mono text-xs text-neutral-400">
                      {t.id}
                    </span>
                  </div>

                  {!pending || pending.transactionId !== t.id ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="ghost"
                        className="px-4 py-1.5 text-xs"
                        onClick={() =>
                          setPending({
                            op: "capture",
                            transactionId: t.id,
                            amount: String(
                              t.amount?.value ?? detail.amount?.value ?? "",
                            ),
                          })
                        }
                      >
                        Capture…
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-4 py-1.5 text-xs"
                        onClick={() =>
                          setPending({ op: "void", transactionId: t.id, amount: "" })
                        }
                      >
                        Void / cancel…
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-4 py-1.5 text-xs"
                        onClick={() =>
                          setPending({ op: "refund", transactionId: t.id, amount: "" })
                        }
                      >
                        Refund…
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {pending.op !== "void" && (
                        <div className="w-36">
                          <Input
                            type="number"
                            min={0.01}
                            step={0.01}
                            aria-label="Amount (major units)"
                            placeholder={
                              pending.op === "refund" ? "blank = full" : "amount"
                            }
                            value={pending.amount}
                            onChange={(e) =>
                              setPending({ ...pending, amount: e.target.value })
                            }
                          />
                        </div>
                      )}
                      <Button
                        variant="lime"
                        className="px-4 py-1.5 text-xs"
                        disabled={busy}
                        onClick={runAction}
                      >
                        {busy
                          ? "Working…"
                          : `Confirm ${pending.op}${
                              pending.op === "refund" && pending.amount.trim() === ""
                                ? " (full)"
                                : ""
                            }`}
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-4 py-1.5 text-xs"
                        disabled={busy}
                        onClick={() => setPending(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              ))}

              {detail.transactions.length === 0 && (
                <p className="text-xs text-neutral-400">
                  No transactions on this payment yet.
                </p>
              )}
            </div>
          )}
        </GlassCard>
      ))}

      {(error || outcome) && (
        <GlassCard className="p-4">
          {outcome && (
            <p className="text-sm font-semibold text-primary-dark">{outcome}</p>
          )}
          {error && <p className="text-sm text-red-700">{error}</p>}
        </GlassCard>
      )}
    </div>
  );
}
