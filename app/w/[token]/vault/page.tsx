"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SdkPaymentsInstance } from "@yuno-payments/sdk-web-types";
import { GlassCard, Button, Input, Badge } from "@/components/ui";

/**
 * Vault & subscriptions: $0 verify a card (vault_on_success), watch the
 * vaulted token arrive (polled — can take up to ~80s), then fire an MIT
 * renewal against it. The MIT is auth-only; capture it in Post-payment ops.
 */

type Step = "intro" | "starting" | "card" | "verifying" | "vaulting" | "vaulted";

type MitResult = {
  id: string;
  merchantOrderId: string;
  status: string;
  sub_status: string | null;
  transactionId: string | null;
};

export default function PlaygroundVaultPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [step, setStep] = useState<Step>("intro");
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<string | null>(null);
  const [vaultedToken, setVaultedToken] = useState<string | null>(null);
  const [mitAmount, setMitAmount] = useState("15");
  const [mitBusy, setMitBusy] = useState(false);
  const [mitResult, setMitResult] = useState<MitResult | null>(null);
  const yunoRef = useRef<SdkPaymentsInstance | null>(null);
  const tokenizedRef = useRef(false);

  async function callVault(payload: Record<string, unknown>) {
    const res = await fetch("/api/playground/vault", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...payload }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }

  async function start() {
    setError(null);
    setStep("starting");
    try {
      const data = await callVault({ op: "session" });
      const { checkoutSession, merchantOrderId, publicApiKey, country } =
        data as {
          checkoutSession: string;
          merchantOrderId: string;
          publicApiKey: string;
          country: string;
        };
      setOrderId(merchantOrderId);
      setStep("card"); // render #yuno-checkout BEFORE the SDK mounts into it

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
            const out = await callVault({
              op: "verify",
              oneTimeToken,
              merchantOrderId,
            });
            setVerifyStatus(
              `${out.status}${out.sub_status ? ` / ${out.sub_status}` : ""}`,
            );
            if (out.sdk_action_required) {
              await yuno.continuePayment({ showPaymentStatus: true });
            }
            if (out.vaultedToken) {
              setVaultedToken(out.vaultedToken);
              setStep("vaulted");
            } else {
              setStep("vaulting"); // poll for the token
            }
          } catch (e) {
            setStep("card");
            setError(e instanceof Error ? e.message : "Verification failed");
          }
        },
        paymentResult() {
          // Verification results are handled in createPayment above.
        },
        error(message: string) {
          setStep("card");
          setError(message || "Something went wrong with the card form.");
        },
      });
      await yuno.mountCheckout();
    } catch (e) {
      setStep("intro");
      setError(e instanceof Error ? e.message : "Failed to start verification");
    }
  }

  async function verify() {
    setError(null);
    setStep("verifying");
    tokenizedRef.current = false;
    try {
      await yunoRef.current?.startPayment();
      // SDK blocks on client-side validation without throwing — re-enable.
      if (!tokenizedRef.current) setStep("card");
    } catch (e) {
      setStep("card");
      setError(e instanceof Error ? e.message : "Failed to start verification");
    }
  }

  // Poll for the vaulted token — it can take up to ~80s to appear.
  useEffect(() => {
    if (step !== "vaulting" || !orderId) return;
    let cancelled = false;
    let tries = 0;
    const timer = setInterval(async () => {
      tries += 1;
      try {
        const out = await callVault({ op: "token", merchantOrderId: orderId });
        if (cancelled) return;
        setVerifyStatus(
          `${out.status}${out.sub_status ? ` / ${out.sub_status}` : ""}`,
        );
        if (out.vaultedToken) {
          setVaultedToken(out.vaultedToken);
          setStep("vaulted");
        } else if (/DECLINED|ERROR|REJECTED|CANCELLED/.test(String(out.status))) {
          setError(`Verification ${out.status} — no token will arrive.`);
          setStep("card");
        } else if (tries >= 12) {
          setError(
            "No vaulted token after ~90s — the account/provider may not support vaulting. Check the payment in Post-payment ops.",
          );
          setStep("card");
        }
      } catch {
        // transient — keep polling
      }
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, orderId]);

  async function runMit() {
    if (!orderId) return;
    setMitBusy(true);
    setError(null);
    try {
      const out = await callVault({
        op: "mit",
        merchantOrderId: orderId,
        amount: Number(mitAmount),
      });
      setMitResult(out as MitResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "MIT failed");
    } finally {
      setMitBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <GlassCard className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <h1 className="font-display uppercase tracking-tight text-2xl">
            Vault &amp; subscriptions
          </h1>
          <Badge tone="success">sandbox</Badge>
        </div>
        <p className="text-sm text-neutral-400">
          Verify a card with a $0 auth, vault it, then charge a
          merchant-initiated renewal.{" "}
          <Link href={`/w/${token}`} className="text-primary underline">
            Back to playground
          </Link>
        </p>
      </GlassCard>

      {error && (
        <div className="rounded-2xl bg-red-50/80 backdrop-blur border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {(step === "intro" || step === "starting") && (
        <GlassCard className="p-8 text-center">
          <p className="text-sm text-neutral-400 mb-5 max-w-md mx-auto">
            Step 1 verifies the card without charging it
            (<code className="font-mono text-xs">verify: true</code>,{" "}
            <code className="font-mono text-xs">vault_on_success: true</code>,
            stored credentials CARD_ON_FILE / FIRST). Use the success test card
            4507 9900 0000 0002 · 11/28 · 123.
          </p>
          <Button onClick={start} disabled={step === "starting"}>
            {step === "starting" ? "Creating session…" : "Start verification"}
          </Button>
        </GlassCard>
      )}

      {(step === "card" || step === "verifying" || step === "vaulting") && (
        <GlassCard className="p-6 sm:p-8">
          <div id="yuno-checkout" />
          {step !== "vaulting" ? (
            <Button
              onClick={verify}
              disabled={step !== "card"}
              className="w-full mt-6 py-4 text-base font-bold"
            >
              {step === "verifying"
                ? "Verifying…"
                : "Verify card — no charge"}
            </Button>
          ) : (
            <div className="mt-6 text-center">
              <Badge tone="pending" className="mb-2">
                {verifyStatus ?? "verification sent"}
              </Badge>
              <p className="text-sm text-neutral-400 animate-pulse">
                Waiting for the vaulted token (can take up to ~80s)…
              </p>
            </div>
          )}
        </GlassCard>
      )}

      {step === "vaulted" && (
        <GlassCard className="p-6 sm:p-8">
          <div className="flex items-center gap-3 mb-3">
            <Badge tone="success">card vaulted</Badge>
            {verifyStatus && (
              <span className="text-xs font-semibold text-primary-dark">
                {verifyStatus}
              </span>
            )}
          </div>
          <p className="text-sm text-neutral-400 mb-2">
            Vaulted token — this is what you store instead of a card:
          </p>
          <code className="block font-mono text-xs text-primary-dark bg-white/70 border border-white/60 rounded-btn px-4 py-2.5 mb-6 break-all">
            {vaultedToken}
          </code>

          {!mitResult ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className="w-36">
                <Input
                  type="number"
                  min={0.01}
                  step={0.01}
                  aria-label="Renewal amount (major units)"
                  value={mitAmount}
                  onChange={(e) => setMitAmount(e.target.value)}
                />
              </div>
              <Button onClick={runMit} disabled={mitBusy}>
                {mitBusy ? "Charging…" : "Charge renewal (MIT)"}
              </Button>
              <span className="text-xs text-neutral-400">
                stored credentials SUBSCRIPTION / USED, auth-only
              </span>
            </div>
          ) : (
            <div className="rounded-2xl bg-white/50 border border-white/60 p-4">
              <div className="flex flex-wrap items-center gap-3 text-sm mb-2">
                <Badge
                  tone={
                    /DECLIN|REJECT|ERROR/i.test(mitResult.status)
                      ? "error"
                      : "success"
                  }
                >
                  {mitResult.status}
                </Badge>
                {mitResult.sub_status && (
                  <span className="text-xs font-semibold text-primary-dark">
                    {mitResult.sub_status}
                  </span>
                )}
                <span className="font-mono text-xs text-neutral-400">
                  {mitResult.id}
                </span>
              </div>
              <p className="text-sm text-neutral-400">
                The renewal is authorized but not captured —{" "}
                <Link
                  href={`/w/${token}/ops`}
                  className="text-primary underline"
                >
                  capture it in Post-payment ops
                </Link>
                .
              </p>
            </div>
          )}
        </GlassCard>
      )}
    </div>
  );
}
