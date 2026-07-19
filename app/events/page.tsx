"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { GlassCard, Badge } from "@/components/ui";
import { Marquee } from "@/components/marquee";

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

function toneFor(
  typeEvent: string | null,
): "success" | "error" | "pending" | "neutral" {
  if (!typeEvent) return "neutral";
  if (typeEvent.includes("chargeback")) return "error";
  if (typeEvent.includes("refund")) return "success";
  if (typeEvent.includes("purchase")) return "pending";
  return "neutral";
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

function truncateId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id;
}

function prettyRaw(raw: unknown): string {
  if (raw === null || raw === undefined) return "(empty)";
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw, null, 2);
}

function SignatureBadge({ value }: { value: number | null }) {
  if (value === 1) return <Badge tone="success">verified ✓</Badge>;
  if (value === 0) return <Badge tone="error">invalid sig</Badge>;
  return <Badge tone="neutral">unverified</Badge>;
}

function EventRow({ event, now }: { event: EventItem; now: number }) {
  // Live payloads send type_event already dotted ("payment.purchase") —
  // avoid rendering "payment.payment.purchase".
  const label = event.type_event?.includes(".")
    ? event.type_event
    : [event.type, event.type_event].filter(Boolean).join(".") || "unknown";
  return (
    <GlassCard className="event-enter overflow-hidden transition-transform duration-200 hover:-translate-y-0.5">
      <details className="group">
        <summary className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <Badge tone={toneFor(event.type_event)}>
            {event.type_event ?? "event"}
          </Badge>
          <span className="font-semibold text-sm text-ink">{label}</span>
          {event.merchant_order_id && (
            <span className="text-xs text-neutral-400">
              {event.merchant_order_id}
            </span>
          )}
          {event.payment_id && (
            <span
              className="font-mono text-xs text-ink/60"
              title={event.payment_id}
            >
              {truncateId(event.payment_id)}
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
            {prettyRaw(event.raw)}
          </pre>
        </div>
      </details>
    </GlassCard>
  );
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const latestId = useRef(0);

  // Hydration-safe read of the origin: "" on the server, real URL on the client.
  const endpoint = useSyncExternalStore(
    subscribeNoop,
    () => `${window.location.origin}/api/webhooks/yuno`,
    () => "",
  );

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const url = latestId.current
          ? `/api/events?since=${latestId.current}`
          : "/api/events";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { events?: EventItem[] };
        const fresh = json.events ?? [];
        if (cancelled || fresh.length === 0) return;
        latestId.current = Math.max(
          latestId.current,
          ...fresh.map((e) => e.id),
        );
        setEvents((prev) => [...fresh, ...prev].slice(0, 100));
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
  }, []);

  const copyEndpoint = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (non-secure context) — nothing to do
    }
  }, [endpoint]);

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <style>{`
        @keyframes event-enter {
          from { opacity: 0; transform: translateY(-8px) scale(0.99); }
          to { opacity: 1; transform: none; }
        }
        .event-enter { animation: event-enter 0.45s ease-out both; }
      `}</style>

      <GlassCard className="overflow-hidden">
        <Marquee
          thin
          glyph="☕"
          items={[
            "PAYMENT.PURCHASE",
            "HMAC VERIFIED",
            "LIVE FEED",
            "PAYMENT.REFUND",
            "7 RETRIES DEEP",
          ]}
          className="bg-primary/90 text-lime font-display text-[10px] tracking-wider py-1.5"
        />
        <div className="p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="font-display uppercase tracking-tight text-3xl">
            Webhook Events
          </h1>
          <span className="relative flex h-2.5 w-2.5" aria-label="live">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lime opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-lime" />
          </span>
          <span className="text-xs font-semibold text-neutral-400 uppercase tracking-wide">
            live
          </span>
        </div>
        <p className="text-sm text-neutral-400 mb-4">
          Yuno notifications land here in real time. Point the dashboard
          (Developers → Webhooks) at this endpoint:
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
        </div>
      </GlassCard>

      {loaded && events.length === 0 && (
        <GlassCard className="p-10 text-center">
          <Badge tone="pending" className="sticker mb-4 [--tilt:-2deg]">
            Waiting for events
          </Badge>
          <p className="font-display uppercase tracking-wide text-ink/80 mb-2">
            No events yet — the kettle&apos;s on.
          </p>
          <p className="text-sm text-neutral-400">
            Complete a checkout or configure the webhook in the Yuno dashboard
            (Developers → Webhooks).
          </p>
        </GlassCard>
      )}

      {events.map((event) => (
        <EventRow key={event.id} event={event} now={now} />
      ))}
    </div>
  );
}
