import { assert, equals, rejects } from "../assert.ts";
import {
  DeviceEnrollmentService,
  type PossessionProof,
} from "../../packages/core/src/identity/enrollment.ts";
import { MemoryAuthorityBackend, MemoryStore } from "../../packages/core/src/store/memory_store.ts";
import { ids, type Principal, type TenantContext } from "../../packages/core/src/domain/types.ts";
import {
  fixtureAgentSigner,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import type { DeviceSigner } from "../../packages/core/src/crypto/device_signer.ts";
import { base64url, canonical, encoder } from "../../packages/core/src/crypto/encoding.ts";
import { jwkThumbprint, shortFingerprint } from "../../packages/core/src/crypto/thumbprint.ts";
const ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("principal_7Yp9") },
  now = 2_000_000_000;
const principal: Principal = {
  id: ctx.userId,
  tenantId: ctx.tenantId,
  kind: "cryptographic",
  status: "active",
  emailRequired: false,
  epoch: 0,
};
async function proof(
  signer: DeviceSigner,
  message: unknown,
  challenge: string,
): Promise<PossessionProof> {
  return {
    challenge,
    signature: base64url(
      await signer.sign(encoder.encode(canonical({ ...(message as object), challenge }))),
    ),
  };
}
async function boot(backend = new MemoryAuthorityBackend()) {
  const store = new MemoryStore(backend),
    service = new DeviceEnrollmentService(store),
    device = await fixtureDeviceSigner(0),
    agent = await fixtureAgentSigner();
  const deviceJwk = await device.publicJwk(),
    agentJwk = await agent.publicJwk(),
    agentId = ids.agent("agent_a"),
    deviceId = ids.device("device_a");
  const tx = {
    action: "bootstrap",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    principal_id: principal.id,
    agent_id: agentId,
    agent_jkt: await jwkThumbprint(agentJwk),
    device_id: deviceId,
    device_jkt: await jwkThumbprint(deviceJwk),
  };
  const challenge = await service.bootstrapChallenge(
    ctx,
    principal,
    agentId,
    agentJwk,
    deviceId,
    deviceJwk,
    now,
  );
  await service.bootstrap(
    ctx,
    principal,
    agentId,
    agentJwk,
    deviceId,
    deviceJwk,
    await proof(device, tx, challenge),
    await proof(agent, tx, challenge),
    now,
  );
  return { store, service, device, agent };
}
async function pending(service: DeviceEnrollmentService) {
  const candidate = await fixtureDeviceSigner(1),
    candidateJwk = await candidate.publicJwk(),
    candidateJkt = await jwkThumbprint(candidateJwk);
  const value = {
    id: "enroll_b",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk,
    expiresAt: now + 600,
  };
  const tx = {
    action: "enroll",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: value.id,
    agent_id: value.agentId,
    agent_jkt: (await serviceStore(service).getAgent(ctx, value.agentId))!.thumbprint,
    candidate_jkt: candidateJkt,
    expires_at: value.expiresAt,
  };
  const challenge = await service.requestChallenge(ctx, value, now);
  const result = await service.request(ctx, value, await proof(candidate, tx, challenge), now);
  return { candidate, candidateJkt, result };
}
function serviceStore(service: DeviceEnrollmentService) {
  return (service as unknown as { store: MemoryStore }).store;
}
Deno.test("server challenge atomically bootstraps one opaque principal and binds both keys", async () => {
  const { store } = await boot();
  assert((await store.getPrincipal(ctx, ctx.userId))?.epoch === 1);
  assert(
    (await store.getAgent(ctx, "agent_a"))?.thumbprint !==
      (await store.getDevice(ctx, "device_a"))?.thumbprint,
  );
});
Deno.test("two service instances sharing authority cannot race bootstrap", async () => {
  const backend = new MemoryAuthorityBackend(),
    a = new DeviceEnrollmentService(new MemoryStore(backend)),
    b = new DeviceEnrollmentService(new MemoryStore(backend));
  const device = await fixtureDeviceSigner(0),
    agent = await fixtureAgentSigner(),
    dj = await device.publicJwk(),
    aj = await agent.publicJwk(),
    aid = ids.agent("agent_a"),
    did = ids.device("device_a");
  const tx = {
    action: "bootstrap",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    principal_id: principal.id,
    agent_id: aid,
    agent_jkt: await jwkThumbprint(aj),
    device_id: did,
    device_jkt: await jwkThumbprint(dj),
  };
  const ca = await a.bootstrapChallenge(ctx, principal, aid, aj, did, dj, now),
    cb = await b.bootstrapChallenge(ctx, principal, aid, aj, did, dj, now);
  const results = await Promise.allSettled([
    a.bootstrap(
      ctx,
      principal,
      aid,
      aj,
      did,
      dj,
      await proof(device, tx, ca),
      await proof(agent, tx, ca),
      now,
    ),
    b.bootstrap(
      ctx,
      principal,
      aid,
      aj,
      did,
      dj,
      await proof(device, tx, cb),
      await proof(agent, tx, cb),
      now,
    ),
  ]);
  equals(results.filter((x) => x.status === "fulfilled").length, 1);
});
Deno.test("bootstrap signature rejects substituted agent identity and key", async () => {
  const store = new MemoryStore(),
    service = new DeviceEnrollmentService(store),
    device = await fixtureDeviceSigner(0),
    agent = await fixtureAgentSigner(),
    replacement = await fixtureDeviceSigner(1),
    dj = await device.publicJwk(),
    aj = await agent.publicJwk(),
    rj = await replacement.publicJwk();
  const tx = {
    action: "bootstrap",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    principal_id: principal.id,
    agent_id: ids.agent("agent_a"),
    agent_jkt: await jwkThumbprint(aj),
    device_id: ids.device("device_a"),
    device_jkt: await jwkThumbprint(dj),
  };
  const challenge = await service.bootstrapChallenge(
    ctx,
    principal,
    ids.agent("agent_a"),
    aj,
    ids.device("device_a"),
    dj,
    now,
  );
  const deviceProof = await proof(device, tx, challenge);
  const agentProof = await proof(agent, tx, challenge);
  await rejects(
    () =>
      service.bootstrap(
        ctx,
        principal,
        ids.agent("agent_evil"),
        rj,
        ids.device("device_a"),
        dj,
        deviceProof,
        agentProof,
        now,
      ),
    "proof",
  );
});
Deno.test("candidate and approval challenges bind full tenant transaction and consume once", async () => {
  const { store, service, device: admin } = await boot();
  const { candidateJkt, result } = await pending(service);
  const candidateId = ids.device("device_b"),
    fp = shortFingerprint(candidateJkt),
    approver = (await store.getDevice(ctx, "device_a"))!;
  const tx = {
    action: "approve_enrollment",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: ids.agent("agent_a"),
    candidate_id: candidateId,
    candidate_jkt: candidateJkt,
    fingerprint: fp,
    expires_at: now + 600,
  };
  const challenge = await service.approvalChallenge(
      ctx,
      "enroll_b",
      approver.id,
      candidateId,
      result.fingerprint,
      now,
    ),
    signed = await proof(admin, tx, challenge);
  const outcomes = await Promise.allSettled([
    service.approve(ctx, "enroll_b", approver.id, candidateId, fp, signed, now),
    service.approve(ctx, "enroll_b", approver.id, candidateId, fp, signed, now),
  ]);
  equals(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  equals((await store.listDevices(ctx)).length, 2);
});
Deno.test("approval proof cannot replay across tenant", async () => {
  const { service, device: admin } = await boot();
  const { candidateJkt, result } = await pending(service);
  const fp = result.fingerprint;
  const challenge = await service.approvalChallenge(
    ctx,
    "enroll_b",
    ids.device("device_a"),
    ids.device("device_b"),
    fp,
    now,
  );
  const tx = {
    action: "approve_enrollment",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: ids.device("device_a"),
    approver_jkt: (await serviceStore(service).getDevice(ctx, "device_a"))!.thumbprint,
    agent_id: ids.agent("agent_a"),
    candidate_id: ids.device("device_b"),
    candidate_jkt: candidateJkt,
    fingerprint: fp,
    expires_at: now + 600,
  };
  const signed = await proof(admin, tx, challenge);
  await rejects(
    () =>
      service.approve(
        { tenantId: ids.tenant("tenant_b"), userId: ids.user("user_b") },
        "enroll_b",
        ids.device("device_a"),
        ids.device("device_b"),
        fp,
        signed,
        now,
      ),
    "denied",
  );
});
Deno.test("device removal requires admin proof and consumes server challenge", async () => {
  const { store, service, device } = await boot();
  const target = (await store.getDevice(ctx, "device_a"))!,
    tx = {
      action: "remove_device",
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      approver_id: target.id,
      approver_jkt: target.thumbprint,
      target_id: target.id,
      target_epoch: 1,
    };
  const challenge = await service.removalChallenge(ctx, target.id, target.id, now),
    signed = await proof(device, tx, challenge);
  await service.remove(ctx, target.id, target.id, signed, now);
  assert((await store.getDevice(ctx, target.id))?.epoch === 2);
  await rejects(() => service.remove(ctx, target.id, target.id, signed, now), "denied");
});
