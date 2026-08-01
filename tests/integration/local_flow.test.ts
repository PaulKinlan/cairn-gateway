import { assert, equals, rejects } from "../assert.ts";
import { MemoryStore } from "../../packages/core/src/store/memory_store.ts";
import {
  type Connection,
  type Device,
  type Grant,
  ids,
  type TenantContext,
} from "../../packages/core/src/domain/types.ts";
import {
  fixtureCapabilityKeyring,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";
import { MemoryCustodyFixture } from "../../packages/core/src/custody/memory_fixture.ts";
import { MemorySafeLogger } from "../../packages/core/src/logging/safe_logger.ts";
import { InvocationService } from "../../packages/core/src/policy/invocation.ts";
import {
  bodyHash,
  type RequestProofPayload,
  signRequestProof,
} from "../../packages/core/src/crypto/request_proof.ts";
import { sha256 } from "../../packages/core/src/crypto/encoding.ts";
const now = 2_000_000_000;
const ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("user_a") };
const githubBody = new TextEncoder().encode(JSON.stringify({
  id: 123456,
  login: "fixture-user",
  name: "Fixture User",
  html_url: "https://github.com/fixture-user",
  avatar_url: "https://avatars.githubusercontent.com/u/123456?v=4",
  private_provider_field: "MUST_NOT_PROJECT",
  access_token: "PROVIDER_TOKEN_SENTINEL",
}));
async function setup() {
  const store = new MemoryStore();
  const custody = new MemoryCustodyFixture(githubBody);
  const logger = new MemorySafeLogger();
  await custody.beginAuthorization({ flowId: "flow_a", connectionRef: "custody_ref_a", now });
  await custody.completeAuthorization({
    flowId: "flow_a",
    state: "fixture_state_012345678901234567890123",
    code: "fixture_authorization_code",
    verifier: "fixture-verifier-012345678901234567890123456789012345678901234567",
    now,
  });
  const connection: Connection = {
    id: ids.connection("connection_a"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    provider: "github",
    adapter: "fixture",
    custodyRef: "custody_ref_a",
    status: "active",
    epoch: 1,
  };
  await store.putConnection(ctx, connection);
  const signers = [await fixtureDeviceSigner(0), await fixtureDeviceSigner(1)];
  for (let i = 0; i < 2; i++) {
    const signer = signers[i]!;
    const jwk = await signer.publicJwk();
    const id = ids.device(`device_${i}`);
    const device: Device = {
      id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentId: ids.agent("agent_a"),
      publicJwk: jwk,
      thumbprint: await jwkThumbprint(jwk),
      role: i === 0 ? "admin" : "member",
      status: "active",
      epoch: 1,
    };
    const grant: Grant = {
      id: `grant_${i}`,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      agentId: ids.agent("agent_a"),
      deviceId: id,
      connectionId: connection.id,
      operation: "github.user.read",
      status: "active",
      version: 1,
      expiresAt: now + 1000,
    };
    await store.putDevice(ctx, device);
    await store.putGrant(ctx, grant);
  }
  return {
    store,
    custody,
    logger,
    service: new InvocationService(store, await fixtureCapabilityKeyring(), custody, logger),
    signers,
  };
}
async function issue(
  service: InvocationService,
  signer: Awaited<ReturnType<typeof fixtureDeviceSigner>>,
  index: number,
  nonce: string,
) {
  const payload: RequestProofPayload = {
    v: 1,
    method: "POST",
    authority: "fixture.cairn.invalid",
    path: "/internal/capabilities",
    query: "",
    audience: "urn:cairn:gateway",
    body_sha256: await bodyHash(new TextEncoder().encode(`grant_${index}`)),
    issued_at: now,
    nonce,
    device_id: `device_${index}`,
    grant_id: `grant_${index}`,
  };
  return await service.issue(
    ctx,
    `grant_${index}`,
    await signRequestProof({ ...signer, deviceId: `device_${index}` }, payload),
    now,
  );
}
async function invoke(
  service: InvocationService,
  signer: Awaited<ReturnType<typeof fixtureDeviceSigner>>,
  index: number,
  capability: string,
  nonce: string,
) {
  const payload: RequestProofPayload = {
    v: 1,
    method: "POST",
    authority: "fixture.cairn.invalid",
    path: "/mcp",
    query: "",
    audience: "urn:cairn:gateway",
    body_sha256: await bodyHash(new TextEncoder().encode("{}")),
    issued_at: now,
    nonce,
    device_id: `device_${index}`,
    grant_id: `grant_${index}`,
    capability_sha256: await sha256(capability),
  };
  return await service.invoke(
    ctx,
    capability,
    await signRequestProof({ ...signer, deviceId: `device_${index}` }, payload),
    {},
    now,
    `correlation_${index}`,
  );
}
Deno.test("both distinct devices reuse one connection with bounded projection", async () => {
  const { service, signers } = await setup();
  for (let i = 0; i < 2; i++) {
    const capability = await issue(service, signers[i]!, i, `issue_nonce_${i}_0123456789012`);
    const output = await invoke(
      service,
      signers[i]!,
      i,
      capability,
      `invoke_nonce_${i}_012345678901`,
    );
    assert(output.result.outcome === "success");
    equals(output.result.user.login, "fixture-user");
    assert(!JSON.stringify(output).includes("PROVIDER_TOKEN_SENTINEL"));
    assert(!JSON.stringify(output).includes("MUST_NOT_PROJECT"));
  }
});
Deno.test("one device cannot use the other device capability", async () => {
  const { service, signers } = await setup();
  const capability = await issue(service, signers[0]!, 0, "issue_nonce_cross_01234567890");
  await rejects(
    () => invoke(service, signers[1]!, 1, capability, "invoke_nonce_cross_0123456789"),
    "proof",
  );
});
Deno.test("concurrent capability replay dispatches at most once", async () => {
  const { service, signers } = await setup();
  const capability = await issue(service, signers[0]!, 0, "issue_nonce_race_012345678901");
  const results = await Promise.allSettled(
    Array.from({ length: 32 }, (_, i) =>
      invoke(
        service,
        signers[0]!,
        0,
        capability,
        `invoke_nonce_race_${String(i).padStart(3, "0")}_0123456789`,
      )),
  );
  equals(results.filter((item) => item.status === "fulfilled").length, 1);
});
Deno.test("already issued capability is denied after device removal", async () => {
  const { service, signers, store } = await setup();
  const capability = await issue(service, signers[0]!, 0, "issue_nonce_remove_0123456789");
  const device = await store.getDevice(ctx, "device_0");
  assert(device);
  await store.updateDevice(ctx, { ...device, status: "revoked", epoch: 2 });
  await rejects(
    () => invoke(service, signers[0]!, 0, capability, "invoke_nonce_remove_012345678"),
    "device",
  );
});
Deno.test("fixture OAuth state and PKCE are one-time and fail closed", async () => {
  const fixture = new MemoryCustodyFixture(githubBody);
  await fixture.beginAuthorization({ flowId: "flow_b", connectionRef: "ref_b", now });
  await rejects(
    () =>
      fixture.completeAuthorization({
        flowId: "flow_b",
        state: "wrong_state_012345678901234567890",
        code: "fixture_authorization_code",
        verifier: "fixture-verifier-012345678901234567890123456789012345678901234567",
        now,
      }),
    "denied",
  );
  await fixture.completeAuthorization({
    flowId: "flow_b",
    state: "fixture_state_012345678901234567890123",
    code: "fixture_authorization_code",
    verifier: "fixture-verifier-012345678901234567890123456789012345678901234567",
    now,
  });
  await rejects(
    () =>
      fixture.completeAuthorization({
        flowId: "flow_b",
        state: "fixture_state_012345678901234567890123",
        code: "fixture_authorization_code",
        verifier: "fixture-verifier-012345678901234567890123456789012345678901234567",
        now,
      }),
    "denied",
  );
});
Deno.test("denials emit metadata-only receipts without capability material", async () => {
  const { service, signers, logger } = await setup();
  const capability = await issue(service, signers[0]!, 0, "issue_nonce_deny_012345678901");
  await rejects(
    () => invoke(service, signers[1]!, 1, capability, "invoke_nonce_deny_01234567890"),
    "proof",
  );
  const serialized = JSON.stringify(logger.events);
  assert(serialized.includes('"decision":"deny"'));
  assert(!serialized.includes(capability));
  assert(!serialized.includes("custody_ref_a"));
});
Deno.test("issuance request nonce is globally replay protected", async () => {
  const { service, signers } = await setup();
  const nonce = "issue_nonce_repeat_01234567890";
  await issue(service, signers[0]!, 0, nonce);
  await rejects(() => issue(service, signers[0]!, 0, nonce), "nonce replay");
});
