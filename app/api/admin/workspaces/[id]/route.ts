import { NextResponse } from "next/server";
import { adminGate } from "@/lib/workspaces";
import { getWorkspace, setWorkspaceRevoked } from "@/lib/db";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/** Revoke or restore a workspace: body { revoked: boolean }. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = adminGate(req);
  if (denied) return denied;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { revoked?: boolean };
  if (typeof body.revoked !== "boolean") {
    return NextResponse.json(
      { error: "revoked (boolean) is required" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (!setWorkspaceRevoked(id, body.revoked)) {
    return NextResponse.json(
      { error: "Workspace not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  const ws = getWorkspace(id);
  return NextResponse.json(
    { id, revoked: Boolean(ws?.revoked) },
    { headers: NO_STORE },
  );
}
