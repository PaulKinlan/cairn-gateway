import type { DeviceSigner } from "./device_signer.ts";
import type { CapabilityKeyring } from "./capability.ts";
import { bufferSource } from "./encoding.ts";

// Real P-256 key generation for the product path. Unlike fixture_keys.ts there is
// no deterministic material: every signer is a fresh crypto.subtle.generateKey
// pair whose private key is non-extractable and never leaves this object. The
// fixture module remains for offline unit/stage tests only; served surfaces must
// compose identity through these generators plus the enrollment ceremonies.

export async function generateP256Signer(id: string): Promise<DeviceSigner> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  return Object.freeze({
    deviceId: id,
    publicJwk: () => crypto.subtle.exportKey("jwk", pair.publicKey),
    sign: async (message: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          bufferSource(message),
        ),
      ),
  });
}

export async function generateCapabilityKeyring(kid: string): Promise<CapabilityKeyring> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return Object.freeze({
    active: () => Promise.resolve({ kid, privateKey: pair.privateKey }),
    verificationKey: (requested: string, _at: number) =>
      Promise.resolve(requested === kid ? { ...publicJwk } : undefined),
  });
}
