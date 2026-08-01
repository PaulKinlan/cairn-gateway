import type { TenantContext } from "../../packages/core/src/domain/types.ts";
import type { MetadataStore } from "../../packages/core/src/store/store.ts";
import type { DualProof } from "../../packages/core/src/policy/invocation.ts";
import { bodyHash, verifyRequestProof } from "../../packages/core/src/crypto/request_proof.ts";
import { sha256 } from "../../packages/core/src/crypto/encoding.ts";
const verified = new WeakSet<object>();
export interface VerifiedMcpAuth {
  readonly authenticated: true;
  readonly context: TenantContext;
  readonly grantId: string;
  readonly sessionId: string;
}
export function isVerifiedMcpAuth(value: unknown): value is VerifiedMcpAuth {
  return !!value && typeof value === "object" && verified.has(value as object);
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
    !grant || grant.status !== "active" || grant.expiresAt < input.now || !principal ||
    principal.status !== "active"
  ) {
    throw new Error("MCP authentication denied");
  }
  const agent = await store.getAgent(input.context, grant.agentId),
    device = await store.getDevice(input.context, grant.deviceId),
    connection = await store.getConnection(input.context, grant.connectionId);
  if (
    !agent || agent.status !== "active" || !device || device.status !== "active" ||
    device.agentId !== agent.id || !connection || connection.status !== "active"
  ) throw new Error("MCP authentication denied");
  const expected = {
    v: 1 as const,
    method: "POST" as const,
    authority: input.authority ?? "fixture.cairn.invalid",
    path: input.path ?? "/mcp",
    query: "" as const,
    audience: "urn:cairn:gateway" as const,
    body_sha256: await bodyHash(input.receivedBody),
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
  });
  verified.add(result);
  return result;
}
