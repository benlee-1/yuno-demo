"use client";

import {
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { GlassCard, Badge } from "@/components/ui";

/**
 * Webhook inspector: this workspace's dedicated endpoint + a live feed of
 * everything Yuno delivers to it, with HMAC verification badges.
 */

type EventItem = {
  id: number;
  type: string | null;
  type_event: string | null;
  payment_id: string | null;
  merchant_order_id: string | null;
  status: string | null;
  signature_valid: number | null;
  received_at: string | null;
  raw: unknown;
};

const POLL_MS = 3000;

function subscribeNoop(): () => void {
  return () => {};
}

function relTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function SignatureBadge({ value }: { value: number | null }) {
  if (value === 1) return <Badge tone="success">verified ✓</Badge>;
  if (value === 0) return <Badge tone="error">invalid sig</Badge>;
  return <Badge tone="neutral">unverified</Badge>;
}

export default function PlaygroundWebhooksPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const [events, setEvents] = useState<EventItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [endpointPath, setEndpointPath] = useState<string | null>(null);
  const [hmacConfigured, setHmacConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const latestId = useRef(0);

  const origin = useSyncExternalStore(
    subscribeNoop,
    () => window.location.origin,
    () => "",
  );
  const endpoint = endpointPath && origin ? `${origin}${endpointPath}` : "";

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch("/api/playground/webhooks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, sinceId: latestId.current }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `Request failed (${res.status})`);
          return;
        }
        setError(null);
        setEndpointPath(json.endpointPath ?? null);
        setHmacConfigured(Boolean(json.hmacConfigured));
        const fresh = (json.events ?? []) as EventItem[];
        if (fresh.length > 0) {
          latestId.current = Math.max(
            latestId.current,
            ...fresh.map((e) => e.id),
          );
          setEvents((prev) => [...fresh, ...prev].slice(0, 100));
        }
      } catch {
        // network hiccup — retry on the next tick
      } finally {
        if (!cancelled) {
          setNow(Date.now());
          setLoaded(true);
        }
      }
    }
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  const copyEndpoint = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — nothing to do
    }
  }, [endpoint]);

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <GlassCard className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <h1 className="font-display uppercase tracking-tight text-2xl">
            Webhook inspector
          </h1>
          <Badge tone="success">sandbox</Badge>
          <span className="relative flex h-2.5 w-2.5" aria-label="live">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lime opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-lime" />
          </span>
        </div>
        <p className="text-sm text-neutral-400 mb-4">
          Paste this endpoint into your Yuno dashboard (Developers → Webhooks)
          and every notification for your account lands here in real time.{" "}
          <Link href={`/w/${token}`} className="text-primary underline">
            Back to playground
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="flex-1 min-w-0 truncate font-mono text-xs sm:text-sm text-primary-dark bg-white/70 border border-white/60 rounded-btn px-4 py-2.5">
            {endpoint || "…"}
          </code>
          <button
            onClick={copyEndpoint}
            disabled={!endpoint}
            className="px-4 py-2.5 rounded-btn text-sm font-semibold bg-primary text-white hover:bg-primary-dark transition-all duration-200 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        {hmacConfigured !== null && (
          <p className="mt-3 text-xs text-neutral-400">
            {hmacConfigured ? (
              <>
                HMAC signing is <strong>required</strong> on this endpoint —
                tick &ldquo;Use HMAC signing&rdquo; in the dashboard with the
                secret your Yuno contact configured; deliveries without a valid
                signature are rejected (401).
              </>
            ) : (
              <>
                No HMAC secret is configured for this workspace — deliveries
                are accepted and shown as <em>unverified</em>. Ask your Yuno
                contact to add a secret to test signature verification.
              </>
            )}
          </p>
        )}
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </GlassCard>

      {loaded && !error && events.length === 0 && (
        <GlassCard className="p-8 text-center">
          <p className="text-sm text-neutral-400">
            No deliveries yet. Configure the endpoint in the dashboard, then
            run a{" "}
            <Link
              href={`/w/${token}/checkout`}
              className="text-primary underline"
            >
              checkout scenario
            </Link>{" "}
            — payment events show up here within seconds.
          </p>
        </GlassCard>
      )}

      {events.map((event) => {
        const label = event.type_event?.includes(".")
          ? event.type_event
          : [event.type, event.type_event].filter(Boolean).join(".") ||
            "unknown";
        return (
          <GlassCard key={event.id} className="overflow-hidden">
            <details className="group">
              <summary className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className="font-semibold text-sm text-ink">{label}</span>
                {event.merchant_order_id && (
                  <span className="text-xs text-neutral-400">
                    {event.merchant_order_id}
                  </span>
                )}
                {event.status && (
                  <span className="text-xs font-semibold text-primary-dark">
                    {event.status}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-3">
                  <SignatureBadge value={event.signature_valid} />
                  <span className="text-xs text-neutral-400 tabular-nums whitespace-nowrap">
                    {relTime(event.received_at, now)}
                  </span>
                  <span
                    className="text-neutral-400 text-xs transition-transform duration-200 group-open:rotate-180"
                    aria-hidden
                  >
                    ▾
                  </span>
                </span>
              </summary>
              <div className="border-t border-white/50 bg-white/40 px-5 py-4">
                <pre className="font-mono text-xs leading-relaxed text-ink/80 overflow-x-auto whitespace-pre">
                  {typeof event.raw === "string"
                    ? event.raw
                    : JSON.stringify(event.raw, null, 2)}
                </pre>
              </div>
            </details>
          </GlassCard>
        );
      })}
    </div>
  );
}
