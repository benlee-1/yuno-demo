"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { GlassCard, Button, Input, Badge } from "@/components/ui";

/**
 * INTERNAL — playground workspace admin.
 *
 * Security posture:
 * - The admin code lives in component state only (never persisted client-side)
 *   and is sent per request via the x-admin-code header.
 * - The private key field is a password input, cleared after a successful
 *   create; the server never echoes key material back.
 */

type WorkspaceSummary = {
  id: string;
  companyName: string;
  accountId: string;
  publicKeyHint: string;
  country: string;
  currency: string;
  features: string[];
  label: string | null;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  hasWebhookSecret: boolean;
  url: string;
};

const ALL_FEATURES = [
  { key: "checkout", label: "Checkout scenarios" },
  { key: "vault", label: "Vault & subscriptions" },
  { key: "ops", label: "Post-payment ops" },
  { key: "webhooks", label: "Webhook inspector" },
] as const;

function subscribeNoop(): () => void {
  return () => {};
}

export default function AdminPage() {
  const [adminCode, setAdminCode] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [form, setForm] = useState({
    companyName: "",
    accountId: "",
    publicApiKey: "",
    privateSecretKey: "",
    webhookSecret: "",
    country: "BR",
    currency: "BRL",
    label: "",
    expiresInDays: 14,
    features: ALL_FEATURES.map((f) => f.key as string),
  });
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const origin = useSyncExternalStore(
    subscribeNoop,
    () => window.location.origin,
    () => "",
  );

  const authHeaders = useCallback(
    (): Record<string, string> => ({
      "x-admin-code": adminCode,
      "Content-Type": "application/json",
    }),
    [adminCode],
  );

  const loadWorkspaces = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/workspaces", {
        headers: authHeaders(),
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) {
        setUnlocked(false);
        setError(json.error ?? `Request failed (${res.status})`);
        return;
      }
      setWorkspaces(json.workspaces ?? []);
      setUnlocked(true);
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  }, [authHeaders]);

  const createWorkspace = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCreatedUrl(null);
    try {
      const res = await fetch("/api/admin/workspaces", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          ...form,
          webhookSecret: form.webhookSecret || undefined,
          label: form.label || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Create failed (${res.status})`);
        return;
      }
      const ws = json.workspace as WorkspaceSummary;
      setCreatedUrl(ws.url);
      setWorkspaces((prev) => [ws, ...prev]);
      // Drop the secret from the browser as soon as the server has it.
      setForm((f) => ({ ...f, privateSecretKey: "", webhookSecret: "" }));
    } catch {
      setError("Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  }, [authHeaders, form]);

  const setRevoked = useCallback(
    async (id: string, revoked: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/workspaces/${id}`, {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ revoked }),
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error ?? `Update failed (${res.status})`);
          return;
        }
        setWorkspaces((prev) =>
          prev.map((w) => (w.id === id ? { ...w, revoked } : w)),
        );
      } catch {
        setError("Network error — is the server running?");
      } finally {
        setBusy(false);
      }
    },
    [authHeaders],
  );

  const copyLink = useCallback(
    async (id: string, path: string) => {
      try {
        await navigator.clipboard.writeText(`${origin}${path}`);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 1500);
      } catch {
        // clipboard unavailable — nothing to do
      }
    },
    [origin],
  );

  const toggleFeature = (key: string) => {
    setForm((f) => ({
      ...f,
      features: f.features.includes(key)
        ? f.features.filter((x) => x !== key)
        : [...f.features, key],
    }));
  };

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <GlassCard className="p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="font-display uppercase tracking-tight text-3xl">
            Playground Admin
          </h1>
          <Badge tone="pending">internal</Badge>
        </div>
        <p className="text-sm text-neutral-400 mb-4">
          Create a sandbox testing workspace for a company: their credentials
          are validated live, encrypted at rest, and reachable only through a
          signed expiring link. Sandbox only — production keys are never
          accepted here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-52">
            <Input
              type="password"
              autoComplete="off"
              placeholder="Admin code"
              aria-label="Admin code"
              value={adminCode}
              onChange={(e) => setAdminCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadWorkspaces()}
            />
          </div>
          <Button onClick={loadWorkspaces} disabled={busy || !adminCode}>
            {unlocked ? "Refresh" : "Unlock"}
          </Button>
        </div>
        {error && <p className="text-sm text-red-700 mt-3">{error}</p>}
      </GlassCard>

      {unlocked && (
        <GlassCard className="p-6 sm:p-8">
          <h2 className="font-display uppercase tracking-tight text-xl mb-4">
            New workspace
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input
              placeholder="Company name"
              aria-label="Company name"
              value={form.companyName}
              onChange={(e) =>
                setForm((f) => ({ ...f, companyName: e.target.value }))
              }
            />
            <Input
              placeholder="Label (optional, shows in logs)"
              aria-label="Label"
              value={form.label}
              onChange={(e) =>
                setForm((f) => ({ ...f, label: e.target.value }))
              }
            />
            <Input
              placeholder="Yuno account id (sandbox)"
              aria-label="Yuno account id"
              autoComplete="off"
              value={form.accountId}
              onChange={(e) =>
                setForm((f) => ({ ...f, accountId: e.target.value }))
              }
            />
            <Input
              placeholder="Public API key (sandbox)"
              aria-label="Public API key"
              autoComplete="off"
              value={form.publicApiKey}
              onChange={(e) =>
                setForm((f) => ({ ...f, publicApiKey: e.target.value }))
              }
            />
            <Input
              type="password"
              placeholder="Private secret key (sandbox)"
              aria-label="Private secret key"
              autoComplete="off"
              value={form.privateSecretKey}
              onChange={(e) =>
                setForm((f) => ({ ...f, privateSecretKey: e.target.value }))
              }
            />
            <Input
              type="password"
              placeholder="Webhook HMAC secret (optional)"
              aria-label="Webhook HMAC secret"
              autoComplete="off"
              value={form.webhookSecret}
              onChange={(e) =>
                setForm((f) => ({ ...f, webhookSecret: e.target.value }))
              }
            />
            <div className="grid grid-cols-3 gap-3">
              <Input
                placeholder="BR"
                aria-label="Country (2-letter)"
                maxLength={2}
                value={form.country}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    country: e.target.value.toUpperCase(),
                  }))
                }
              />
              <Input
                placeholder="BRL"
                aria-label="Currency (3-letter)"
                maxLength={3}
                value={form.currency}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    currency: e.target.value.toUpperCase(),
                  }))
                }
              />
              <Input
                type="number"
                min={1}
                max={90}
                aria-label="Expires in days"
                value={form.expiresInDays}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    expiresInDays: Number(e.target.value) || 14,
                  }))
                }
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {ALL_FEATURES.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => toggleFeature(f.key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors cursor-pointer ${
                    form.features.includes(f.key)
                      ? "bg-primary text-white border-primary"
                      : "bg-white/50 text-neutral-400 border-neutral-300"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button
              onClick={createWorkspace}
              disabled={
                busy ||
                !form.companyName ||
                !form.accountId ||
                !form.publicApiKey ||
                !form.privateSecretKey ||
                form.features.length === 0
              }
            >
              {busy ? "Validating credentials…" : "Validate & create"}
            </Button>
            <span className="text-xs text-neutral-400">
              Runs a live sandbox check (customer + checkout session) before
              anything is stored.
            </span>
          </div>
          {createdUrl && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge tone="success">workspace ready</Badge>
              <code className="flex-1 min-w-0 truncate font-mono text-xs text-primary-dark bg-white/70 border border-white/60 rounded-btn px-4 py-2.5">
                {origin}
                {createdUrl}
              </code>
              <Button
                variant="lime"
                onClick={() => copyLink("created", createdUrl)}
              >
                {copiedId === "created" ? "Copied!" : "Copy link"}
              </Button>
            </div>
          )}
        </GlassCard>
      )}

      {unlocked &&
        workspaces.map((ws) => (
          <GlassCard key={ws.id} className="p-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="font-semibold text-ink">{ws.companyName}</span>
              <span className="font-mono text-xs text-neutral-400">
                {ws.id}
              </span>
              <Badge tone={ws.revoked ? "error" : "success"}>
                {ws.revoked ? "revoked" : "active"}
              </Badge>
              <span className="text-xs text-neutral-400">
                {ws.country} · {ws.currency} · key {ws.publicKeyHint}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => copyLink(ws.id, ws.url)}
                  className="px-3 py-1.5 rounded-btn text-xs font-semibold bg-primary text-white hover:bg-primary-dark transition-colors cursor-pointer"
                >
                  {copiedId === ws.id ? "Copied!" : "Copy link"}
                </button>
                <button
                  onClick={() => setRevoked(ws.id, !ws.revoked)}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-btn text-xs font-semibold bg-white/60 text-primary border border-primary/20 hover:bg-white/90 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {ws.revoked ? "Restore" : "Revoke"}
                </button>
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
              <span>
                features:{" "}
                {ws.features.length > 0 ? ws.features.join(", ") : "none"}
              </span>
              <span>· expires {new Date(ws.expiresAt).toLocaleDateString()}</span>
              {ws.hasWebhookSecret && <span>· webhook HMAC set</span>}
              {ws.label && <span>· {ws.label}</span>}
            </div>
          </GlassCard>
        ))}
    </div>
  );
}
