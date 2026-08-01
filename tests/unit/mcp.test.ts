import { assert, equals, rejects } from "../assert.ts";
import {
  handleFixtureMcp,
  LegacyMcpSession,
  MCP_CURRENT,
  MCP_LEGACY,
  OUTPUT_SCHEMAS,
  TOOL_NAMES,
  TOOLS,
} from "../../apps/gateway/mcp.ts";
import { validatesSchema } from "../../apps/gateway/json_schema.ts";
import { MemoryStore } from "../../packages/core/src/store/memory_store.ts";
import { ids, type TenantContext } from "../../packages/core/src/domain/types.ts";
import {
  fixtureAgentSigner,
  fixtureCapabilityKeyring,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";
import { bodyHash, signRequestProof } from "../../packages/core/src/crypto/request_proof.ts";
import { verifyMcpAuth } from "../../apps/gateway/mcp_auth.ts";
import { runMcpContractGate } from "../../scripts/mcp_contract_gate.ts";
import { MemoryCustodyFixture } from "../../packages/core/src/custody/memory_fixture.ts";
import { MemorySafeLogger } from "../../packages/core/src/logging/safe_logger.ts";
import { InvocationService } from "../../packages/core/src/policy/invocation.ts";
import { FixtureLocalMcpBridge } from "../../packages/mcp-bridge/mod.ts";
import sdkFixture from "../fixtures/mcp-sdk-1.30.0-minimal-schema.json" with { type: "json" };

const now = 2_000_000_000;
const ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("user_a") };
const encoder = new TextEncoder();
const modern = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
  _meta: {
    protocolVersion: MCP_CURRENT,
    clientInfo: { name: "fixture", version: "1" },
    capabilities: {},
  },
});
async function environment(expiresAt = now + 600, clock = { value: now }) {
  const store = new MemoryStore();
  const device = await fixtureDeviceSigner(0), agent = await fixtureAgentSigner();
  const dj = await device.publicJwk(), aj = await agent.publicJwk();
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
    publicJwk: aj,
    thumbprint: await jwkThumbprint(aj),
    status: "active",
    epoch: 1,
  });
  await store.putDevice(ctx, {
    id: ids.device("device_a"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    publicJwk: dj,
    thumbprint: await jwkThumbprint(dj),
    role: "admin",
    status: "active",
    epoch: 1,
  });
  await store.putConnection(ctx, {
    id: ids.connection("connection_a"),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    provider: "github",
    adapter: "fixture",
    custodyRef: "ref_a",
    status: "active",
    epoch: 1,
  });
  await store.putGrant(ctx, {
    id: "grant_a",
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    agentId: ids.agent("agent_a"),
    deviceId: ids.device("device_a"),
    connectionId: ids.connection("connection_a"),
    operation: "github.user.read",
    status: "active",
    version: 1,
    expiresAt,
  });
  const custody = new MemoryCustodyFixture(encoder.encode(JSON.stringify({
    id: 1,
    login: "fixture",
    name: null,
    html_url: "https://github.com/fixture",
    avatar_url: "https://avatars.githubusercontent.com/u/1",
  })));
  const binding = {
    context: ctx,
    connectionId: "connection_a",
    connectionRef: "ref_a",
    integration: "github-cairn-v1" as const,
    redirectUri: "https://fixture.cairn.invalid/oauth/github/callback" as const,
  };
  await custody.beginAuthorization({ flowId: "flow_a", binding, now });
  await custody.completeAuthorization({
    flowId: "flow_a",
    binding,
    ...custody.fixtureCallbackMaterial(binding, "flow_a"),
    code: "fixture_authorization_code",
    now,
  });
  const service = new InvocationService(
    store,
    await fixtureCapabilityKeyring(),
    custody,
    new MemorySafeLogger(),
  );
  return {
    store,
    service,
    device,
    agent,
    bridge: new FixtureLocalMcpBridge(
      store,
      service,
      ctx,
      "grant_a",
      device,
      agent,
      "fixture.cairn.invalid",
      () => clock.value,
    ),
  };
}
async function authorized(
  body: unknown,
  path: "/mcp" | "/mcp/legacy" = "/mcp",
  expiresAt = now + 600,
  clock = { value: now },
) {
  const env = await environment(expiresAt, clock);
  const bytes = encoder.encode(JSON.stringify(body));
  return { ...env, bytes, ...(await env.bridge.authorize(bytes, now, path)) };
}
Deno.test("vendored official SDK fixture and all closed schemas are executable", () => {
  equals(sdkFixture.provenance.version, "1.30.0");
  equals(TOOLS.map((tool) => tool.name), [...TOOL_NAMES]);
  for (const tool of TOOLS) {
    for (const key of sdkFixture.tool.required) assert(key in tool);
    equals(tool.inputSchema.type, sdkFixture.tool.inputSchemaRootType);
    assert(
      validatesSchema(OUTPUT_SCHEMAS[tool.name], { outcome: "denied", category: "invalid_output" }),
    );
    assert(
      !validatesSchema(OUTPUT_SCHEMAS[tool.name], {
        outcome: { toString: () => "denied" },
        category: "invalid_output",
      }),
    );
  }
});
Deno.test("unverified auth and arbitrary fake core cannot reach MCP", async () => {
  const request = modern("search_capabilities", { query: "github" });
  const bytes = encoder.encode(JSON.stringify(request));
  const unverified = await handleFixtureMcp(bytes, MCP_CURRENT, "/mcp", {} as never, {});
  equals((unverified!.error as { code: number }).code, -32600);
  const bound = await authorized(request);
  const fake = await handleFixtureMcp(bound.bytes, MCP_CURRENT, "/mcp", bound.auth, {
    search: () => Promise.resolve({ operations: [], count: 0 }),
  });
  equals((fake!.error as { code: number }).code, -32600);
});
Deno.test("verified auth is exact-body, exact-route and one-use", async () => {
  const search = modern("search_capabilities", { query: "github" });
  const bound = await authorized(search);
  const substituted = modern("connection_status", { connection: "connection_a" });
  const substitutedBytes = encoder.encode(JSON.stringify(substituted));
  const denied = await handleFixtureMcp(
    substitutedBytes,
    MCP_CURRENT,
    "/mcp",
    bound.auth,
    bound.core,
  );
  equals((denied!.error as { code: number }).code, -32600);
  const first = await handleFixtureMcp(
    bound.bytes,
    MCP_CURRENT,
    "/mcp",
    bound.auth,
    bound.core,
  );
  assert("result" in first!); // a mismatch does not burn the exact authorization
  const replay = await handleFixtureMcp(
    bound.bytes,
    MCP_CURRENT,
    "/mcp",
    bound.auth,
    bound.core,
  );
  equals((replay!.error as { code: number }).code, -32600);
  const route = await authorized(search);
  const wrongRoute = await handleFixtureMcp(
    route.bytes,
    MCP_LEGACY,
    "/mcp/legacy",
    route.auth,
    route.core,
    new LegacyMcpSession(),
  );
  equals((wrongRoute!.error as { code: number }).code, -32600);
  const legacySearch = {
    jsonrpc: "2.0" as const,
    id: 4,
    method: "tools/call",
    params: { name: "search_capabilities", arguments: { query: "github" } },
  };
  const legacy = await authorized(legacySearch, "/mcp/legacy");
  const legacySession = new LegacyMcpSession();
  legacySession.begin();
  legacySession.complete();
  const legacySubstitution = {
    ...legacySearch,
    params: { name: "connection_status", arguments: { connection: "connection_a" } },
  };
  const legacySubstitutionBytes = encoder.encode(JSON.stringify(legacySubstitution));
  const legacyDenied = await handleFixtureMcp(
    legacySubstitutionBytes,
    MCP_LEGACY,
    "/mcp/legacy",
    legacy.auth,
    legacy.core,
    legacySession,
  );
  equals((legacyDenied!.error as { code: number }).code, -32600);
  const legacyOk = await handleFixtureMcp(
    legacy.bytes,
    MCP_LEGACY,
    "/mcp/legacy",
    legacy.auth,
    legacy.core,
    legacySession,
  );
  assert("result" in legacyOk!);
  const legacyReplay = await handleFixtureMcp(
    legacy.bytes,
    MCP_LEGACY,
    "/mcp/legacy",
    legacy.auth,
    legacy.core,
    legacySession,
  );
  equals((legacyReplay!.error as { code: number }).code, -32600);
});
Deno.test("legacy lifecycle requires initialized notification with per-request auth", async () => {
  const session = new LegacyMcpSession();
  const init = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_LEGACY,
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    },
  };
  const a = await authorized(init, "/mcp/legacy");
  const initialized = await handleFixtureMcp(
    a.bytes,
    MCP_LEGACY,
    "/mcp/legacy",
    a.auth,
    a.core,
    session,
  );
  equals((initialized!.result as { protocolVersion: string }).protocolVersion, MCP_LEGACY);
  const notice = { jsonrpc: "2.0" as const, method: "notifications/initialized" };
  const b = await authorized(notice, "/mcp/legacy");
  equals(
    await handleFixtureMcp(b.bytes, MCP_LEGACY, "/mcp/legacy", b.auth, b.core, session),
    undefined,
  );
  const list = { jsonrpc: "2.0" as const, id: 2, method: "tools/list" };
  const c = await authorized(list, "/mcp/legacy");
  const listed = await handleFixtureMcp(
    c.bytes,
    MCP_LEGACY,
    "/mcp/legacy",
    c.auth,
    c.core,
    session,
  );
  assert(Array.isArray((listed!.result as { tools: unknown[] }).tools));
});
Deno.test("every tool uses operation-time expiry and epoch snapshots", async () => {
  const requests = [
    modern("search_capabilities", { query: "github" }),
    modern("describe_operation", { operation: "github.user.read@v1" }),
    modern("connection_status", { connection: "connection_a" }),
    modern("invoke_operation", {
      operation: "github.user.read@v1",
      connection: "connection_a",
      arguments: {},
    }),
  ];
  for (const request of requests) {
    const clock = { value: now };
    const expired = await authorized(request, "/mcp", now + 1, clock);
    clock.value = now + 1;
    const denied = await handleFixtureMcp(
      expired.bytes,
      MCP_CURRENT,
      "/mcp",
      expired.auth,
      expired.core,
    );
    equals(
      (denied!.result as { structuredContent: { category: string } }).structuredContent.category,
      "policy_denied",
    );
  }
  const request = modern("search_capabilities", { query: "github" });
  const mutations = [
    async (env: Awaited<ReturnType<typeof authorized>>) => {
      const value = (await env.store.getPrincipal(ctx, ctx.userId))!;
      await env.store.updatePrincipal(ctx, { ...value, status: "revoked", epoch: 2 });
      await env.store.updatePrincipal(ctx, { ...value, status: "active", epoch: 3 });
    },
    async (env: Awaited<ReturnType<typeof authorized>>) => {
      const value = (await env.store.getAgent(ctx, "agent_a"))!;
      await env.store.updateAgent(ctx, { ...value, status: "revoked", epoch: 2 });
      await env.store.updateAgent(ctx, { ...value, status: "active", epoch: 3 });
    },
    async (env: Awaited<ReturnType<typeof authorized>>) => {
      const value = (await env.store.getDevice(ctx, "device_a"))!;
      await env.store.updateDevice(ctx, { ...value, status: "revoked", epoch: 2 });
      await env.store.updateDevice(ctx, { ...value, status: "active", epoch: 3 });
    },
    async (env: Awaited<ReturnType<typeof authorized>>) => {
      const value = (await env.store.getGrant(ctx, "grant_a"))!;
      await env.store.updateGrant(ctx, { ...value, status: "revoked", version: 2 });
      await env.store.updateGrant(ctx, { ...value, status: "active", version: 3 });
    },
    async (env: Awaited<ReturnType<typeof authorized>>) => {
      const value = (await env.store.getConnection(ctx, "connection_a"))!;
      await env.store.updateConnection(ctx, { ...value, status: "revoked", epoch: 2 });
      await env.store.updateConnection(ctx, { ...value, status: "active", epoch: 3 });
    },
  ];
  for (const mutate of mutations) {
    const stale = await authorized(request);
    await mutate(stale);
    const denied = await handleFixtureMcp(
      stale.bytes,
      MCP_CURRENT,
      "/mcp",
      stale.auth,
      stale.core,
    );
    equals(
      (denied!.result as { structuredContent: { category: string } }).structuredContent.category,
      "policy_denied",
    );
  }
});
Deno.test("modern and legacy executable bridge invoke the fixed operation", async () => {
  for (const path of ["/mcp", "/mcp/legacy"] as const) {
    const request = path === "/mcp"
      ? modern("invoke_operation", {
        operation: "github.user.read@v1",
        connection: "connection_a",
        arguments: {},
      })
      : {
        jsonrpc: "2.0" as const,
        id: 3,
        method: "tools/call",
        params: {
          name: "invoke_operation",
          arguments: {
            operation: "github.user.read@v1",
            connection: "connection_a",
            arguments: {},
          },
        },
      };
    const bound = await authorized(request, path);
    const session = path === "/mcp/legacy" ? new LegacyMcpSession() : undefined;
    if (session) {
      session.begin();
      session.complete();
    }
    const response = await handleFixtureMcp(
      bound.bytes,
      path === "/mcp" ? MCP_CURRENT : MCP_LEGACY,
      path,
      bound.auth,
      bound.core,
      session,
    );
    equals(
      (response!.result as { structuredContent: { outcome: string } }).structuredContent.outcome,
      "success",
    );
  }
});
Deno.test("MCP parses only signed received bytes and has no split body dispatch", async () => {
  for (const path of ["/mcp", "/mcp/legacy"] as const) {
    const signedSearch = path === "/mcp" ? modern("search_capabilities", { query: "github" }) : {
      jsonrpc: "2.0" as const,
      id: 12,
      method: "tools/call",
      params: { name: "search_capabilities", arguments: { query: "github" } },
    };
    const bound = await authorized(signedSearch, path);
    const forgedInvoke = path === "/mcp"
      ? modern("invoke_operation", {
        operation: "github.user.read@v1",
        connection: "connection_a",
        arguments: {},
      })
      : {
        jsonrpc: "2.0" as const,
        id: 12,
        method: "tools/call",
        params: {
          name: "invoke_operation",
          arguments: {
            operation: "github.user.read@v1",
            connection: "connection_a",
            arguments: {},
          },
        },
      };
    // Exercise the rejected old split-input calling convention. The independent
    // object is now treated as invalid raw bytes and can never drive dispatch.
    const oldSplitCall = handleFixtureMcp as unknown as (
      ...args: unknown[]
    ) => Promise<Record<string, unknown> | undefined>;
    const denied = await oldSplitCall(
      forgedInvoke,
      bound.bytes,
      path === "/mcp" ? MCP_CURRENT : MCP_LEGACY,
      path,
      bound.auth,
      bound.core,
      path === "/mcp/legacy" ? new LegacyMcpSession() : undefined,
    );
    equals((denied!.error as { code: number }).code, -32700);
  }
});
Deno.test("device and agent proof nonces are independently atomic", async () => {
  const env = await environment();
  const request = modern("search_capabilities", { query: "github" });
  const bytes = encoder.encode(JSON.stringify(request));
  const base = {
    v: 1 as const,
    method: "POST" as const,
    authority: "fixture.cairn.invalid",
    path: "/mcp" as const,
    query: "" as const,
    audience: "urn:cairn:gateway" as const,
    body_sha256: await bodyHash(bytes),
    issued_at: now,
    device_id: "device_a",
    agent_id: "agent_a",
    grant_id: "grant_a",
  };
  const deviceProof = await signRequestProof(env.device, {
    ...base,
    nonce: "shared_device_nonce_0123456789",
  });
  const proofs = await Promise.all([0, 1].map(async (index) => ({
    device: deviceProof,
    agent: await signRequestProof(env.agent, {
      ...base,
      nonce: `fresh_agent_nonce_${index}_0123456789`,
    }),
  })));
  const results = await Promise.allSettled(proofs.map((pair) =>
    verifyMcpAuth(env.store, {
      context: ctx,
      grantId: "grant_a",
      proofs: pair,
      receivedBody: bytes,
      now,
    })
  ));
  equals(results.filter((result) => result.status === "fulfilled").length, 1);
});
Deno.test("trusted policy brand has no public mint", async () => {
  const policyExports = await import("../../apps/gateway/policy_core.ts");
  const bridgeExports = await import("../../packages/mcp-bridge/mod.ts");
  assert(!("createPolicyMcpCore" in policyExports));
  assert(!("PolicyMcpCore" in policyExports));
  assert(!("createPolicyMcpCore" in bridgeExports));
  assert(!("PolicyMcpCore" in bridgeExports));
});
Deno.test("MCP contract gate consumes notification and call-result fixture fields", () => {
  runMcpContractGate(structuredClone(sdkFixture), true);
  for (
    const mutate of [
      (value: typeof sdkFixture) => value.initializedNotification.mustNotProduceResponse = false,
      (value: typeof sdkFixture) => value.callToolResult.errorFlag = "wrongErrorFlag",
      (value: typeof sdkFixture) => {
        (value.callToolResult as Record<string, unknown>).newUnconsumedConstraint = true;
      },
    ]
  ) {
    const changed = structuredClone(sdkFixture);
    mutate(changed);
    let rejected = false;
    try {
      runMcpContractGate(changed, true);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});
Deno.test("expired grant cannot authenticate", async () => {
  const request = modern("search_capabilities", { query: "github" });
  await rejects(() => authorized(request, "/mcp", now), "grant denied");
});
