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
  fixtureCapabilityKeyring,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";
import { MemoryCustodyFixture } from "../../packages/core/src/custody/memory_fixture.ts";
import type {
  CustodyAdapter,
  CustodyBinding,
} from "../../packages/core/src/custody/custody_adapter.ts";
import { MemorySafeLogger } from "../../packages/core/src/logging/safe_logger.ts";
import { InvocationService } from "../../packages/core/src/policy/invocation.ts";
import {
  bodyHash,
  type RequestProofPayload,
  signRequestProof,
} from "../../packages/core/src/crypto/request_proof.ts";
import { encoder, sha256 } from "../../packages/core/src/crypto/encoding.ts";
import { handleFixtureMcp, MCP_CURRENT } from "../../apps/gateway/mcp.ts";
import { FixtureLocalMcpBridge } from "../../apps/gateway/local_bridge.ts";
const now = 2_000_000_000,
  ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("user_a") };
const githubBody = encoder.encode(JSON.stringify({
  id: 123456,
  login: "fixture-user",
  name: "Fixture User",
  html_url: "https://github.com/fixture-user",
  avatar_url: "https://avatars.githubusercontent.com/u/123456?v=4",
  private_provider_field: "MUST_NOT_PROJECT",
  access_token: "PROVIDER_TOKEN_SENTINEL",
}));
const binding = (connectionRef = "custody_ref_a"): CustodyBinding => ({
  context: ctx,
  connectionId: "connection_a",
  connectionRef,
  integration: "github-cairn-v1",
  redirectUri: "https://fixture.cairn.invalid/oauth/github/callback",
});
async function setup(backend = new MemoryAuthorityBackend(), adapter?: CustodyAdapter) {
  const store = new MemoryStore(backend),
    custody = adapter ?? new MemoryCustodyFixture(githubBody),
    logger = new MemorySafeLogger(),
    agentSigner = await fixtureAgentSigner(),
    agentJwk = await agentSigner.publicJwk();
  if (custody instanceof MemoryCustodyFixture) {
    await custody.beginAuthorization({ flowId: "flow_a", binding: binding(), now });
    const material = custody.fixtureCallbackMaterial(binding(), "flow_a");
    await custody.completeAuthorization({
      flowId: "flow_a",
      binding: binding(),
      ...material,
      code: "fixture_authorization_code",
      now,
    });
  }
  await store.putPrincipal(ctx, {
    id: ctx.userId,
    tenantId: ctx.tenantId,
    kind: "cryptographic",
    status: "active",
    emailRequired: false,
    epoch: 1,
  });
  await store.putAgent(ctx, {
    id: ids.agent("agent_a"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    publicJwk: agentJwk,
    thumbprint: await jwkThumbprint(agentJwk),
    status: "active",
    epoch: 1,
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
    const jwk = await signers[i]!.publicJwk(),
      id = ids.device(`device_${i}`),
      device: Device = {
        id,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        agentId: ids.agent("agent_a"),
        publicJwk: jwk,
        thumbprint: await jwkThumbprint(jwk),
        role: i ? "member" : "admin",
        status: "active",
        epoch: 1,
      },
      grant: Grant = {
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
    agentSigner,
  };
}
async function dualProof(
  device: Awaited<ReturnType<typeof fixtureDeviceSigner>>,
  agent: Awaited<ReturnType<typeof fixtureAgentSigner>>,
  payload: RequestProofPayload,
) {
  return {
    device: await signRequestProof({ ...device, deviceId: payload.device_id }, {
      ...payload,
      nonce: `${payload.nonce}_device`,
    }),
    agent: await signRequestProof({ ...agent, deviceId: payload.agent_id }, {
      ...payload,
      nonce: `${payload.nonce}_agent00`,
    }),
  };
}
async function issue(
  env: Awaited<ReturnType<typeof setup>>,
  index: number,
  nonce: string,
  receivedBody?: Uint8Array,
) {
  const bytes = receivedBody ?? encoder.encode(JSON.stringify({ grant_id: `grant_${index}` }));
  const payload: RequestProofPayload = {
    v: 1,
    method: "POST",
    authority: "fixture.cairn.invalid",
    path: "/internal/capabilities",
    query: "",
    audience: "urn:cairn:gateway",
    body_sha256: await bodyHash(bytes),
    issued_at: now,
    nonce,
    device_id: `device_${index}`,
    agent_id: "agent_a",
    grant_id: `grant_${index}`,
  };
  return await env.service.issue(
    ctx,
    `grant_${index}`,
    await dualProof(env.signers[index]!, env.agentSigner, payload),
    bytes,
    now,
  );
}
async function invoke(
  env: Awaited<ReturnType<typeof setup>>,
  index: number,
  capability: string,
  nonce: string,
  receivedBody = encoder.encode("{}"),
) {
  const payload: RequestProofPayload = {
    v: 1,
    method: "POST",
    authority: "fixture.cairn.invalid",
    path: "/mcp",
    query: "",
    audience: "urn:cairn:gateway",
    body_sha256: await bodyHash(receivedBody),
    issued_at: now,
    nonce,
    device_id: `device_${index}`,
    agent_id: "agent_a",
    grant_id: `grant_${index}`,
    capability_sha256: await sha256(capability),
  };
  return await env.service.invoke(
    ctx,
    capability,
    await dualProof(env.signers[index]!, env.agentSigner, payload),
    {},
    receivedBody,
    now,
    `correlation_${index}`,
  );
}
Deno.test("two devices use one owner-bound connection with bounded projection", async () => {
  const env = await setup();
  for (let i = 0; i < 2; i++) {
    const output = await invoke(
      env,
      i,
      await issue(env, i, `issue_${i}_012345678901234`),
      `invoke_${i}_01234567890123`,
    );
    assert(output.result.outcome === "success");
    assert(!JSON.stringify(output).includes("SENTINEL"));
    assert(!output.result.user.avatar_url.includes("?"));
  }
});
Deno.test("received body bytes, device proof and agent proof are independently bound", async () => {
  const env = await setup(),
    body = encoder.encode('{"grant_id":"grant_0"}'),
    capability = await issue(env, 0, "issue_body_012345678901", body);
  const signedBody = encoder.encode("{}"),
    payload: RequestProofPayload = {
      v: 1,
      method: "POST",
      authority: "fixture.cairn.invalid",
      path: "/mcp",
      query: "",
      audience: "urn:cairn:gateway",
      body_sha256: await bodyHash(signedBody),
      issued_at: now,
      nonce: "invoke_body_01234567890",
      device_id: "device_0",
      agent_id: "agent_a",
      grant_id: "grant_0",
      capability_sha256: await sha256(capability),
    },
    proofs = await dualProof(env.signers[0]!, env.agentSigner, payload);
  await rejects(
    () =>
      env.service.invoke(
        ctx,
        capability,
        proofs,
        {},
        encoder.encode('{"altered":true}'),
        now,
        "body_mismatch",
      ),
    "proof",
  );
  const wrongAgent = await fixtureDeviceSigner(1);
  const wrongAgentProof = (await dualProof(env.signers[0]!, wrongAgent, payload)).agent;
  await rejects(
    () =>
      env.service.invoke(
        ctx,
        capability,
        {
          ...proofs,
          agent: wrongAgentProof,
        },
        {},
        signedBody,
        now,
        "agent_mismatch",
      ),
    "agent proof",
  );
});
Deno.test("same capability and proof dispatched through shared service instances once", async () => {
  const backend = new MemoryAuthorityBackend(),
    env = await setup(backend),
    other = {
      ...env,
      store: new MemoryStore(backend),
      service: new InvocationService(
        new MemoryStore(backend),
        await fixtureCapabilityKeyring(),
        env.custody,
        env.logger,
      ),
    },
    capability = await issue(env, 0, "issue_cross_012345678901"),
    body = encoder.encode("{}"),
    payload: RequestProofPayload = {
      v: 1,
      method: "POST",
      authority: "fixture.cairn.invalid",
      path: "/mcp",
      query: "",
      audience: "urn:cairn:gateway",
      body_sha256: await bodyHash(body),
      issued_at: now,
      nonce: "invoke_cross_01234567890",
      device_id: "device_0",
      agent_id: "agent_a",
      grant_id: "grant_0",
      capability_sha256: await sha256(capability),
    },
    proofs = await dualProof(env.signers[0]!, env.agentSigner, payload),
    results = await Promise.allSettled([
      env.service.invoke(ctx, capability, proofs, {}, body, now, "cross_a"),
      other.service.invoke(ctx, capability, proofs, {}, body, now, "cross_b"),
    ]);
  equals(results.filter((x) => x.status === "fulfilled").length, 1);
});
Deno.test("principal and agent revocation deny issued capability at call time", async () => {
  for (const kind of ["principal", "agent"] as const) {
    const env = await setup(), capability = await issue(env, 0, `issue_revoke_${kind}_012345`);
    if (kind === "principal") {
      await env.store.updatePrincipal(ctx, {
        ...(await env.store.getPrincipal(ctx, ctx.userId))!,
        status: "revoked",
        epoch: 2,
      });
    } else {await env.store.updateAgent(ctx, {
        ...(await env.store.getAgent(ctx, "agent_a"))!,
        status: "revoked",
        epoch: 2,
      });}
    await rejects(() => invoke(env, 0, capability, `invoke_revoke_${kind}_01234`), kind);
  }
});
Deno.test("callback state PKCE and binding cannot complete another flow", async () => {
  const fixture = new MemoryCustodyFixture(githubBody),
    a = binding("ref_a"),
    b = { ...binding("ref_b"), connectionId: "connection_b" };
  await fixture.beginAuthorization({ flowId: "flow_a", binding: a, now });
  await fixture.beginAuthorization({ flowId: "flow_b", binding: b, now });
  const material = fixture.fixtureCallbackMaterial(a, "flow_a");
  await rejects(
    () =>
      fixture.completeAuthorization({
        flowId: "flow_b",
        binding: b,
        ...material,
        code: "fixture_authorization_code",
        now,
      }),
    "denied",
  );
  await fixture.completeAuthorization({
    flowId: "flow_a",
    binding: a,
    ...material,
    code: "fixture_authorization_code",
    now,
  });
  await rejects(
    () =>
      fixture.completeAuthorization({
        flowId: "flow_a",
        binding: a,
        ...material,
        code: "fixture_authorization_code",
        now,
      }),
    "denied",
  );
});
Deno.test("callback flow IDs and fixture material are owner-composite", async () => {
  const fixture = new MemoryCustodyFixture(githubBody),
    a = binding("owner_a_ref"),
    b: CustodyBinding = {
      ...binding("owner_b_ref"),
      context: { tenantId: ids.tenant("tenant_b"), userId: ids.user("user_b") },
      connectionId: "connection_b",
    };
  await fixture.beginAuthorization({ flowId: "same_flow", binding: a, now });
  await fixture.beginAuthorization({ flowId: "same_flow", binding: b, now });
  const materialA = fixture.fixtureCallbackMaterial(a, "same_flow"),
    materialB = fixture.fixtureCallbackMaterial(b, "same_flow");
  assert(materialA.state !== materialB.state);
  await rejects(
    () =>
      fixture.completeAuthorization({
        flowId: "same_flow",
        binding: b,
        ...materialA,
        code: "fixture_authorization_code",
        now,
      }),
    "denied",
  );
  await fixture.completeAuthorization({
    flowId: "same_flow",
    binding: b,
    ...materialB,
    code: "fixture_authorization_code",
    now,
  });
});
Deno.test("actual MCP boundary authenticates and executes typed policy flow", async () => {
  const env = await setup();
  const request = {
    jsonrpc: "2.0" as const,
    id: 7,
    method: "tools/call",
    params: {
      name: "invoke_operation",
      arguments: { operation: "github.user.read@v1", connection: "connection_a", arguments: {} },
    },
    _meta: {
      protocolVersion: MCP_CURRENT,
      clientInfo: { name: "fixture", version: "1" },
      capabilities: {},
    },
  };
  const bytes = encoder.encode(JSON.stringify(request));
  const bridge = new FixtureLocalMcpBridge(
    env.store,
    env.service,
    ctx,
    "grant_0",
    env.signers[0]!,
    env.agentSigner,
    "fixture.cairn.invalid",
    () => now,
  );
  const { auth, core } = await bridge.authorize(bytes, now);
  const response = await handleFixtureMcp(bytes, MCP_CURRENT, "/mcp", auth, core),
    structured = (response!.result as { structuredContent: { outcome: string } }).structuredContent;
  equals(structured.outcome, "success");
  assert(!JSON.stringify(response).includes("custody_ref"));
});
Deno.test("MCP stale discovery is denied at call time after revocation", async () => {
  const env = await setup();
  const request = {
    jsonrpc: "2.0" as const,
    id: 8,
    method: "tools/call",
    params: {
      name: "invoke_operation",
      arguments: { operation: "github.user.read@v1", connection: "connection_a", arguments: {} },
    },
    _meta: {
      protocolVersion: MCP_CURRENT,
      clientInfo: { name: "fixture", version: "1" },
      capabilities: {},
    },
  };
  const bytes = encoder.encode(JSON.stringify(request));
  const bridge = new FixtureLocalMcpBridge(
    env.store,
    env.service,
    ctx,
    "grant_0",
    env.signers[0]!,
    env.agentSigner,
    "fixture.cairn.invalid",
    () => now,
  );
  const { auth, core } = await bridge.authorize(bytes, now);
  const connection = (await env.store.getConnection(ctx, "connection_a"))!;
  await env.store.updateConnection(ctx, { ...connection, status: "revoked", epoch: 2 });
  const response = await handleFixtureMcp(bytes, MCP_CURRENT, "/mcp", auth, core);
  equals((response!.result as { isError: boolean }).isError, true);
  equals(
    (response!.result as { structuredContent: { category: string } }).structuredContent.category,
    "policy_denied",
  );
});
Deno.test("fixture bridge acquires capability, dual-signs and binds exact authenticated core", async () => {
  const env = await setup();
  const request = {
    jsonrpc: "2.0" as const,
    id: 9,
    method: "tools/call",
    params: {
      name: "connection_status",
      arguments: { connection: "connection_a" },
    },
    _meta: {
      protocolVersion: MCP_CURRENT,
      clientInfo: { name: "fixture-bridge", version: "1" },
      capabilities: {},
    },
  };
  const bytes = encoder.encode(JSON.stringify(request));
  const bridge = new FixtureLocalMcpBridge(
    env.store,
    env.service,
    ctx,
    "grant_0",
    env.signers[0]!,
    env.agentSigner,
    "fixture.cairn.invalid",
    () => now,
  );
  const { auth, core } = await bridge.authorize(bytes, now);
  const response = await handleFixtureMcp(bytes, MCP_CURRENT, "/mcp", auth, core);
  equals(
    (response!.result as { structuredContent: { status: string } }).structuredContent.status,
    "active",
  );
  assert(!("capability" in (bridge as unknown as Record<string, unknown>)));
});
Deno.test("malformed custody values map closed with exactly one sanitized error receipt", async () => {
  const variants: Array<() => unknown> = [
    () => null,
    () => ({ outcome: "PROVIDER_SECRET_SENTINEL" }),
    () => ({
      outcome: "success",
      status: "200",
      contentType: "application/json",
      body: githubBody,
    }),
    () => ({ outcome: "auth_required" }),
    () => ({ outcome: "rate_limited", status: 429, contentType: "application/json" }),
    () => ({
      outcome: "provider_denied",
      status: 200,
      contentType: "application/json",
      body: new Uint8Array(),
    }),
    () => ({
      outcome: "provider_unavailable",
      status: 503,
      contentType: 7,
      body: new Uint8Array(),
    }),
    () =>
      Object.defineProperties({}, {
        outcome: { value: "rate_limited", enumerable: true },
        status: {
          get: () => {
            throw new Error("PROVIDER_SECRET_SENTINEL");
          },
          enumerable: true,
        },
        contentType: { value: "application/json", enumerable: true },
        body: { value: new Uint8Array(), enumerable: true },
      }),
    () =>
      Object.defineProperty({}, "outcome", {
        get: () => {
          throw new Error("PROVIDER_SECRET_SENTINEL");
        },
      }),
  ];
  for (const make of variants) {
    const hostile: CustodyAdapter = {
      beginAuthorization: () =>
        Promise.resolve({ handle: "x", callbackOwnership: "gateway", expiresAt: now + 1 }),
      completeAuthorization: () => Promise.resolve({ status: "active" }),
      connectionStatus: () => Promise.resolve({ status: "active" }),
      proxyOperation: () => Promise.resolve(make() as never),
      revokeConnection: () => Promise.resolve({ status: "revoked" }),
    };
    const env = await setup(undefined, hostile);
    const output = await invoke(
      env,
      0,
      await issue(env, 0, `issue_hostile_${crypto.randomUUID().replaceAll("-", "")}`),
      `invoke_hostile_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    equals(output.result.outcome, "provider_unavailable");
    equals(env.logger.events.length, 1);
    assert(!JSON.stringify(env.logger.events).includes("SENTINEL"));
  }
});
Deno.test("malformed detached signatures emit exactly one sanitized deny receipt", async () => {
  const env = await setup(),
    capability = await issue(env, 0, "issue_malformed_012345678"),
    body = encoder.encode("{}"),
    payload: RequestProofPayload = {
      v: 1,
      method: "POST",
      authority: "fixture.cairn.invalid",
      path: "/mcp",
      query: "",
      audience: "urn:cairn:gateway",
      body_sha256: await bodyHash(body),
      issued_at: now,
      nonce: "invoke_malformed_0123456",
      device_id: "device_0",
      agent_id: "agent_a",
      grant_id: "grant_0",
      capability_sha256: await sha256(capability),
    },
    proofs = await dualProof(env.signers[0]!, env.agentSigner, payload);
  await rejects(
    () =>
      env.service.invoke(
        ctx,
        capability,
        { ...proofs, device: { ...proofs.device, signature: "!" } },
        {},
        body,
        now,
        "malformed_proof",
      ),
    "device proof denied",
  );
  equals(env.logger.events.length, 1);
  assert(!JSON.stringify(env.logger.events).includes("invalid base64"));
});
Deno.test("provider exception maps closed and emits metadata-only error receipt", async () => {
  const throwing: CustodyAdapter = {
    beginAuthorization: () =>
      Promise.resolve({ handle: "unused", callbackOwnership: "gateway", expiresAt: now + 1 }),
    completeAuthorization: () => Promise.resolve({ status: "active" }),
    connectionStatus: () => Promise.resolve({ status: "active" }),
    proxyOperation: () => {
      throw new Error("PROVIDER_SECRET_SENTINEL");
    },
    revokeConnection: () => Promise.resolve({ status: "revoked" }),
  };
  const env = await setup(undefined, throwing),
    output = await invoke(
      env,
      0,
      await issue(env, 0, "issue_error_012345678901"),
      "invoke_error_01234567890",
    );
  equals(output.result.outcome, "provider_unavailable");
  equals(output.receipt.decision, "error");
  assert(!JSON.stringify(env.logger.events).includes("SENTINEL"));
});
