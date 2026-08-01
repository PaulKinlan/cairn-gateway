import { base64url, encoder, unbase64url } from "./encoding.ts";

export interface SealedFlowValue {
  iv: string;
  ciphertext: string;
}
export async function generateFlowKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function sealFlowValue(
  key: CryptoKey,
  value: string,
  binding: string,
): Promise<SealedFlowValue> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(binding), tagLength: 128 },
    key,
    encoder.encode(value),
  );
  return { iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}
export async function openFlowValue(
  key: CryptoKey,
  sealed: SealedFlowValue,
  binding: string,
): Promise<string> {
  const clear = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unbase64url(sealed.iv),
      additionalData: encoder.encode(binding),
      tagLength: 128,
    },
    key,
    unbase64url(sealed.ciphertext),
  );
  return new TextDecoder().decode(clear);
}
