"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { SdkPaymentsInstance } from "@yuno-payments/sdk-web-types";
import { GlassCard, Button, Badge } from "@/components/ui";

const PRODUCT = "Montmare Reserva 250g";

function CheckoutInner() {
  const searchParams = useSearchParams();
  const name = searchParams.get("name") || "Maria Silva";
  const email = searchParams.get("email") || "";

  const [phase, setPhase] = useState<"loading" | "ready" | "paying">("loading");
  const [error, setError] = useState<string | null>(null);
  const [showTestCards, setShowTestCards] = useState(false);
  const yunoRef = useRef<SdkPaymentsInstance | null>(null);
  const startedRef = useRef(false);
  const tokenizedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // guard concurrent double-run
    startedRef.current = true;

    let cancelled = false;

    async function start() {
      try {
        const res = await fetch("/api/checkout/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to create checkout session");
        }
        const { checkoutSession, merchantOrderId } = data as {
          checkoutSession: string;
          merchantOrderId: string;
        };
        if (cancelled) return;

        const publicApiKey = process.env.NEXT_PUBLIC_YUNO_PUBLIC_API_KEY;
        if (!publicApiKey) {
          throw new Error(
            "Missing NEXT_PUBLIC_YUNO_PUBLIC_API_KEY — fill .env.local",
          );
        }

        const { loadScript } = await import("@yuno-payments/sdk-web");
        const sdk = await loadScript({ env: "sandbox" });
        const yuno = await sdk.initialize(publicApiKey);
        yunoRef.current = yuno;
        if (cancelled) return;

        await yuno.startCheckout({
          checkoutSession,
          elementSelector: "#yuno-checkout",
          countryCode: "BR",
          language: "en",
          showLoading: true,
          renderMode: { type: "element" },
          async createPayment(oneTimeToken: string) {
            tokenizedRef.current = true;
            try {
              const payRes = await fetch("/api/payments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ oneTimeToken, merchantOrderId }),
              });
              const payData = await payRes.json();
              if (!payRes.ok) {
                throw new Error(payData.error || "Payment request failed");
              }
              if (payData.sdk_action_required) {
                await yuno.continuePayment({ showPaymentStatus: true });
              } else {
                window.location.href = `/checkout/result?order=${merchantOrderId}`;
              }
            } catch (e) {
              setPhase("ready");
              setError(e instanceof Error ? e.message : "Payment failed");
            }
          },
          paymentResult(status) {
            window.location.href = `/checkout/result?order=${merchantOrderId}&status=${status}`;
          },
          error(message: string) {
            setPhase("ready");
            setError(message || "Something went wrong with the payment form.");
          },
        });
        await yuno.mountCheckout();
        if (!cancelled) setPhase("ready");
      } catch (e) {
        if (!cancelled) {
          setPhase("ready");
          setError(e instanceof Error ? e.message : "Failed to start checkout");
        }
      }
    }

    start();
    return () => {
      // Cancel this run AND allow the replacement effect run to restart.
      // (With the old `cancelled`-only cleanup, dev StrictMode deadlocked the
      // checkout after client-side navigation: run 1 was cancelled, run 2
      // bailed on startedRef, and the SDK never mounted.)
      cancelled = true;
      startedRef.current = false;
    };
  }, [name, email]);

  async function pay() {
    setError(null);
    setPhase("paying");
    tokenizedRef.current = false;
    try {
      await yunoRef.current?.startPayment();
      // startPayment resolves without throwing when the SDK blocks on
      // client-side field validation (e.g. expired date) — no token is
      // created and no callback fires, so re-enable the button for a retry.
      if (!tokenizedRef.current) {
        setPhase("ready");
      }
    } catch (e) {
      setPhase("ready");
      setError(e instanceof Error ? e.message : "Failed to start payment");
    }
  }

  return (
    <div className="grid lg:grid-cols-[1fr_1.4fr] gap-6 items-start">
      {/* Order summary */}
      <div className="flex flex-col gap-4">
        <GlassCard className="p-6">
          <h2 className="text-lg font-bold mb-4">Order summary</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-neutral-400">Customer</dt>
              <dd className="font-semibold">{name}</dd>
            </div>
            {email && (
              <div className="flex justify-between">
                <dt className="text-neutral-400">Email</dt>
                <dd className="font-semibold">{email}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-neutral-400">Product</dt>
              <dd className="font-semibold">{PRODUCT}</dd>
            </div>
            <div className="flex justify-between border-t border-white/60 pt-3">
              <dt className="font-bold">Total</dt>
              <dd className="font-extrabold text-primary text-lg">R$ 89,00</dd>
            </div>
          </dl>
        </GlassCard>

        {/* Test card hints */}
        <GlassCard className="p-4">
          <button
            type="button"
            onClick={() => setShowTestCards((v) => !v)}
            className="w-full flex items-center justify-between text-sm font-semibold text-primary cursor-pointer"
          >
            <span>Sandbox test cards</span>
            <span aria-hidden>{showTestCards ? "−" : "+"}</span>
          </button>
          {showTestCards && (
            <div className="mt-3 flex flex-col gap-2 text-xs text-ink/80">
              <div className="flex items-center justify-between gap-2">
                <Badge tone="success">Success</Badge>
                <code className="font-mono">4507 9900 0000 0002</code>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Badge tone="pending">No funds</Badge>
                <code className="font-mono">4507 9900 0000 0010</code>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Badge tone="error">Declined</Badge>
                <code className="font-mono">4507 9900 0000 0028</code>
              </div>
              <p className="mt-1 text-neutral-400">
                Expiry 11/28 · CVV 123 · Holder: John Doe
              </p>
            </div>
          )}
        </GlassCard>
      </div>

      {/* Payment form */}
      <GlassCard className="p-6 sm:p-8">
        <h1 className="text-xl font-extrabold mb-1">Checkout</h1>
        <p className="text-sm text-neutral-400 mb-5">
          Powered by Yuno — sandbox mode, no real charges.
        </p>

        {error && (
          <div className="mb-4 rounded-2xl bg-red-50/80 backdrop-blur border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {phase === "loading" && (
          <div className="py-10 text-center text-sm text-neutral-400 animate-pulse">
            Loading payment methods…
          </div>
        )}

        <div id="yuno-checkout" />

        <Button
          onClick={pay}
          disabled={phase !== "ready"}
          className="w-full mt-6"
        >
          {phase === "paying" ? "Processing…" : "Pay R$ 89,00"}
        </Button>

        <p className="mt-4 text-center text-xs text-neutral-400">
          <Link href="/" className="underline hover:text-primary">
            Back to store
          </Link>
        </p>
      </GlassCard>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense
      fallback={
        <div className="py-10 text-center text-sm text-neutral-400">
          Loading checkout…
        </div>
      }
    >
      <CheckoutInner />
    </Suspense>
  );
}
