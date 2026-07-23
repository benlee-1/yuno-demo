import Link from "next/link";
import { GlassCard, Badge } from "@/components/ui";
import {
  FEATURE_LABELS,
  resolveWorkspaceByToken,
  type WorkspaceFeature,
} from "@/lib/workspaces";
import { WorkspaceConfigError } from "@/lib/crypto";

// better-sqlite3 (via lib/db.ts) — must run on the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Capability URLs must never be indexed.
export const metadata = {
  robots: { index: false, follow: false },
  title: "Yuno Feature Playground",
};

const FEATURE_BLURBS: Record<WorkspaceFeature, string> = {
  checkout:
    "Run purchases, auth-only flows, 3DS and declines through the Yuno Web SDK with your own sandbox account.",
  vault:
    "$0 verify a card, watch the vaulted token arrive, then fire an MIT renewal against it.",
  ops: "Capture, void or refund any payment you created here — full and partial.",
  webhooks:
    "A dedicated webhook endpoint for this workspace with signature verification and a live event feed.",
};

function ErrorShell({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="max-w-xl mx-auto">
      <GlassCard className="p-10 text-center">
        <Badge tone="error" className="mb-4">
          link problem
        </Badge>
        <h1 className="font-display uppercase tracking-tight text-2xl mb-2">
          {title}
        </h1>
        <p className="text-sm text-neutral-400">{detail}</p>
      </GlassCard>
    </div>
  );
}

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let resolved;
  try {
    resolved = resolveWorkspaceByToken(decodeURIComponent(token));
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      return (
        <ErrorShell
          title="Playground not configured"
          detail="The server is missing its workspace key. Ask whoever runs this deployment to set WORKSPACE_ENC_KEY."
        />
      );
    }
    throw err;
  }

  if (!resolved.ok) {
    const messages = {
      invalid: {
        title: "This link is not valid",
        detail:
          "The link is malformed or was signed with a different key. Ask your Yuno contact for a fresh one.",
      },
      expired: {
        title: "This link has expired",
        detail:
          "Workspace links expire automatically. Ask your Yuno contact to issue a new one.",
      },
      revoked: {
        title: "This workspace was closed",
        detail:
          "Access has been revoked. Ask your Yuno contact if you need it reopened.",
      },
    } as const;
    const m = messages[resolved.reason];
    return <ErrorShell title={m.title} detail={m.detail} />;
  }

  const { workspace, features } = resolved;

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <GlassCard className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="font-display uppercase tracking-tight text-3xl">
            Feature Playground
          </h1>
          <Badge tone="success">sandbox</Badge>
        </div>
        <p className="text-sm text-neutral-500 mb-1">
          Welcome, <span className="font-semibold">{workspace.company_name}</span>.
          Everything here runs against your Yuno <strong>sandbox</strong>{" "}
          account ({workspace.default_country} · {workspace.default_currency}) —
          test cards only, no real money, ever.
        </p>
        <p className="text-xs text-neutral-400">
          This link is personal to your company and expires on{" "}
          {new Date(workspace.expires_at).toLocaleDateString()}.
        </p>
      </GlassCard>

      <div className="grid sm:grid-cols-2 gap-4">
        {features.map((f) => (
          <GlassCard key={f} className="p-6">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="font-display uppercase tracking-tight text-lg">
                {FEATURE_LABELS[f]}
              </h2>
            </div>
            <p className="text-sm text-neutral-400 mb-4">{FEATURE_BLURBS[f]}</p>
            <Link
              href={`/w/${token}/${f}`}
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-btn font-semibold text-sm bg-primary text-white hover:bg-primary-dark transition-colors"
            >
              Open →
            </Link>
          </GlassCard>
        ))}
      </div>
    </div>
  );
}
