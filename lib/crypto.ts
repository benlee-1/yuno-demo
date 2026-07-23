import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Workspace secret handling (server-only).
 *
 * - Private keys are encrypted at rest with AES-256-GCM.
 * - Workspace links are HMAC-signed tokens with an embedded expiry.
 * - Both keys derive from WORKSPACE_ENC_KEY (read lazily — no env at build).
 *   Rotating WORKSPACE_ENC_KEY invalidates all stored secrets AND all links.
 */

export class WorkspaceConfigError extends Error {
  constructor() {
    super("Missing WORKSPACE_ENC_KEY — fill .env.local");
    this.name = "WorkspaceConfigError";
  }
}

function deriveKey(label: string): Buffer {
  const master = process.env.WORKSPACE_ENC_KEY;
  if (!master) throw new WorkspaceConfigError();
  return createHash("sha256").update(`${label}:${master}`).digest();
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

// ---------------------------------------------------------------------------
// Secret encryption (AES-256-GCM) — format: v1.<iv>.<tag>.<ciphertext>
// ---------------------------------------------------------------------------

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey("enc"), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(ct)}`;
}

export function decryptSecret(encoded: string): string {
  const [version, iv, tag, ct] = encoded.split(".");
  if (version !== "v1" || !iv || !tag || !ct) {
    throw new Error("Malformed encrypted secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", deriveKey("enc"), fromB64url(iv));
  decipher.setAuthTag(fromB64url(tag));
  return Buffer.concat([
    decipher.update(fromB64url(ct)),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Signed workspace link tokens — format: <payload b64url>.<hmac b64url>
// ---------------------------------------------------------------------------

export interface WorkspaceTokenPayload {
  /** Workspace id. */
  w: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export function signWorkspaceToken(payload: WorkspaceTokenPayload): string {
  const data = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", deriveKey("link")).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

/** Returns the payload if the signature is valid and unexpired, else null. */
export function verifyWorkspaceToken(
  token: string,
): WorkspaceTokenPayload | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = createHmac("sha256", deriveKey("link")).update(data).digest();
  const given = fromB64url(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let payload: WorkspaceTokenPayload;
  try {
    payload = JSON.parse(fromB64url(data).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.w !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** Constant-time string comparison that doesn't leak length (admin code). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
