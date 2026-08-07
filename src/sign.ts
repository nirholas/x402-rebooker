import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_DEV_SECRET = "x402-rebooker-dev-secret-do-not-use-in-prod";

function getSecret(): string {
  const secret = process.env.SIGNING_SECRET;
  if (!secret) {
    return DEFAULT_DEV_SECRET;
  }
  return secret;
}

/** Canonical JSON: recursively sorted object keys, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export interface SignedArtifact<T> {
  payload: T;
  signature: string;
  algorithm: "HMAC-SHA256";
  canonicalization: "sorted-json";
}

/** HMAC-SHA256 over canonical JSON of the payload. */
export function sign<T>(payload: T): SignedArtifact<T> {
  const signature = createHmac("sha256", getSecret())
    .update(canonicalize(payload))
    .digest("hex");
  return { payload, signature, algorithm: "HMAC-SHA256", canonicalization: "sorted-json" };
}

/** Verify a signed artifact produced by sign(). */
export function verify(artifact: { payload: unknown; signature: string }): boolean {
  const expected = createHmac("sha256", getSecret())
    .update(canonicalize(artifact.payload))
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(artifact.signature ?? "", "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function usingDevSecret(): boolean {
  return !process.env.SIGNING_SECRET;
}
