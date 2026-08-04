import { assert, equals, rejects } from "../assert.ts";
import { createEnrolledGatewayHarness } from "../../packages/mcp-bridge/mod.ts";
import {
  fixtureAgentSigner,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import { generateP256Signer } from "../../packages/core/src/crypto/generated_signer.ts";
import { DeviceEnrollmentService } from "../../packages/core/src/identity/enrollment.ts";
import { bootstrapTransaction } from "../../packages/core/src/identity/transactions.ts";
import { MemoryStore } from "../../packages/core/src/store/memory_store.ts";
import { ids, type Principal, type TenantContext } from "../../packages/core/src/domain/types.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";
import { base64url, canonical, encoder } from "../../packages/core/src/crypto/encoding.ts";
import type { DeviceSigner } from "../../packages/core/src/crypto/device_signer.ts";

const META = {
  protocolVersion: "2026-07-28",
  clientInfo: { name: "enrolled-journey", version: "1" },
  capabilities: {},
};
function mcpBody(id: number, name: string, args: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
    _meta: META,
  }));
}
type Harness = Awaited<ReturnType<typeof createEnrolledGatewayHarness>>;
async function callTool(
  harness: Harness,
  id: number,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  const response = await harness.dispatch(mcpBody(id, name, args)) as Record<string, unknown>;
  const result = response.result as Record<string, unknown> | undefined;
  if (!result) throw new Error(`rpc denied: ${JSON.stringify(response.error)}`);
  return result.structuredContent as Record<string, unknown>;
}
async function invoke(harness: Harness, id: number): Promise<Record<string, unknown>> {
  return await callTool(harness, id, "invoke_operation", {
    operation: "github.user.read@v1",
    connection: "connection_a",
    arguments: {},
  });
}

Deno.test("enrolled harness serves the MCP journey over real enrolled identity", async () => {
  const harness = await createEnrolledGatewayHarness();
  equals(await harness.status("principal"), "active");
  equals(await harness.status("agent"), "active");
  equals(await harness.status("device"), "active");
  equals(await harness.status("grant"), "active");

  // search → describe → status → invoke, all over the enrolled graph
  const search = await callTool(harness, 1, "search_capabilities", { query: "github user" });
  assert((search.operations as unknown[]).length === 1, `search failed: ${JSON.stringify(search)}`);
  const describe = await callTool(harness, 2, "describe_operation", {
    operation: "github.user.read@v1",
  });
  equals(describe.id, "github.user.read@v1");
  const connection = await callTool(harness, 3, "connection_status", {
    connection: "connection_a",
  });
  equals(connection.status, "active");

  const first = await invoke(harness, 4);
  equals(first.outcome, "success");
  equals((first.receipt as Record<string, unknown>).decision, "allow");

  // grant revocation denies the next invoke (fail-closed at the authorization
  // boundary, exactly as the loopback UI surfaces it); reactivation restores it
  await harness.revoke("grant");
  equals(await harness.status("grant"), "revoked");
  await rejects(() => invoke(harness, 5), "grant denied");
  await harness.revokeAndReactivate("grant");
  const restored = await invoke(harness, 6);
  equals(restored.outcome, "success");

  // device revocation runs the Stage 0 removal ceremony and denies the invoke
  await harness.revoke("device");
  equals(await harness.status("device"), "revoked");
  await rejects(() => invoke(harness, 7));
});

Deno.test("enrolled identity contains no fixture key material", async () => {
  // The deterministic fixture thumbprints must never appear in an enrolled graph.
  const fixtureThumbprints = new Set([
    await jwkThumbprint(await (await fixtureDeviceSigner(0)).publicJwk()),
    await jwkThumbprint(await (await fixtureDeviceSigner(1)).publicJwk()),
    await jwkThumbprint(await (await fixtureAgentSigner()).publicJwk()),
  ]);

  const ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("user_a") };
  const store = new MemoryStore();
  const enrollment = new DeviceEnrollmentService(store);
  const now = 2_000_000_000;
  const principal: Principal = {
    id: ctx.userId,
    tenantId: ctx.tenantId,
    kind: "cryptographic",
    status: "active",
    emailRequired: false,
    epoch: 0,
  };
  const agentSigner = await generateP256Signer("agent_a");
  const deviceSigner: DeviceSigner = await generateP256Signer("device_a");
  const agentJwk = await agentSigner.publicJwk();
  const deviceJwk = await deviceSigner.publicJwk();
  const tx = await bootstrapTransaction(
    ctx,
    principal,
    { id: ids.agent("agent_a"), publicJwk: agentJwk },
    { id: ids.device("device_a"), publicJwk: deviceJwk },
  );
  const challenge = await enrollment.bootstrapChallenge(
    ctx,
    principal,
    ids.agent("agent_a"),
    agentJwk,
    ids.device("device_a"),
    deviceJwk,
    now,
  );
  const proof = async (signer: DeviceSigner) => ({
    challenge,
    signature: base64url(
      await signer.sign(encoder.encode(canonical({ ...tx, challenge }))),
    ),
  });
  await enrollment.bootstrap(
    ctx,
    principal,
    ids.agent("agent_a"),
    agentJwk,
    ids.device("device_a"),
    deviceJwk,
    await proof(deviceSigner),
    await proof(agentSigner),
    now,
  );

  const agent = (await store.getAgent(ctx, ids.agent("agent_a")))!;
  const device = (await store.getDevice(ctx, ids.device("device_a")))!;
  assert(!fixtureThumbprints.has(agent.thumbprint), "agent identity is fixture material");
  assert(!fixtureThumbprints.has(device.thumbprint), "device identity is fixture material");
  equals(agent.thumbprint, await jwkThumbprint(agentJwk));
  equals(device.thumbprint, await jwkThumbprint(deviceJwk));

  // Two independent bootstraps never share identity (non-deterministic keys).
  const second = await generateP256Signer("agent_b");
  const secondJwk = await second.publicJwk();
  assert(
    (await jwkThumbprint(secondJwk)) !== agent.thumbprint,
    "generated signers must not be deterministic",
  );
});
