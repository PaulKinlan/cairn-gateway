import { canonical, sha256 } from "./encoding.ts";

export function assertPublicP256(jwk: JsonWebKey): void {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || "d" in jwk) {
    throw new Error("public P-256 JWK required");
  }
  if (jwk.alg && jwk.alg !== "ES256") throw new Error("invalid JWK algorithm");
}
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  assertPublicP256(jwk);
  return await sha256(canonical({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }));
}
export function shortFingerprint(thumbprint: string): string {
  return thumbprint.slice(0, 4).toUpperCase() + "-" + thumbprint.slice(4, 8).toUpperCase();
}
export async function importPublicP256(jwk: JsonWebKey): Promise<CryptoKey> {
  assertPublicP256(jwk);
  return await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);
}
