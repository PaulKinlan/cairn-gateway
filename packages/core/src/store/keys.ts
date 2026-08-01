import type { TenantContext } from "../domain/types.ts";

const clean = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid opaque identifier");
  return value;
};
export const ownerPrefix = (ctx: TenantContext): string =>
  `tenant/${clean(ctx.tenantId)}/user/${clean(ctx.userId)}`;
export const entityKey = (ctx: TenantContext, kind: string, id: string): string =>
  `${ownerPrefix(ctx)}/${clean(kind)}/${clean(id)}`;
export const replayKey = (ctx: TenantContext, kind: "nonce" | "jti", hash: string): string =>
  `${ownerPrefix(ctx)}/replay/${kind}/${clean(hash)}`;

/** Adapter-neutral layout grammar. Every owner record substitutes validated tenant/user IDs. */
export const DURABLE_KEY_LAYOUT = Object.freeze(
  {
    authorityRecord: "cairn/v1/tenant/{tenantId}/user/{userId}/authority/{kind}/{id}",
    authorityGeneration: "cairn/v1/tenant/{tenantId}/user/{userId}/high-watermark/authority",
    replayGeneration: "cairn/v1/tenant/{tenantId}/user/{userId}/high-watermark/replay",
    revocationGeneration: "cairn/v1/tenant/{tenantId}/user/{userId}/high-watermark/revocation",
    schemaGeneration: "cairn/v1/system/high-watermark/schema",
    migrationState: "cairn/v1/system/migration/state",
    custodyReferenceClaim: "cairn/v1/system/custody-claim/{custodyReferenceHash}",
  } as const,
);
