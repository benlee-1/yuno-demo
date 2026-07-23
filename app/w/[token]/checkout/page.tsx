"use client";

import { use, useRef, useState } from "react";
import Link from "next/link";
import type { SdkPaymentsInstance } from "@yuno-payments/sdk-web-types";
import { GlassCard, Button, Input, Badge } from "@/components/ui";

/**
 * Playground checkout: configure a scenario, mount the Yuno Web SDK with the
 * WORKSPACE's public key (fetched at runtime from the session route — never
 * build-time env), pay with test cards, see the outcome inline.
 */

type Scenario = "purchase" | "auth_only" | "decline" | "3ds";

const SCENARIOS: Array<{ key: Scenario; label: string; blurb: string }> = [
  {
    key: "purchase",
    label: "Purchase",
    blurb: "One-time payment with your account's default capture behavior.",
  },
  {
    key: "auth_only",
    label: "Authorize only",
    blurb: "Holds the authorization (capture: false) — capture it later from Post-payment ops.",
  },
  {
    key: "decline",
    label: "Decline",
    blurb: "Same purchase flow — use a declining test card to exercise your error handling.",
  },
  {
    key: "3ds",
    label: "3-D Secure",
    blurb: "Purchase with a 3DS test card; the SDK opens the challenge automatically.",
  },
];

/**
 * Yuno testing-gateway cards (expiry 11/28, CVV 123). Deterministic ONLY when
 * the account routes to the testing gateway — live provider sandboxes with
 * failover may approve "decline" cards.
 */
const TEST_CARDS: Record<Scenario, Array<{ number: string; note: string }>> = {
  purchase: [{ number: "4507 9900 0000 0002", note: "SUCCEEDED" }],
  auth_only: [{ number: "4507 9900 0000 0002", note: "authorized, not captured" }],
  decline: [
    { number: "4507 9900 0000 0010", note: "INSUFFICIENT_FUNDS" },
    { number: "4507 9900 0000 0028", note: "DECLINED_BY_BANK" },
    { number: "4507 9900 0000 0036", note: "DO_NOT_HONOR" },
  ],
  "3ds": [
    {
      number: "see docs.y.uno → 3DS testing",
      note: "requires 3DS enabled on your account; challenge OTP 1234",
    },
  ],
};

type Result = {
  paymentId: string;
  status: string;
  subStatus: string | null;
};

