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
