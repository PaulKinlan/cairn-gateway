import type { DeviceSigner } from "./device_signer.ts";
import { base64url, canonical, encoder, sha256, unbase64url } from "./encoding.ts";
import { importPublicP256 } from "./thumbprint.ts";

export interface RequestProofPayload {
  v: 1;
  method: "POST";
  authority: string;
  path: "/mcp" | "/mcp/legacy" | "/internal/capabilities" | "/enrollment";
  query: "";
  audience: "urn:cairn:gateway";
  body_sha256: string;
  issued_at: number;
  nonce: string;
  device_id: string;
  grant_id?: string;
  capability_sha256?: string;
}
export interface DetachedProof {
  payload: RequestProofPayload;
  signature: string;
}

export async function bodyHash(body: Uint8Array): Promise<string> {
  return await sha256(body);
}
export async function signRequestProof(
  signer: DeviceSigner,
  payload: RequestProofPayload,
): Promise<DetachedProof> {
  return { payload, signature: base64url(await signer.sign(encoder.encode(canonical(payload)))) };
}
export async function verifyRequestProof(
  proof: DetachedProof,
  publicJwk: JsonWebKey,
  expected: Omit<RequestProofPayload, "issued_at" | "nonce" | "device_id"> & { device_id: string },
  now: number,
): Promise<boolean> {
  const p = proof.payload;
  if (
    p.v !== 1 || p.method !== expected.method || p.authority !== expected.authority ||
    p.path !== expected.path ||
    p.query !== "" || p.query !== expected.query || p.audience !== "urn:cairn:gateway" ||
    p.audience !== expected.audience || p.body_sha256 !== expected.body_sha256 ||
    p.device_id !== expected.device_id || p.grant_id !== expected.grant_id ||
    p.capability_sha256 !== expected.capability_sha256 || Math.abs(now - p.issued_at) > 30 ||
    !/^[A-Za-z0-9_-]{20,}$/.test(p.nonce)
  ) return false;
  const key = await importPublicP256(publicJwk);
  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    unbase64url(proof.signature),
    encoder.encode(canonical(p)),
  );
}