export default function PlaygroundCheckoutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [scenario, setScenario] = useState<Scenario>("purchase");
  const [config, setConfig] = useState({ country: "", currency: "", amount: "25" });
  const [phase, setPhase] = useState<
    "configure" | "starting" | "ready" | "paying" | "done"
  >("configure");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<{
    merchantOrderId: string;
    country: string;
    currency: string;
    amount: number;
  } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const yunoRef = useRef<SdkPaymentsInstance | null>(null);
  const tokenizedRef = useRef(false);

  async function start() {
    setError(null);
    setPhase("starting");
    try {
      const res = await fetch("/api/playground/checkout/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          scenario,
          country: config.country || undefined,
          currency: config.currency || undefined,
          amount: Number(config.amount) || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create session");

      const { checkoutSession, merchantOrderId, publicApiKey, country, currency, amount } =
        data as {
          checkoutSession: string;
          merchantOrderId: string;
          publicApiKey: string;
          country: string;
          currency: string;
          amount: number;
        };
      setSession({ merchantOrderId, country, currency, amount });

      const { loadScript } = await import("@yuno-payments/sdk-web");
      const sdk = await loadScript({ env: "sandbox" });
      const yuno = await sdk.initialize(publicApiKey);
      yunoRef.current = yuno;

      await yuno.startCheckout({
        checkoutSession,
        elementSelector: "#yuno-checkout",
        countryCode: country,
        language: "en",
        showLoading: true,
        renderMode: { type: "element" },
        async createPayment(oneTimeToken: string) {
          tokenizedRef.current = true;
          try {
            const payRes = await fetch("/api/playground/payments", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token, oneTimeToken, merchantOrderId }),
            });
            const payData = await payRes.json();
            if (!payRes.ok) throw new Error(payData.error || "Payment request failed");
            if (payData.sdk_action_required) {
              await yuno.continuePayment({ showPaymentStatus: true });
            } else {
              setResult({
                paymentId: payData.id,
                status: payData.status,
                subStatus: payData.sub_status,
              });
              setPhase("done");
            }
          } catch (e) {
            setPhase("ready");
            setError(e instanceof Error ? e.message : "Payment failed");
          }
        },
        paymentResult(status) {
          setResult((prev) => ({
            paymentId: prev?.paymentId ?? "(see events)",
            status: String(status),
            subStatus: prev?.subStatus ?? null,
          }));
          setPhase("done");
        },
        error(message: string) {
          setPhase("ready");
          setError(message || "Something went wrong with the payment form.");
        },
      });
      await yuno.mountCheckout();
      setPhase("ready");
    } catch (e) {
      // Back to the config card — clearing session also unmounts the
      // payment section (its render is keyed on `session`).
      setSession(null);
      setPhase("configure");
      setError(e instanceof Error ? e.message : "Failed to start checkout");
    }
  }

  async function pay() {
    setError(null);
    setPhase("paying");
    tokenizedRef.current = false;
    try {
      await yunoRef.current?.startPayment();
      // SDK blocks on client-side validation without throwing — re-enable.
      if (!tokenizedRef.current) setPhase("ready");
    } catch (e) {
      setPhase("ready");
      setError(e instanceof Error ? e.message : "Failed to start payment");
    }
  }

  // The payment section must be in the DOM BEFORE the SDK mounts into
  // #yuno-checkout, so render it as soon as the session exists (not on phase
  // "ready" — that flips only after mountCheckout, which needs the div).
  const configuring = !session;
  // A held authorization comes back status PENDING + sub_status AUTHORIZED —
  // for auth_only that IS the success outcome, not a pending one.
  const authHeld =
    result != null &&
    /PENDING/i.test(result.status) &&
    /AUTHORIZ/i.test(result.subStatus ?? "");
  const statusTone = result
    ? /SUCCEED|APPROV|AUTHORIZ/i.test(result.status) || authHeld
      ? "success"
      : /DECLIN|REJECT|ERROR|CANCEL/i.test(result.status)
        ? "error"
        : "pending"
    : "neutral";

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <GlassCard className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <h1 className="font-display uppercase tracking-tight text-2xl">
            Checkout scenarios
          </h1>
          <Badge tone="success">sandbox</Badge>
        </div>
        <p className="text-sm text-neutral-400">
          Pick a scenario, set the order, pay with a test card.{" "}
          <Link href={`/w/${token}`} className="text-primary underline">
            Back to playground
          </Link>
        </p>
      </GlassCard>

      {configuring && (
        <GlassCard className="p-6 sm:p-8">
          <div className="grid sm:grid-cols-2 gap-3 mb-4">
            {SCENARIOS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setScenario(s.key)}
                className={`text-left p-4 rounded-2xl border transition-colors cursor-pointer ${
                  scenario === s.key
                    ? "bg-primary text-white border-primary"
                    : "bg-white/50 border-white/60 hover:bg-white/80"
                }`}
              >
                <span className="font-display uppercase tracking-wide text-sm block mb-1">
                  {s.label}
                </span>
                <span
                  className={`text-xs leading-relaxed ${
                    scenario === s.key ? "text-white/80" : "text-neutral-400"
                  }`}
                >
                  {s.blurb}
                </span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Input
              placeholder="Country (default)"
              aria-label="Country (2-letter)"
              maxLength={2}
              value={config.country}
              onChange={(e) =>
                setConfig((c) => ({ ...c, country: e.target.value.toUpperCase() }))
              }
            />
            <Input
              placeholder="Currency (default)"
              aria-label="Currency (3-letter)"
              maxLength={3}
              value={config.currency}
              onChange={(e) =>
                setConfig((c) => ({ ...c, currency: e.target.value.toUpperCase() }))
              }
            />
            <Input
              type="number"
              min={0.01}
              step={0.01}
              aria-label="Amount (major units)"
              value={config.amount}
              onChange={(e) => setConfig((c) => ({ ...c, amount: e.target.value }))}
            />
          </div>
          {error && <p className="text-sm text-red-700 mb-3">{error}</p>}
          <Button onClick={start} disabled={phase === "starting"} className="w-full">
            {phase === "starting" ? "Creating session…" : "Start checkout"}
          </Button>
        </GlassCard>
      )}

      {!configuring && phase !== "done" && session && (
        <div className="grid lg:grid-cols-[1fr_1.4fr] gap-6 items-start">
          <div className="flex flex-col gap-4">
            <GlassCard className="p-6">
              <h2 className="font-display uppercase tracking-tight text-lg mb-4">
                Test order
              </h2>
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-neutral-400">Scenario</dt>
                  <dd className="font-semibold">{scenario}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-400">Market</dt>
                  <dd className="font-semibold">
                    {session.country} · {session.currency}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-400">Amount</dt>
                  <dd className="font-semibold">
                    {session.amount} {session.currency}
                  </dd>
                </div>
              </dl>
            </GlassCard>
            <GlassCard className="p-4">
              <p className="text-xs font-display uppercase tracking-wide text-primary mb-2">
                Test cards — {scenario}
              </p>
              <div className="flex flex-col gap-2 text-xs text-ink/80">
                {TEST_CARDS[scenario].map((c) => (
                  <div key={c.number} className="flex items-center justify-between gap-2">
                    <code className="font-mono">{c.number}</code>
                    <span className="text-neutral-400">{c.note}</span>
                  </div>
                ))}
                <p className="mt-1 pt-2 border-t border-white/60 text-neutral-400 leading-relaxed">
                  Expiry 11/28 · CVV 123. Outcomes are deterministic on Yuno&apos;s
                  testing gateway; live provider sandboxes in your routing may
                  approve &ldquo;decline&rdquo; cards.
                </p>
              </div>
            </GlassCard>
          </div>
          <GlassCard className="p-6 sm:p-8">
            {error && (
              <div className="mb-4 rounded-2xl bg-red-50/80 backdrop-blur border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
            {phase === "starting" && (
              <div className="py-10 text-center text-sm text-neutral-400 animate-pulse">
                Loading payment methods…
              </div>
            )}
            <div id="yuno-checkout" />
            <Button
              onClick={pay}
              disabled={phase !== "ready"}
              className="w-full mt-6 py-4 text-base font-bold"
            >
              {phase === "paying"
                ? "Processing…"
                : `Pay ${session.amount} ${session.currency}`}
            </Button>
          </GlassCard>
        </div>
      )}

      {phase === "done" && result && (
        <GlassCard className="p-8 text-center">
          <Badge tone={statusTone} className="mb-4">
            {result.status}
          </Badge>
          <h2 className="font-display uppercase tracking-tight text-2xl mb-2">
            {statusTone === "success"
              ? authHeld || scenario === "auth_only"
                ? "Authorization held"
                : "Payment approved"
              : statusTone === "error"
                ? "Payment declined"
                : "Payment pending"}
          </h2>
          <dl className="inline-flex flex-col gap-1 text-sm text-left mx-auto mb-6">
            <div className="flex gap-3 justify-between">
              <dt className="text-neutral-400">Payment id</dt>
              <dd className="font-mono text-xs">{result.paymentId}</dd>
            </div>
            {result.subStatus && (
              <div className="flex gap-3 justify-between">
                <dt className="text-neutral-400">Sub-status</dt>
                <dd className="font-semibold">{result.subStatus}</dd>
              </div>
            )}
            {session && (
              <div className="flex gap-3 justify-between">
                <dt className="text-neutral-400">Order</dt>
                <dd className="font-mono text-xs">{session.merchantOrderId}</dd>
              </div>
            )}
          </dl>
          <div className="flex flex-wrap gap-3 justify-center">
            <Button onClick={() => window.location.reload()}>Run another test</Button>
            <Link href={`/w/${token}`}>
              <Button variant="ghost">Back to playground</Button>
            </Link>
          </div>
          {scenario === "auth_only" && statusTone === "success" && (
            <p className="mt-4 text-xs text-neutral-400">
              The authorization is on hold — capture or void it from
              Post-payment ops (next phase).
            </p>
          )}
        </GlassCard>
      )}
    </div>
  );
}
