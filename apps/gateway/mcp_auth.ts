import type { TenantContext } from "../../packages/core/src/domain/types.ts";
import type { MetadataStore } from "../../packages/core/src/store/store.ts";
import type { DualProof } from "../../packages/core/src/policy/invocation.ts";
import { bodyHash, verifyRequestProof } from "../../packages/core/src/crypto/request_proof.ts";
import { sha256 } from "../../packages/core/src/crypto/encoding.ts";

const verified = new WeakMap<object, { consumed: boolean }>();
export interface VerifiedMcpAuth {
  readonly authenticated: true;
  readonly context: TenantContext;
  readonly grantId: string;
  readonly sessionId: string;
  readonly authority: string;
  readonly path: "/mcp" | "/mcp/legacy";
  readonly bodySha256: string;
  readonly expiresAt: number;
  readonly principalEpoch: number;
  readonly agentId: string;
  readonly agentEpoch: number;
  readonly deviceId: string;
  readonly deviceEpoch: number;
  readonly grantVersion: number;
  readonly connectionId: string;
  readonly connectionEpoch: number;
}
export function isVerifiedMcpAuth(value: unknown): value is VerifiedMcpAuth {
  return !!value && typeof value === "object" && verified.has(value as object);
}

/** Atomically binds and consumes one verified authorization at the handler boundary. */
export async function consumeVerifiedMcpAuth(
  value: unknown,
  input: {
    receivedBody: Uint8Array;
    authority: string;
    path: "/mcp" | "/mcp/legacy";
  },
): Promise<boolean> {
  if (!isVerifiedMcpAuth(value)) return false;
  const state = verified.get(value as object);
  const digest = await bodyHash(input.receivedBody);
  if (
    !state || state.consumed || value.authority !== input.authority || value.path !== input.path ||
    value.bodySha256 !== digest
  ) return false;
  state.consumed = true;
  return true;
}

export async function verifyMcpAuth(
  store: MetadataStore,
  input: {
    context: TenantContext;
    grantId: string;
    proofs: DualProof;
    receivedBody: Uint8Array;
    now: number;
    authority?: string;
    path?: "/mcp" | "/mcp/legacy";
    capability?: string;
  },
): Promise<VerifiedMcpAuth> {
  const grant = await store.getGrant(input.context, input.grantId),
    principal = await store.getPrincipal(input.context, input.context.userId);
  if (
    !grant || grant.status !== "active" || grant.expiresAt <= input.now || !principal ||
    principal.status !== "active"
  ) throw new Error("MCP authentication denied");
  const agent = await store.getAgent(input.context, grant.agentId),
    device = await store.getDevice(input.context, grant.deviceId),
    connection = await store.getConnection(input.context, grant.connectionId);
  if (
    !agent || agent.status !== "active" || !device || device.status !== "active" ||
    device.agentId !== agent.id || !connection || connection.status !== "active"
  ) throw new Error("MCP authentication denied");
  const authority = input.authority ?? "fixture.cairn.invalid";
  const path = input.path ?? "/mcp";
  const digest = await bodyHash(input.receivedBody);
  const expected = {
    v: 1 as const,
    method: "POST" as const,
    authority,
    path,
    query: "" as const,
    audience: "urn:cairn:gateway" as const,
    body_sha256: digest,
    device_id: device.id,
    agent_id: agent.id,
    grant_id: grant.id,
    capability_sha256: input.capability ? await sha256(input.capability) : undefined,
  };
  if (
    !await verifyRequestProof(input.proofs.device, device.publicJwk, expected, input.now) ||
    !await verifyRequestProof(input.proofs.agent, agent.publicJwk, expected, input.now)
  ) throw new Error("MCP authentication denied");
  if (
    !await store.consumeNonce(
      input.context,
      await sha256(`mcp:${input.proofs.device.payload.nonce}:${input.proofs.agent.payload.nonce}`),
      input.now + 600,
      input.now,
    )
  ) throw new Error("MCP authentication replay");
  const result: VerifiedMcpAuth = Object.freeze({
    authenticated: true,
    context: Object.freeze({ ...input.context }),
    grantId: input.grantId,
    sessionId: crypto.randomUUID(),
    authority,
    path,
    bodySha256: digest,
    expiresAt: grant.expiresAt,
    principalEpoch: principal.epoch,
    agentId: agent.id,
    agentEpoch: agent.epoch,
    deviceId: device.id,
    deviceEpoch: device.epoch,
    grantVersion: grant.version,
    connectionId: connection.id,
    connectionEpoch: connection.epoch,
  });
  verified.set(result, { consumed: false });
  return result;
}
