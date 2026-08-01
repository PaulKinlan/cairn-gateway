import { assert, equals, rejects } from "../assert.ts";
import { MemoryStore } from "../../packages/core/src/store/memory_store.ts";
import {
  type Connection,
  type Device,
  type Grant,
  ids,
  type TenantContext,
} from "../../packages/core/src/domain/types.ts";
import { fixtureDeviceSigner } from "../../packages/core/src/crypto/fixture_keys.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";

const ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("user_a") };
const other: TenantContext = { tenantId: ids.tenant("tenant_b"), userId: ids.user("user_b") };
async function seed(
  store: MemoryStore,
): Promise<{ device: Device; connection: Connection; grant: Grant }> {
  const signer = await fixtureDeviceSigner(0);
  const jwk = await signer.publicJwk();
  const device: Device = {
    id: ids.device("device_a"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
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
    agentId: ids.agent("agent_a"),
    deviceId: device.id,
    connectionId: connection.id,
    operation: "github.user.read",
    status: "active",
    version: 1,
    expiresAt: 2_000_001_000,
  };
  await store.putDevice(ctx, device);
  await store.putConnection(ctx, connection);
  await store.putGrant(ctx, grant);
  return { device, connection, grant };
}
function binding() {
  return {
    deviceId: "device_a",
    deviceEpoch: 1,
    grantId: "grant_a",
    grantVersion: 1,
    connectionId: "connection_a",
    connectionEpoch: 1,
    operation: "github.user.read" as const,
    nonceHash: "nonce_hash_a",
    nonceExpiresAt: 2_000_000_600,
    jtiHash: "jti_hash_a",
    jtiExpiresAt: 2_000_000_330,
    now: 2_000_000_000,
  };
}
Deno.test("composite keys hide all entity types from a synthetic second tenant", async () => {
  const store = new MemoryStore();
  await seed(store);
  await store.putPrincipal(ctx, {
    id: ctx.userId,
    tenantId: ctx.tenantId,
    kind: "cryptographic",
    status: "active",
    emailRequired: false,
  });
  await store.putEnrollment(ctx, {
    id: "enroll_a",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk: await (await fixtureDeviceSigner(1)).publicJwk(),
    thumbprint: "thumb",
    challenge: "challenge",
    status: "pending",
    expiresAt: 2_000_000_600,
  });
  equals(await store.getPrincipal(other, "user_a"), undefined);
  equals(await store.getDevice(other, "device_a"), undefined);
  equals(await store.getConnection(other, "connection_a"), undefined);
  equals(await store.getGrant(other, "grant_a"), undefined);
  equals(await store.getEnrollment(other, "enroll_a"), undefined);
  equals(await store.listDevices(other), []);
});
Deno.test("write with mismatched ownership is denied", async () => {
  const store = new MemoryStore();
  const { connection } = await seed(store);
  await rejects(() => store.putConnection(other, connection), "ownership");
});
Deno.test("parallel nonce consumption has exactly one winner", async () => {
  const store = new MemoryStore();
  const results = await Promise.all(
    Array.from({ length: 64 }, () => store.consumeNonce(ctx, "same_nonce_hash", 2000, 1000)),
  );
  equals(results.filter(Boolean).length, 1);
});
Deno.test("parallel invocation consumption has exactly one winner", async () => {
  const store = new MemoryStore();
  await seed(store);
  const results = await Promise.all(
    Array.from({ length: 64 }, () => store.consumeInvocation(ctx, binding())),
  );
  equals(results.filter((item) => item.ok).length, 1);
});
Deno.test("different nonce cannot reuse capability JTI", async () => {
  const store = new MemoryStore();
  await seed(store);
  assert((await store.consumeInvocation(ctx, binding())).ok);
  const second = await store.consumeInvocation(ctx, { ...binding(), nonceHash: "nonce_hash_b" });
  assert(!second.ok && second.reason === "capability replay");
});
Deno.test("grant revocation blocks an already issued binding", async () => {
  const store = new MemoryStore();
  const { grant } = await seed(store);
  await store.updateGrant(ctx, { ...grant, status: "revoked", version: 2 });
  assert(!(await store.consumeInvocation(ctx, binding())).ok);
});
Deno.test("connection epoch change blocks stale binding", async () => {
  const store = new MemoryStore();
  const { connection } = await seed(store);
  await store.updateConnection(ctx, { ...connection, status: "disabled", epoch: 2 });
  assert(!(await store.consumeInvocation(ctx, binding())).ok);
});
Deno.test("device removal epoch blocks stale binding and records revocation", async () => {
  const store = new MemoryStore();
  const { device } = await seed(store);
  await store.updateDevice(ctx, { ...device, status: "revoked", epoch: 2 }, {
    tenantId: ctx.tenantId,
    subjectType: "device",
    subjectId: device.id,
    version: 2,
    reason: "operator",
    at: 2_000_000_000,
  });
  assert(!(await store.consumeInvocation(ctx, binding())).ok);
  equals((await store.revocations(ctx)).length, 1);
  equals((await store.revocations(other)).length, 0);
});
