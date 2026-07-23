import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  adminGate,
  parseFeatures,
  validateSandboxCredentials,
  workspaceLinkToken,
  WORKSPACE_FEATURES,
  type WorkspaceFeature,
} from "@/lib/workspaces";
import { encryptSecret, WorkspaceConfigError } from "@/lib/crypto";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  type WorkspaceRow,
} from "@/lib/db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

/** Public shape — everything an admin may see. NEVER include key material. */
function toSummary(ws: WorkspaceRow) {
  return {
    id: ws.id,
    companyName: ws.company_name,
    accountId: ws.account_id,
    publicKeyHint: `…${ws.public_api_key.slice(-4)}`,
    country: ws.default_country,
    currency: ws.default_currency,
    features: parseFeatures(ws),
    label: ws.label,
    createdAt: ws.created_at,
    expiresAt: ws.expires_at,
    revoked: Boolean(ws.revoked),
    hasWebhookSecret: Boolean(ws.webhook_secret),
    url: `/w/${workspaceLinkToken(ws)}`,
  };
}

export async function GET(req: Request) {
  const denied = adminGate(req);
  if (denied) return denied;
  try {
    return NextResponse.json(
      { workspaces: listWorkspaces().map(toSummary) },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      return NextResponse.json(
        { error: err.message },
        { status: 500, headers: NO_STORE },
      );
    }
    throw err;
  }
}

export async function POST(req: Request) {
  const denied = adminGate(req);
  if (denied) return denied;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      companyName?: string;
      accountId?: string;
      publicApiKey?: string;
      privateSecretKey?: string;
      webhookSecret?: string;
      country?: string;
      currency?: string;
      features?: string[];
      label?: string;
      expiresInDays?: number;
    };

    const companyName = body.companyName?.trim();
    const accountId = body.accountId?.trim();
    const publicApiKey = body.publicApiKey?.trim();
    const privateSecretKey = body.privateSecretKey?.trim();
    const country = body.country?.trim().toUpperCase();
    const currency = body.currency?.trim().toUpperCase();
    if (
      !companyName ||
      !accountId ||
      !publicApiKey ||
      !privateSecretKey ||
      !country ||
      !currency
    ) {
      return NextResponse.json(
        {
          error:
            "companyName, accountId, publicApiKey, privateSecretKey, country and currency are required",
        },
        { status: 400, headers: NO_STORE },
      );
    }
    if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3}$/.test(currency)) {
      return NextResponse.json(
        { error: "country must be 2 letters, currency 3 letters" },
        { status: 400, headers: NO_STORE },
      );
    }

    const features = (body.features ?? [...WORKSPACE_FEATURES]).filter(
      (f): f is WorkspaceFeature =>
        (WORKSPACE_FEATURES as readonly string[]).includes(f),
    );
    if (features.length === 0) {
      return NextResponse.json(
        { error: "at least one feature must be enabled" },
        { status: 400, headers: NO_STORE },
      );
    }
    const expiresInDays = Math.min(Math.max(body.expiresInDays ?? 14, 1), 90);

    const validation = await validateSandboxCredentials(
      { accountId, publicApiKey, privateSecretKey },
      { country, currency },
    );
    if (!validation.ok) {
      // Message is ours (no Yuno echo) — safe to show the admin.
      return NextResponse.json(
        {
          error: validation.message,
          step: validation.step,
          yunoStatus: validation.status,
        },
        { status: 422, headers: NO_STORE },
      );
    }

    const id = `${slugify(companyName)}-${randomBytes(3).toString("hex")}`;
    createWorkspace({
      id,
      company_name: companyName,
      account_id: accountId,
      public_api_key: publicApiKey,
      private_secret_key_enc: encryptSecret(privateSecretKey),
      webhook_secret: body.webhookSecret?.trim() || null,
      default_country: country,
      default_currency: currency,
      features: JSON.stringify(features),
      label: body.label?.trim() || null,
      expires_at: new Date(
        Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    const ws = getWorkspace(id);
    if (!ws) throw new Error("workspace insert failed");
    return NextResponse.json(
      { workspace: toSummary(ws) },
      { status: 201, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      return NextResponse.json(
        { error: err.message },
        { status: 500, headers: NO_STORE },
      );
    }
    console.error("[admin/workspaces] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to create workspace" },
      { status: 500, headers: NO_STORE },
    );
  }
}
