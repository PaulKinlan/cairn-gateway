import { base64url, encoder, unbase64url } from "./encoding.ts";
import { importPublicP256 } from "./thumbprint.ts";

export interface CapabilityClaims {
  iss: "urn:cairn:gateway";
  aud: "urn:cairn:invoke";
  sub: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  device_id: string;
  connection_id: string;
  operations: ["github.user.read"];
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  max_calls: 1;
  cnf: { jkt: string };
  grant_id: string;
  grant_version: number;
  device_epoch: number;
  connection_epoch: number;
  policy_version: number;
  schema_version: 1;
}
export interface CapabilityKeyring {
  active(): Promise<{ kid: string; privateKey: CryptoKey }>;
  verificationKey(kid: string, at: number): Promise<JsonWebKey | undefined>;
}
const claimKeys = [
  "agent_id",
  "aud",
  "cnf",
  "connection_epoch",
  "connection_id",
  "device_epoch",
  "device_id",
  "exp",
  "grant_id",
  "grant_version",
  "iat",
  "iss",
  "jti",
  "max_calls",
  "nbf",
  "operations",
  "policy_version",
  "schema_version",
  "sub",
  "tenant_id",
  "user_id",
];
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

export async function signCapability(
  keyring: CapabilityKeyring,
  claims: CapabilityClaims,
): Promise<string> {
  validateClaims(claims, claims.iat);
  const { kid, privateKey } = await keyring.active();
  const header = { alg: "ES256", kid, typ: "cairn-cap+jwt" };
  const head = base64url(encoder.encode(JSON.stringify(header)));
  const body = base64url(encoder.encode(JSON.stringify(claims)));
  const input = `${head}.${body}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(input),
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyCapability(
  keyring: CapabilityKeyring,
  token: string,
  now: number,
): Promise<CapabilityClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid capability");
  let header: Record<string, unknown>;
  let claims: CapabilityClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(unbase64url(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(unbase64url(parts[1]!)));
  } catch {
    throw new Error("invalid capability");
  }
  if (
    !exactKeys(header, ["alg", "kid", "typ"]) || header.alg !== "ES256" ||
    header.typ !== "cairn-cap+jwt" || typeof header.kid !== "string"
  ) throw new Error("invalid capability");
  validateClaims(claims, now);
  const jwk = await keyring.verificationKey(header.kid, now);
  if (!jwk) throw new Error("invalid capability");
  const key = await importPublicP256(jwk);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    unbase64url(parts[2]!),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("invalid capability");
  return claims;
}

function validateClaims(claims: CapabilityClaims, now: number): void {
  if (
    !claims || typeof claims !== "object" ||
    !exactKeys(claims as unknown as Record<string, unknown>, claimKeys) ||
    claims.iss !== "urn:cairn:gateway" || claims.aud !== "urn:cairn:invoke" ||
    claims.sub !== claims.agent_id ||
    claims.max_calls !== 1 || claims.schema_version !== 1 || !Array.isArray(claims.operations) ||
    claims.operations.length !== 1 || claims.operations[0] !== "github.user.read" ||
    !claims.cnf || !exactKeys(claims.cnf as unknown as Record<string, unknown>, ["jkt"]) ||
    typeof claims.cnf.jkt !== "string" || claims.exp - claims.iat > 300 ||
    claims.exp <= claims.iat ||
    claims.nbf < claims.iat || now < claims.nbf - 30 || now > claims.exp + 30 ||
    !Number.isInteger(claims.iat) || !Number.isInteger(claims.nbf) || !Number.isInteger(claims.exp)
  ) {
    throw new Error("invalid capability");
  }
}
