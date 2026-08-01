import { assert, equals, rejects } from "../assert.ts";
import {
  DeviceEnrollmentService,
  type PossessionProof,
} from "../../packages/core/src/identity/enrollment.ts";
import { MemoryStore } from "../../packages/core/src/store/memory_store.ts";
import { ids, type TenantContext } from "../../packages/core/src/domain/types.ts";
import {
  fixtureAgentSigner,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import type { DeviceSigner } from "../../packages/core/src/crypto/device_signer.ts";
import { base64url, canonical, encoder } from "../../packages/core/src/crypto/encoding.ts";
import { jwkThumbprint, shortFingerprint } from "../../packages/core/src/crypto/thumbprint.ts";
const ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("principal_7Yp9") };
const now = 2_000_000_000;
async function proof(
  signer: DeviceSigner,
  message: unknown,
  challenge: string,
): Promise<PossessionProof> {
  return { challenge, signature: base64url(await signer.sign(encoder.encode(canonical(message)))) };
}
async function boot() {
  const store = new MemoryStore();
  const service = new DeviceEnrollmentService(store);
  const device = await fixtureDeviceSigner(0);
  const agent = await fixtureAgentSigner();
  const jwk = await device.publicJwk();
  const jkt = await jwkThumbprint(jwk);
  const challenge = "bootstrap_challenge_012345";
  const message = {
    action: "bootstrap",
    challenge,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    device_id: ids.device("device_a"),
    device_jkt: jkt,
  };
  await service.bootstrap(
    ctx,
    {
      id: ctx.userId,
      tenantId: ctx.tenantId,
      kind: "cryptographic",
      status: "active",
      emailRequired: false,
    },
    ids.agent("agent_a"),
    await agent.publicJwk(),
    ids.device("device_a"),
    jwk,
    await proof(device, message, challenge),
  );
  return { store, service, device };
}
Deno.test("opaque cryptographic principal bootstraps without email and proves device key", async () => {
  const { store } = await boot();
  const principal = await store.getPrincipal(ctx, ctx.userId);
  assert(principal?.kind === "cryptographic" && principal.emailRequired === false);
  assert(
    (await store.getAgent(ctx, "agent_a"))?.thumbprint !==
      (await store.getDevice(ctx, "device_a"))?.thumbprint,
  );
});
Deno.test("bootstrap cannot be replayed", async () => {
  const { service, device } = await boot();
  const jwk = await device.publicJwk();
  const challenge = "bootstrap_challenge_012345";
  const message = {
    action: "bootstrap",
    challenge,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    device_id: ids.device("device_a"),
    device_jkt: await jwkThumbprint(jwk),
  };
  await rejects(
    async () =>
      await service.bootstrap(
        ctx,
        {
          id: ctx.userId,
          tenantId: ctx.tenantId,
          kind: "cryptographic",
          status: "active",
          emailRequired: false,
        },
        ids.agent("agent_a"),
        jwk,
        ids.device("device_a"),
        jwk,
        await proof(device, message, challenge),
      ),
    "already",
  );
});
Deno.test("second device proves possession then requires distinct admin approval", async () => {
  const { store, service, device: admin } = await boot();
  const candidate = await fixtureDeviceSigner(1);
  const candidateJwk = await candidate.publicJwk();
  const candidateJkt = await jwkThumbprint(candidateJwk);
  const challenge = "candidate_challenge_012345";
  const requestBase = {
    id: "enroll_b",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk,
    challenge,
    expiresAt: now + 600,
  };
  const enrollMessage = {
    action: "enroll",
    challenge,
    request_id: "enroll_b",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    agent_id: ids.agent("agent_a"),
    candidate_jkt: candidateJkt,
    expires_at: now + 600,
  };
  const pending = await service.request(
    ctx,
    requestBase,
    await proof(candidate, enrollMessage, challenge),
    now,
  );
  const approveChallenge = "approval_challenge_012345";
  const fingerprint = shortFingerprint(candidateJkt);
  const approvalMessage = {
    action: "approve_enrollment",
    challenge: approveChallenge,
    request_id: "enroll_b",
    candidate_id: ids.device("device_b"),
    candidate_jkt: candidateJkt,
    fingerprint,
  };
  const approved = await service.approve(
    ctx,
    "enroll_b",
    ids.device("device_a"),
    ids.device("device_b"),
    pending.fingerprint,
    await proof(admin, approvalMessage, approveChallenge),
    now,
  );
  equals(approved.role, "member");
  equals((await store.listDevices(ctx)).length, 2);
});
Deno.test("candidate cannot self-approve", async () => {
  const { service } = await boot();
  const candidate = await fixtureDeviceSigner(1);
  const jwk = await candidate.publicJwk();
  const jkt = await jwkThumbprint(jwk);
  const challenge = "candidate_challenge_012345";
  const base = {
    id: "enroll_b",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk: jwk,
    challenge,
    expiresAt: now + 600,
  };
  const message = {
    action: "enroll",
    challenge,
    request_id: "enroll_b",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    agent_id: ids.agent("agent_a"),
    candidate_jkt: jkt,
    expires_at: now + 600,
  };
  await service.request(ctx, base, await proof(candidate, message, challenge), now);
  await rejects(
    () =>
      service.approve(
        ctx,
        "enroll_b",
        ids.device("device_b"),
        ids.device("device_b"),
        shortFingerprint(jkt),
        { challenge: "x", signature: "x" },
        now,
      ),
    "self",
  );
});
Deno.test("altered candidate key and wrong fingerprint deny", async () => {
  const { service, device: admin } = await boot();
  const candidate = await fixtureDeviceSigner(1);
  const jwk = await candidate.publicJwk();
  const jkt = await jwkThumbprint(jwk);
  const challenge = "candidate_challenge_012345";
  const base = {
    id: "enroll_b",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk: jwk,
    challenge,
    expiresAt: now + 600,
  };
  const message = {
    action: "enroll",
    challenge,
    request_id: "enroll_b",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    agent_id: ids.agent("agent_a"),
    candidate_jkt: jkt,
    expires_at: now + 600,
  };
  await service.request(ctx, base, await proof(candidate, message, challenge), now);
  await rejects(
    () =>
      service.approve(
        ctx,
        "enroll_b",
        ids.device("device_a"),
        ids.device("device_b"),
        "WRONG-000",
        { challenge: "x", signature: "x" },
        now,
      ),
    "denied",
  );
  const approvalMessage = {
    action: "approve_enrollment",
    challenge: "approval_challenge_012345",
    request_id: "enroll_b",
    candidate_id: ids.device("device_b"),
    candidate_jkt: jkt,
    fingerprint: shortFingerprint(jkt),
  };
  await rejects(
    async () =>
      await service.approve(
        { tenantId: ids.tenant("tenant_b"), userId: ids.user("principal_b") },
        "enroll_b",
        ids.device("device_a"),
        ids.device("device_b"),
        shortFingerprint(jkt),
        await proof(admin, approvalMessage, "approval_challenge_012345"),
        now,
      ),
    "denied",
  );
});
Deno.test("removal increments device epoch immediately", async () => {
  const { store, service } = await boot();
  await service.remove(ctx, ids.device("device_a"), now);
  const device = await store.getDevice(ctx, "device_a");
  assert(device?.status === "revoked" && device.epoch === 2);
});
