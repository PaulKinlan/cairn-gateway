const intrinsicArrayIsArray = Array.isArray;
const intrinsicJsonStringify = JSON.stringify;
const intrinsicObjectEntries = Object.entries;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicTextEncode = TextEncoder.prototype.encode;
const intrinsicReflectApply = Reflect.apply;
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const encodeUtf8 = (value: string): Uint8Array<ArrayBuffer> =>
  intrinsicReflectApply(intrinsicTextEncode, encoder, [value]) as Uint8Array<ArrayBuffer>;
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function bufferSource(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}
export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) output[index] = binary.charCodeAt(index);
  return output;
}
export async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? encodeUtf8(value) : bufferSource(value);
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return intrinsicJsonStringify(value);
  }
  if (typeof value === "number" && intrinsicNumberIsFinite(value)) {
    return intrinsicJsonStringify(value);
  }
  if (intrinsicArrayIsArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = intrinsicObjectEntries(value as Record<string, unknown>).filter(([, item]) =>
      item !== undefined
    )
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${
      entries.map(([key, item]) => `${intrinsicJsonStringify(key)}:${canonical(item)}`).join(",")
    }}`;
  }
  throw new Error("non-canonical value");
}
