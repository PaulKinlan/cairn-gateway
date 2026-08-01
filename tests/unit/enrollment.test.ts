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
import type {
  ApprovalCommit,
  BootstrapCommit,
  EnrollmentRequestCommit,
  RemovalCommit,
} from "../../packages/core/src/store/store.ts";
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
    principal_epoch: 1,
    agent_epoch: 1,
    device_epoch: 1,
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
    principal_epoch: 1,
    agent_epoch: 1,
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
Deno.test("bootstrap requires an empty owner identity namespace", async () => {
  const store = new MemoryStore();
  const service = new DeviceEnrollmentService(store);
  const device = await fixtureDeviceSigner(0), agent = await fixtureAgentSigner();
  const deviceJwk = await device.publicJwk(), agentJwk = await agent.publicJwk();
  await store.putAgent(ctx, {
    id: ids.agent("agent_existing"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    publicJwk: deviceJwk,
    thumbprint: await jwkThumbprint(deviceJwk),
    status: "active",
    epoch: 1,
  });
  const agentId = ids.agent("agent_bootstrap"), deviceId = ids.device("device_bootstrap");
  const tx = {
    action: "bootstrap",
    principal_epoch: 1,
    agent_epoch: 1,
    device_epoch: 1,
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
  await rejects(
    async () =>
      service.bootstrap(
        ctx,
        principal,
        agentId,
        agentJwk,
        deviceId,
        deviceJwk,
        await proof(device, tx, challenge),
        await proof(agent, tx, challenge),
        now,
      ),
    "bootstrap denied",
  );
  equals(await store.getPrincipal(ctx, ctx.userId), undefined);
  equals(await store.getAgent(ctx, agentId), undefined);
  equals(await store.getDevice(ctx, deviceId), undefined);
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
    principal_epoch: 1,
    agent_epoch: 1,
    device_epoch: 1,
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
    principal_epoch: 1,
    agent_epoch: 1,
    device_epoch: 1,
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
Deno.test("authoritative commit inputs reject accessors without observation", async () => {
  const store = new MemoryStore();
  let reads = 0;
  const accessor = <T>(property: string): T => {
    const value = {} as T;
    Object.defineProperty(value, property, {
      enumerable: true,
      get: () => {
        reads++;
        return {};
      },
    });
    return value;
  };
  await rejects(
    () => store.commitBootstrap(ctx, "unused", accessor<BootstrapCommit>("principal"), now),
    "plain data denied",
  );
  await rejects(
    () =>
      store.commitEnrollmentRequest(
        ctx,
        "unused",
        accessor<EnrollmentRequestCommit>("request"),
        now,
      ),
    "plain data denied",
  );
  await rejects(
    () => store.commitApproval(ctx, "unused", accessor<ApprovalCommit>("device"), now),
    "plain data denied",
  );
  await rejects(
    () => store.commitRemoval(ctx, "unused", accessor<RemovalCommit>("agentId"), now),
    "plain data denied",
  );
  equals(reads, 0);
});

Deno.test("hostile approval role and JWK inputs neither consume challenge nor elevate", async () => {
  for (const hostileField of ["role-accessor", "jwk-accessor", "self-removing-proxy"] as const) {
    const backend = new MemoryAuthorityBackend();
    const { store, service, device: admin } = await boot(backend);
    const { candidateJkt, result } = await pending(service);
    const approver = (await store.getDevice(ctx, "device_a"))!;
    const candidateId = ids.device(`device_${hostileField}`);
    const tx = {
      action: "approve_enrollment",
      principal_epoch: 1,
      agent_epoch: 1,
      agent_jkt: (await store.getAgent(ctx, "agent_a"))!.thumbprint,
      approver_epoch: 1,
      candidate_epoch: 1,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      request_id: "enroll_b",
      approver_id: approver.id,
      approver_jkt: approver.thumbprint,
      agent_id: ids.agent("agent_a"),
      candidate_id: candidateId,
      candidate_jkt: candidateJkt,
      fingerprint: result.fingerprint,
      expires_at: now + 600,
    };
    const challenge = await service.approvalChallenge(
      ctx,
      "enroll_b",
      approver.id,
      candidateId,
      result.fingerprint,
      now,
    );
    const signed = await proof(admin, tx, challenge);
    let hostileReads = 0;
    class HostileApprovalStore extends MemoryStore {
      override async commitApproval(
        context: TenantContext,
        challengeId: string,
        value: ApprovalCommit,
        at: number,
      ) {
        const hostile: ApprovalCommit = { ...value, device: { ...value.device } };
        if (hostileField === "role-accessor") {
          Object.defineProperty(hostile.device, "role", {
            enumerable: true,
            get: () => {
              hostileReads++;
              return hostileReads === 1 ? "member" : "admin";
            },
          });
        } else if (hostileField === "jwk-accessor") {
          const publicJwk = hostile.device.publicJwk;
          Object.defineProperty(hostile.device, "publicJwk", {
            enumerable: true,
            get: () => {
              hostileReads++;
              return publicJwk;
            },
          });
        } else {
          const publicJwk = hostile.device.publicJwk;
          hostile.device.publicJwk = new Proxy(publicJwk, {
            getPrototypeOf: (target) => {
              hostileReads++;
              hostile.device.publicJwk = structuredClone(publicJwk);
              return Object.getPrototypeOf(target);
            },
          });
        }
        return await super.commitApproval(context, challengeId, hostile, at);
      }
    }
    const hostileService = new DeviceEnrollmentService(new HostileApprovalStore(backend));
    await rejects(
      () =>
        hostileService.approve(
          ctx,
          "enroll_b",
          approver.id,
          candidateId,
          result.fingerprint,
          signed,
          now,
        ),
      "plain data denied",
    );
    equals(hostileReads, 0);
    equals(await store.getDevice(ctx, candidateId), undefined);

    await service.approve(
      ctx,
      "enroll_b",
      approver.id,
      candidateId,
      result.fingerprint,
      signed,
      now,
    );
    equals((await store.getDevice(ctx, candidateId))!.role, "member");
  }
});

Deno.test("candidate and approval challenges bind full tenant transaction and consume once", async () => {
  const { store, service, device: admin } = await boot();
  const { candidateJkt, result } = await pending(service);
  const candidateId = ids.device("device_b"),
    fp = shortFingerprint(candidateJkt),
    approver = (await store.getDevice(ctx, "device_a"))!;
  const tx = {
    action: "approve_enrollment",
    principal_epoch: 1,
    agent_epoch: 1,
    agent_jkt: (await serviceStore(service).getAgent(ctx, "agent_a"))!.thumbprint,
    approver_epoch: 1,
    candidate_epoch: 1,
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
    principal_epoch: 1,
    agent_epoch: 1,
    agent_jkt: (await serviceStore(service).getAgent(ctx, "agent_a"))!.thumbprint,
    approver_epoch: 1,
    candidate_epoch: 1,
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
    agent = (await store.getAgent(ctx, target.agentId))!,
    tx = {
      action: "remove_device",
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      agent_id: agent.id,
      agent_epoch: agent.epoch,
      agent_jkt: agent.thumbprint,
      approver_id: target.id,
      approver_epoch: target.epoch,
      approver_jkt: target.thumbprint,
      target_id: target.id,
      target_epoch: target.epoch,
      target_jkt: target.thumbprint,
    };
  const challenge = await service.removalChallenge(ctx, target.id, target.id, now),
    signed = await proof(device, tx, challenge);
  await service.remove(ctx, target.id, target.id, signed, now);
  assert((await store.getDevice(ctx, target.id))?.epoch === 2);
  await rejects(() => service.remove(ctx, target.id, target.id, signed, now), "denied");
});

Deno.test("enrollment request commit denies agent revocation at linearization", async () => {
  const backend = new MemoryAuthorityBackend();
  await boot(backend);
  class RevokingRequestStore extends MemoryStore {
    override async commitEnrollmentRequest(
      ...args: Parameters<MemoryStore["commitEnrollmentRequest"]>
    ) {
      const agent = (await this.getAgent(ctx, "agent_a"))!;
      await this.updateAgent(ctx, { ...agent, status: "revoked", epoch: agent.epoch + 1 });
      return await super.commitEnrollmentRequest(...args);
    }
  }
  const service = new DeviceEnrollmentService(new RevokingRequestStore(backend));
  const candidate = await fixtureDeviceSigner(1), candidateJwk = await candidate.publicJwk();
  const value = {
    id: "enroll_race",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk,
    expiresAt: now + 600,
  };
  const agent = (await serviceStore(service).getAgent(ctx, value.agentId))!;
  const tx = {
    action: "enroll",
    principal_epoch: 1,
    agent_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: value.id,
    agent_id: value.agentId,
    agent_jkt: agent.thumbprint,
    candidate_jkt: await jwkThumbprint(candidateJwk),
    expires_at: value.expiresAt,
  };
  const challenge = await service.requestChallenge(ctx, value, now);
  const signed = await proof(candidate, tx, challenge);
  await rejects(() => service.request(ctx, value, signed, now), "denied");
  equals(await serviceStore(service).getEnrollment(ctx, value.id), undefined);
});

Deno.test("approval commit denies revoked agent before linearization", async () => {
  const { store, service, device: admin } = await boot();
  const { candidateJkt, result } = await pending(service);
  const approver = (await store.getDevice(ctx, "device_a"))!, candidateId = ids.device("device_b");
  const tx = {
    action: "approve_enrollment",
    principal_epoch: 1,
    agent_epoch: 1,
    agent_jkt: (await serviceStore(service).getAgent(ctx, "agent_a"))!.thumbprint,
    approver_epoch: 1,
    candidate_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: ids.agent("agent_a"),
    candidate_id: candidateId,
    candidate_jkt: candidateJkt,
    fingerprint: result.fingerprint,
    expires_at: now + 600,
  };
  const challenge = await service.approvalChallenge(
    ctx,
    "enroll_b",
    approver.id,
    candidateId,
    result.fingerprint,
    now,
  );
  const signed = await proof(admin, tx, challenge);
  const agent = (await store.getAgent(ctx, "agent_a"))!;
  await store.updateAgent(ctx, { ...agent, status: "revoked", epoch: agent.epoch + 1 });
  await rejects(
    () =>
      service.approve(ctx, "enroll_b", approver.id, candidateId, result.fingerprint, signed, now),
    "denied",
  );
  equals(await store.getDevice(ctx, candidateId), undefined);
});

Deno.test("approval commit denies revoked principal before linearization", async () => {
  const { store, service, device: admin } = await boot();
  const { candidateJkt, result } = await pending(service);
  const approver = (await store.getDevice(ctx, "device_a"))!;
  const candidateId = ids.device("device_b");
  const tx = {
    action: "approve_enrollment",
    principal_epoch: 1,
    agent_epoch: 1,
    agent_jkt: (await serviceStore(service).getAgent(ctx, "agent_a"))!.thumbprint,
    approver_epoch: 1,
    candidate_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: ids.agent("agent_a"),
    candidate_id: candidateId,
    candidate_jkt: candidateJkt,
    fingerprint: result.fingerprint,
    expires_at: now + 600,
  };
  const challenge = await service.approvalChallenge(
    ctx,
    "enroll_b",
    approver.id,
    candidateId,
    result.fingerprint,
    now,
  );
  const signed = await proof(admin, tx, challenge);
  const current = (await store.getPrincipal(ctx, ctx.userId))!;
  await store.updatePrincipal(ctx, { ...current, status: "revoked", epoch: current.epoch + 1 });
  await rejects(
    () =>
      service.approve(ctx, "enroll_b", approver.id, candidateId, result.fingerprint, signed, now),
    "denied",
  );
  equals(await store.getDevice(ctx, candidateId), undefined);
});

Deno.test("approval commit atomically denies admin revocation race", async () => {
  const backend = new MemoryAuthorityBackend();
  const { store, service, device: admin } = await boot(backend);
  const { candidateJkt, result } = await pending(service);
  const approver = (await store.getDevice(ctx, "device_a"))!, candidateId = ids.device("device_b");
  const tx = {
    action: "approve_enrollment",
    principal_epoch: 1,
    agent_epoch: 1,
    agent_jkt: (await serviceStore(service).getAgent(ctx, "agent_a"))!.thumbprint,
    approver_epoch: 1,
    candidate_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: ids.agent("agent_a"),
    candidate_id: candidateId,
    candidate_jkt: candidateJkt,
    fingerprint: result.fingerprint,
    expires_at: now + 600,
  };
  const challenge = await service.approvalChallenge(
    ctx,
    "enroll_b",
    approver.id,
    candidateId,
    result.fingerprint,
    now,
  );
  const signed = await proof(admin, tx, challenge);
  class RevokingApprovalStore extends MemoryStore {
    override async commitApproval(...args: Parameters<MemoryStore["commitApproval"]>) {
      const current = (await this.getDevice(ctx, approver.id))!;
      await this.updateDevice(ctx, { ...current, status: "revoked", epoch: current.epoch + 1 });
      return await super.commitApproval(...args);
    }
  }
  const racing = new DeviceEnrollmentService(new RevokingApprovalStore(backend));
  await rejects(
    () =>
      racing.approve(ctx, "enroll_b", approver.id, candidateId, result.fingerprint, signed, now),
    "denied",
  );
  equals(await store.getDevice(ctx, candidateId), undefined);
});

Deno.test("approval commit denies candidate transaction mutation at linearization", async () => {
  const backend = new MemoryAuthorityBackend();
  const { store, service, device: admin } = await boot(backend);
  const { candidateJkt, result } = await pending(service);
  const approver = (await store.getDevice(ctx, "device_a"))!;
  const candidateId = ids.device("device_b");
  const tx = {
    action: "approve_enrollment",
    principal_epoch: 1,
    agent_epoch: 1,
    agent_jkt: (await serviceStore(service).getAgent(ctx, "agent_a"))!.thumbprint,
    approver_epoch: 1,
    candidate_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: ids.agent("agent_a"),
    candidate_id: candidateId,
    candidate_jkt: candidateJkt,
    fingerprint: result.fingerprint,
    expires_at: now + 600,
  };
  const challenge = await service.approvalChallenge(
    ctx,
    "enroll_b",
    approver.id,
    candidateId,
    result.fingerprint,
    now,
  );
  const signed = await proof(admin, tx, challenge);
  class MutatingApprovalStore extends MemoryStore {
    override async commitApproval(...args: Parameters<MemoryStore["commitApproval"]>) {
      const request = (await this.getEnrollment(ctx, "enroll_b"))!;
      await this.putEnrollment(ctx, { ...request, thumbprint: "mutated_candidate_thumbprint" });
      return await super.commitApproval(...args);
    }
  }
  const racing = new DeviceEnrollmentService(new MutatingApprovalStore(backend));
  await rejects(
    () =>
      racing.approve(ctx, "enroll_b", approver.id, candidateId, result.fingerprint, signed, now),
    "denied",
  );
  equals(await store.getDevice(ctx, candidateId), undefined);
});

Deno.test("authoritative request recomputes candidate JWK thumbprint", async () => {
  const backend = new MemoryAuthorityBackend();
  await boot(backend);
  const replacement = await fixtureDeviceSigner(0);
  const replacementJwk = await replacement.publicJwk();
  class SubstitutingRequestStore extends MemoryStore {
    override async commitEnrollmentRequest(
      context: TenantContext,
      challengeId: string,
      value: EnrollmentRequestCommit,
      at: number,
    ) {
      return await super.commitEnrollmentRequest(context, challengeId, {
        ...value,
        request: { ...value.request, candidateJwk: replacementJwk },
      }, at);
    }
  }
  const service = new DeviceEnrollmentService(new SubstitutingRequestStore(backend));
  const candidate = await fixtureDeviceSigner(1), candidateJwk = await candidate.publicJwk();
  const value = {
    id: "enroll_substitution",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk,
    expiresAt: now + 600,
  };
  const candidateJkt = await jwkThumbprint(candidateJwk);
  const tx = {
    action: "enroll",
    principal_epoch: 1,
    agent_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: value.id,
    agent_id: value.agentId,
    agent_jkt: (await serviceStore(service).getAgent(ctx, value.agentId))!.thumbprint,
    candidate_jkt: candidateJkt,
    expires_at: value.expiresAt,
  };
  const challenge = await service.requestChallenge(ctx, value, now);
  const candidateProof = await proof(candidate, tx, challenge);
  await rejects(
    () => service.request(ctx, value, candidateProof, now),
    "denied",
  );
  equals(await serviceStore(service).getEnrollment(ctx, value.id), undefined);
});

Deno.test("authoritative request reconstructs signed expiry and request id", async () => {
  for (const mutation of ["expiry", "request-id"] as const) {
    const backend = new MemoryAuthorityBackend();
    await boot(backend);
    class MutatingSignedRequestStore extends MemoryStore {
      override async commitEnrollmentRequest(
        context: TenantContext,
        challengeId: string,
        value: EnrollmentRequestCommit,
        at: number,
      ) {
        return await super.commitEnrollmentRequest(context, challengeId, {
          ...value,
          request: {
            ...value.request,
            ...(mutation === "expiry"
              ? { expiresAt: value.request.expiresAt + 50 }
              : { id: `${value.request.id}_substituted` }),
          },
        }, at);
      }
    }
    const service = new DeviceEnrollmentService(new MutatingSignedRequestStore(backend));
    const candidate = await fixtureDeviceSigner(1), candidateJwk = await candidate.publicJwk();
    const value = {
      id: `signed_${mutation}`,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentId: ids.agent("agent_a"),
      candidateJwk,
      expiresAt: now + 500,
    };
    const candidateJkt = await jwkThumbprint(candidateJwk);
    const tx = {
      action: "enroll",
      principal_epoch: 1,
      agent_epoch: 1,
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      request_id: value.id,
      agent_id: value.agentId,
      agent_jkt: (await serviceStore(service).getAgent(ctx, value.agentId))!.thumbprint,
      candidate_jkt: candidateJkt,
      expires_at: value.expiresAt,
    };
    const challenge = await service.requestChallenge(ctx, value, now);
    const signed = await proof(candidate, tx, challenge);
    await rejects(
      () => service.request(ctx, value, signed, now),
      "denied",
    );
    equals(await serviceStore(service).getEnrollment(ctx, value.id), undefined);
  }
});

Deno.test("agent key cannot be enrolled as a device key", async () => {
  const { service, agent } = await boot();
  const agentJwk = await agent.publicJwk();
  const value = {
    id: "enroll_role_collapse",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk: agentJwk,
    expiresAt: now + 600,
  };
  await rejects(() => service.requestChallenge(ctx, value, now), "keys must differ");
});

Deno.test("approval recomputes stored candidate JWK thumbprint", async () => {
  const backend = new MemoryAuthorityBackend();
  const { store, service, device: admin } = await boot(backend);
  const { candidateJkt, result } = await pending(service);
  const requestKey = [...backend.enrollments.keys()].find((key) => key.endsWith("/enroll_b"))!;
  const request = backend.enrollments.get(requestKey)!;
  const replacement = await fixtureDeviceSigner(0);
  backend.enrollments.set(requestKey, {
    ...request,
    candidateJwk: await replacement.publicJwk(),
  });
  const approver = (await store.getDevice(ctx, "device_a"))!;
  const candidateId = ids.device("device_b");
  const tx = {
    action: "approve_enrollment",
    principal_epoch: 1,
    agent_epoch: 1,
    agent_jkt: (await serviceStore(service).getAgent(ctx, "agent_a"))!.thumbprint,
    approver_epoch: 1,
    candidate_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: ids.agent("agent_a"),
    candidate_id: candidateId,
    candidate_jkt: candidateJkt,
    fingerprint: result.fingerprint,
    expires_at: now + 600,
  };
  const challenge = await service.approvalChallenge(
    ctx,
    "enroll_b",
    approver.id,
    candidateId,
    result.fingerprint,
    now,
  );
  const signed = await proof(admin, tx, challenge);
  await rejects(
    () =>
      service.approve(
        ctx,
        "enroll_b",
        approver.id,
        candidateId,
        result.fingerprint,
        signed,
        now,
      ),
    "denied",
  );
  equals(await store.getDevice(ctx, candidateId), undefined);
});

Deno.test("approval authoritatively recomputes the admin JWK thumbprint", async () => {
  const backend = new MemoryAuthorityBackend();
  const { store, service, agent } = await boot(backend);
  const { candidateJkt, result } = await pending(service);
  const approver = (await store.getDevice(ctx, "device_a"))!;
  const approverKey = [...backend.devices.keys()].find((key) => key.endsWith("/device_a"))!;
  backend.devices.set(approverKey, { ...approver, publicJwk: await agent.publicJwk() });
  const candidateId = ids.device("device_admin_jwk_negative");
  const tx = {
    action: "approve_enrollment",
    principal_epoch: 1,
    agent_epoch: 1,
    agent_jkt: (await serviceStore(service).getAgent(ctx, "agent_a"))!.thumbprint,
    approver_epoch: 1,
    candidate_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: ids.agent("agent_a"),
    candidate_id: candidateId,
    candidate_jkt: candidateJkt,
    fingerprint: result.fingerprint,
    expires_at: now + 600,
  };
  const challenge = await service.approvalChallenge(
    ctx,
    "enroll_b",
    approver.id,
    candidateId,
    result.fingerprint,
    now,
  );
  const signed = await proof(agent, tx, challenge);
  await rejects(
    () =>
      service.approve(
        ctx,
        "enroll_b",
        approver.id,
        candidateId,
        result.fingerprint,
        signed,
        now,
      ),
    "denied",
  );
  equals(await store.getDevice(ctx, candidateId), undefined);
});

Deno.test("approval challenge binds coherent authoritative agent key substitution", async () => {
  const backend = new MemoryAuthorityBackend();
  const { store, service, device: admin } = await boot(backend);
  const { candidateJkt, result } = await pending(service);
  const approver = (await store.getDevice(ctx, "device_a"))!;
  const agent = (await store.getAgent(ctx, "agent_a"))!;
  const candidateId = ids.device("device_agent_jkt_negative");
  const tx = {
    action: "approve_enrollment",
    principal_epoch: 1,
    agent_epoch: agent.epoch,
    agent_jkt: agent.thumbprint,
    approver_epoch: approver.epoch,
    candidate_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: "enroll_b",
    approver_id: approver.id,
    approver_jkt: approver.thumbprint,
    agent_id: agent.id,
    candidate_id: candidateId,
    candidate_jkt: candidateJkt,
    fingerprint: result.fingerprint,
    expires_at: now + 600,
  };
  const challenge = await service.approvalChallenge(
    ctx,
    "enroll_b",
    approver.id,
    candidateId,
    result.fingerprint,
    now,
  );
  const signed = await proof(admin, tx, challenge);
  const replacementPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const replacementJwk = await crypto.subtle.exportKey("jwk", replacementPair.publicKey);
  const agentKey = [...backend.agents.keys()].find((key) => key.endsWith("/agent_a"))!;
  backend.agents.set(agentKey, {
    ...agent,
    publicJwk: replacementJwk,
    thumbprint: await jwkThumbprint(replacementJwk),
  });
  await rejects(
    () =>
      service.approve(
        ctx,
        "enroll_b",
        approver.id,
        candidateId,
        result.fingerprint,
        signed,
        now,
      ),
    "proof",
  );
  equals(await store.getDevice(ctx, candidateId), undefined);
});

Deno.test("authoritative removal denies admin revocation at linearization", async () => {
  const backend = new MemoryAuthorityBackend();
  const { store, service, device: admin } = await boot(backend);
  const memberSigner = await fixtureDeviceSigner(1);
  const memberJwk = await memberSigner.publicJwk();
  const agent = (await store.getAgent(ctx, "agent_a"))!;
  const approver = (await store.getDevice(ctx, "device_a"))!;
  const target = {
    id: ids.device("device_member"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: agent.id,
    publicJwk: memberJwk,
    thumbprint: await jwkThumbprint(memberJwk),
    role: "member" as const,
    status: "active" as const,
    epoch: 1,
  };
  await store.putDevice(ctx, target);
  const tx = {
    action: "remove_device",
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    agent_id: agent.id,
    agent_epoch: agent.epoch,
    agent_jkt: agent.thumbprint,
    approver_id: approver.id,
    approver_epoch: approver.epoch,
    approver_jkt: approver.thumbprint,
    target_id: target.id,
    target_epoch: target.epoch,
    target_jkt: target.thumbprint,
  };
  const challenge = await service.removalChallenge(ctx, approver.id, target.id, now);
  const signed = await proof(admin, tx, challenge);
  class RevokingRemovalStore extends MemoryStore {
    override async commitRemoval(...args: Parameters<MemoryStore["commitRemoval"]>) {
      const current = (await this.getDevice(ctx, approver.id))!;
      await this.updateDevice(ctx, { ...current, status: "revoked", epoch: current.epoch + 1 });
      return await super.commitRemoval(...args);
    }
  }
  const racing = new DeviceEnrollmentService(new RevokingRemovalStore(backend));
  await rejects(
    () => racing.remove(ctx, approver.id, target.id, signed, now),
    "denied",
  );
  equals((await store.getDevice(ctx, target.id))!.status, "active");
});

Deno.test("authoritative bootstrap recomputes both key thumbprints and roles", async () => {
  const agent = await fixtureAgentSigner();
  const agentJwk = await agent.publicJwk();
  class SubstitutingBootstrapStore extends MemoryStore {
    override async commitBootstrap(
      context: TenantContext,
      challengeId: string,
      value: BootstrapCommit,
      at: number,
    ) {
      return await super.commitBootstrap(context, challengeId, {
        ...value,
        device: { ...value.device, publicJwk: agentJwk },
      }, at);
    }
  }
  const store = new SubstitutingBootstrapStore();
  const service = new DeviceEnrollmentService(store);
  const device = await fixtureDeviceSigner(0);
  const deviceJwk = await device.publicJwk();
  const agentId = ids.agent("agent_a"), deviceId = ids.device("device_a");
  const tx = {
    action: "bootstrap",
    principal_epoch: 1,
    agent_epoch: 1,
    device_epoch: 1,
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
  const deviceProof = await proof(device, tx, challenge);
  const agentProof = await proof(agent, tx, challenge);
  await rejects(
    () =>
      service.bootstrap(
        ctx,
        principal,
        agentId,
        agentJwk,
        deviceId,
        deviceJwk,
        deviceProof,
        agentProof,
        now,
      ),
    "denied",
  );
  equals(await store.getPrincipal(ctx, ctx.userId), undefined);
});

Deno.test("authoritative candidate commit denies agent thumbprint role collapse", async () => {
  const backend = new MemoryAuthorityBackend();
  const booted = await boot(backend);
  const agentJwk = await booted.agent.publicJwk();
  const agentThumbprint = await jwkThumbprint(agentJwk);
  class CollapsingRequestStore extends MemoryStore {
    override async commitEnrollmentRequest(
      context: TenantContext,
      challengeId: string,
      value: EnrollmentRequestCommit,
      at: number,
    ) {
      return await super.commitEnrollmentRequest(context, challengeId, {
        ...value,
        request: {
          ...value.request,
          candidateJwk: agentJwk,
          thumbprint: agentThumbprint,
        },
      }, at);
    }
  }
  const service = new DeviceEnrollmentService(new CollapsingRequestStore(backend));
  const candidate = await fixtureDeviceSigner(1), candidateJwk = await candidate.publicJwk();
  const value = {
    id: "enroll_authoritative_role",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    candidateJwk,
    expiresAt: now + 600,
  };
  const tx = {
    action: "enroll",
    principal_epoch: 1,
    agent_epoch: 1,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    request_id: value.id,
    agent_id: value.agentId,
    agent_jkt: agentThumbprint,
    candidate_jkt: await jwkThumbprint(candidateJwk),
    expires_at: value.expiresAt,
  };
  const challenge = await service.requestChallenge(ctx, value, now);
  const candidateProof = await proof(candidate, tx, challenge);
  await rejects(
    () => service.request(ctx, value, candidateProof, now),
    "denied",
  );
});
