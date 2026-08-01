import { assert, equals, rejects } from "../assert.ts";
import { MemoryAuthorityBackend, MemoryStore } from "../../packages/core/src/store/memory_store.ts";
import {
  type Connection,
  type Device,
  type Grant,
  ids,
  type TenantContext,
} from "../../packages/core/src/domain/types.ts";
import {
  fixtureAgentSigner,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";
const ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("user_a") },
  other: TenantContext = { tenantId: ids.tenant("tenant_b"), userId: ids.user("user_b") };
async function seed(store: MemoryStore) {
  const signer = await fixtureDeviceSigner(0),
    agentSigner = await fixtureAgentSigner(),
    jwk = await signer.publicJwk(),
    agentJwk = await agentSigner.publicJwk();
  const agent = {
    id: ids.agent("agent_a"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    publicJwk: agentJwk,
    thumbprint: await jwkThumbprint(agentJwk),
    status: "active" as const,
    epoch: 1,
  };
  const device: Device = {
    id: ids.device("device_a"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: agent.id,
    publicJwk: jwk,
    thumbprint: await jwkThumbprint(jwk),
    role: "admin",
    status: "active",
    epoch: 1,
  };
  const connection: Connection = {
    id: ids.connection("connection_a"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    provider: "github",
    adapter: "fixture",
    custodyRef: "opaque_fixture_ref",
    status: "active",
    epoch: 1,
  };
  const grant: Grant = {
    id: "grant_a",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: agent.id,
    deviceId: device.id,
    connectionId: connection.id,
    operation: "github.user.read",
    status: "active",
    version: 1,
    expiresAt: 2_000_001_000,
  };
  await store.putPrincipal(ctx, {
    id: ctx.userId,
    tenantId: ctx.tenantId,
    kind: "cryptographic",
    status: "active",
    emailRequired: false,
    epoch: 1,
  });
  await store.putAgent(ctx, agent);
  await store.putDevice(ctx, device);
  await store.putConnection(ctx, connection);
  await store.putGrant(ctx, grant);
  return { agent, device, connection, grant };
}
const binding = () => ({
  principalId: "user_a",
  principalEpoch: 1,
  agentId: "agent_a",
  agentEpoch: 1,
  deviceId: "device_a",
  deviceEpoch: 1,
  grantId: "grant_a",
  grantVersion: 1,
  connectionId: "connection_a",
  connectionEpoch: 1,
  operation: "github.user.read" as const,
  deviceNonceHash: "device_nonce_hash_a",
  agentNonceHash: "agent_nonce_hash_a",
  nonceExpiresAt: 2_000_000_600,
  jtiHash: "jti_hash_a",
  jtiExpiresAt: 2_000_000_300,
  now: 2_000_000_000,
});
Deno.test("composite keys hide every entity and revocation from a second owner", async () => {
  const store = new MemoryStore();
  const { device } = await seed(store);
  equals(await store.getPrincipal(other, "user_a"), undefined);
  equals(await store.getAgent(other, "agent_a"), undefined);
  equals(await store.getDevice(other, "device_a"), undefined);
  equals(await store.getConnection(other, "connection_a"), undefined);
  equals(await store.getGrant(other, "grant_a"), undefined);
  await store.updateDevice(
    ctx,
    { ...device, status: "revoked", epoch: 2 },
    "operator",
    2_000_000_000,
  );
  equals((await store.revocations(ctx)).length, 1);
  equals(await store.revocations(other), []);
});
Deno.test("ownership and custody references cannot cross tenants", async () => {
  const backend = new MemoryAuthorityBackend(),
    a = new MemoryStore(backend),
    b = new MemoryStore(backend);
  const { connection } = await seed(a);
  await rejects(() => b.putConnection(other, connection), "ownership");
  await rejects(
    () =>
      b.putConnection(other, {
        ...connection,
        id: ids.connection("other"),
        tenantId: other.tenantId,
        userId: other.userId,
      }),
    "custody ownership",
  );
});
Deno.test("connection updates cannot rotate or alias custody references", async () => {
  const backend = new MemoryAuthorityBackend(),
    a = new MemoryStore(backend),
    b = new MemoryStore(backend);
  const { connection } = await seed(a);
  const otherConnection: Connection = {
    ...connection,
    id: ids.connection("connection_b"),
    tenantId: other.tenantId,
    userId: other.userId,
    custodyRef: "opaque_fixture_ref_b",
  };
  await b.putConnection(other, otherConnection);
  await rejects(
    () =>
      b.updateConnection(other, {
        ...otherConnection,
        custodyRef: connection.custodyRef,
        epoch: 2,
      }),
    "custody ownership",
  );
  equals((await b.getConnection(other, otherConnection.id))!.custodyRef, "opaque_fixture_ref_b");
});
Deno.test("parallel nonce consumption through shared facades has one winner", async () => {
  const backend = new MemoryAuthorityBackend(),
    a = new MemoryStore(backend),
    b = new MemoryStore(backend);
  const results = await Promise.all(
    Array.from({ length: 64 }, (_, i) => (i % 2 ? a : b).consumeNonce(ctx, "same", 2000, 1000)),
  );
  equals(results.filter(Boolean).length, 1);
});
Deno.test("same invocation proof cannot replay across service/store instances", async () => {
  const backend = new MemoryAuthorityBackend(),
    a = new MemoryStore(backend),
    b = new MemoryStore(backend);
  await seed(a);
  const results = await Promise.all([
    a.consumeInvocation(ctx, binding()),
    b.consumeInvocation(ctx, binding()),
  ]);
  equals(results.filter((x) => x.ok).length, 1);
});
Deno.test("principal, agent, device, grant and connection revocation each block stale binding", async () => {
  for (const kind of ["principal", "agent", "device", "grant", "connection"] as const) {
    const store = new MemoryStore(), seeded = await seed(store);
    if (kind === "principal") {
      await store.updatePrincipal(ctx, {
        ...(await store.getPrincipal(ctx, ctx.userId))!,
        status: "revoked",
        epoch: 2,
      });
    }
    if (kind === "agent") {
      await store.updateAgent(ctx, { ...seeded.agent, status: "revoked", epoch: 2 });
    }
    if (kind === "device") {
      await store.updateDevice(ctx, { ...seeded.device, status: "revoked", epoch: 2 });
    }
    if (kind === "grant") {
      await store.updateGrant(ctx, { ...seeded.grant, status: "revoked", version: 2 });
    }
    if (kind === "connection") {
      await store.updateConnection(ctx, { ...seeded.connection, status: "revoked", epoch: 2 });
    }
    assert(!(await store.consumeInvocation(ctx, binding())).ok);
  }
});
Deno.test("agent-device-grant substitution is denied", async () => {
  const store = new MemoryStore();
  await seed(store);
  assert(!(await store.consumeInvocation(ctx, { ...binding(), agentId: "other_agent" })).ok);
});
Deno.test("epochs and versions cannot roll back or reactivate stale state", async () => {
  const store = new MemoryStore();
  const { device } = await seed(store);
  await store.updateDevice(ctx, { ...device, status: "revoked", epoch: 2 });
  await rejects(
    () => store.updateDevice(ctx, { ...device, status: "active", epoch: 1 }),
    "increase",
  );
});

Deno.test("raw identity writes cannot drift or rotate JWK thumbprints", async () => {
  const store = new MemoryStore();
  const { agent, device } = await seed(store);
  const replacement = await fixtureDeviceSigner(1), replacementJwk = await replacement.publicJwk();
  const replacementThumbprint = await jwkThumbprint(replacementJwk);
  await rejects(
    () =>
      store.updateAgent(ctx, {
        ...agent,
        publicJwk: replacementJwk,
        thumbprint: replacementThumbprint,
        epoch: 2,
      }),
    "rotation denied",
  );
  await rejects(
    () =>
      store.updateDevice(ctx, {
        ...device,
        publicJwk: replacementJwk,
        thumbprint: replacementThumbprint,
        epoch: 2,
      }),
    "rotation denied",
  );
  const malformed = new MemoryStore();
  await rejects(
    () => malformed.putAgent(ctx, { ...agent, publicJwk: replacementJwk }),
    "agent key denied",
  );
  await rejects(
    () =>
      store.putDevice(ctx, {
        ...device,
        id: ids.device("device_role_collapse"),
        publicJwk: agent.publicJwk,
        thumbprint: agent.thumbprint,
      }),
    "keys must differ",
  );
});

Deno.test("device role, parent agent, and owner-wide agent/device key roles are immutable", async () => {
  const store = new MemoryStore();
  const { agent } = await seed(store);
  const memberSigner = await fixtureDeviceSigner(1);
  const memberJwk = await memberSigner.publicJwk();
  const member: Device = {
    id: ids.device("device_member"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: agent.id,
    publicJwk: memberJwk,
    thumbprint: await jwkThumbprint(memberJwk),
    role: "member",
    status: "active",
    epoch: 1,
  };
  await store.putDevice(ctx, member);
  await rejects(
    () => store.updateDevice(ctx, { ...member, role: "admin", epoch: 2 }),
    "relationship mutation denied",
  );
  const otherAgentPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const otherAgentJwk = await crypto.subtle.exportKey("jwk", otherAgentPair.publicKey);
  const otherAgent = {
    ...agent,
    id: ids.agent("agent_b"),
    publicJwk: otherAgentJwk,
    thumbprint: await jwkThumbprint(otherAgentJwk),
  };
  await store.putAgent(ctx, otherAgent);
  await rejects(
    () => store.updateDevice(ctx, { ...member, agentId: otherAgent.id, epoch: 2 }),
    "relationship mutation denied",
  );
  await rejects(
    () =>
      store.putAgent(ctx, {
        ...agent,
        id: ids.agent("agent_collapse"),
        publicJwk: member.publicJwk,
        thumbprint: member.thumbprint,
      }),
    "keys must differ",
  );
  equals((await store.getDevice(ctx, member.id))!.role, "member");
  equals((await store.getDevice(ctx, member.id))!.agentId, agent.id);
});
