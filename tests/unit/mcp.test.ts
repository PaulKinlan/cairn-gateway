import { assert, equals, rejects } from "../assert.ts";
import {
  handleFixtureMcp,
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
import { createFixtureGatewayHarness } from "../../packages/mcp-bridge/mod.ts";
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
async function environment(expiresAt = now + 600) {
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
  return { store, service, device, agent };
}
async function dispatched(
  body: unknown,
  path: "/mcp" | "/mcp/legacy" = "/mcp",
) {
  const harness = await createFixtureGatewayHarness();
  const bytes = encoder.encode(JSON.stringify(body));
  return { harness, bytes, response: await harness.dispatch(bytes, path) };
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
  const fake = await handleFixtureMcp(bytes, MCP_CURRENT, "/mcp", {} as never, {
    search: () => Promise.resolve({ operations: [], count: 0 }),
  });
  equals((fake!.error as { code: number }).code, -32600);
});
Deno.test("public dispatch keeps exact-body authorization and core behind one operation", async () => {
  const search = await dispatched(modern("search_capabilities", { query: "github" }));
  assert("result" in search.response!);
  assert(!("auth" in search.response!));
  assert(!("core" in search.response!));
  const malformedDispatch = search.harness.dispatch as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const denied = await malformedDispatch({ forged: true }, search.bytes, MCP_CURRENT, "/mcp");
  equals(denied, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "parse denied" },
  });
  assert(!("result" in (denied as Record<string, unknown>)));
});
Deno.test("legacy lifecycle requires initialized notification with internal per-request auth", async () => {
  const harness = await createFixtureGatewayHarness();
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
  const initialized = await harness.dispatch(encoder.encode(JSON.stringify(init)), "/mcp/legacy");
  equals((initialized!.result as { protocolVersion: string }).protocolVersion, MCP_LEGACY);
  const notice = { jsonrpc: "2.0" as const, method: "notifications/initialized" };
  equals(
    await harness.dispatch(encoder.encode(JSON.stringify(notice)), "/mcp/legacy"),
    undefined,
  );
  const list = { jsonrpc: "2.0" as const, id: 2, method: "tools/list" };
  const listed = await harness.dispatch(encoder.encode(JSON.stringify(list)), "/mcp/legacy");
  assert(Array.isArray((listed!.result as { tools: unknown[] }).tools));
});
Deno.test("every tool rejects revoked state and Date.now cannot bypass real expiry", async () => {
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
  const expiring = [];
  for (const request of requests) {
    const harness = await createFixtureGatewayHarness();
    await harness.setGrantLifetime(1);
    expiring.push({ harness, bytes: encoder.encode(JSON.stringify(request)) });
  }
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const originalDateNow = Date.now;
  Date.now = () => 0;
  try {
    for (const expired of expiring) {
      await rejects(() => expired.harness.dispatch(expired.bytes), "grant denied");
    }
  } finally {
    Date.now = originalDateNow;
  }
  const bytes = encoder.encode(JSON.stringify(requests[0]));
  for (const subject of ["principal", "agent", "device", "grant", "connection"] as const) {
    const harness = await createFixtureGatewayHarness();
    await harness.revoke(subject);
    await rejects(() => harness.dispatch(bytes));
  }
});
Deno.test("modern and legacy executable bridge invoke the fixed operation", async () => {
  for (const path of ["/mcp", "/mcp/legacy"] as const) {
    const harness = await createFixtureGatewayHarness();
    if (path === "/mcp/legacy") {
      const init = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_LEGACY,
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      };
      await harness.dispatch(encoder.encode(JSON.stringify(init)), path);
      await harness.dispatch(
        encoder.encode(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
        path,
      );
    }
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
    const response = await harness.dispatch(encoder.encode(JSON.stringify(request)), path);
    equals(
      (response!.result as { structuredContent: { outcome: string } }).structuredContent.outcome,
      "success",
    );
  }
});
Deno.test("MCP public dispatch has no split body or direct core calling convention", async () => {
  const harness = await createFixtureGatewayHarness();
  const signedSearch = modern("search_capabilities", { query: "github" });
  const bytes = encoder.encode(JSON.stringify(signedSearch));
  const oldSplitCall = harness.dispatch as unknown as (
    ...args: unknown[]
  ) => Promise<Record<string, unknown> | undefined>;
  const denied = await oldSplitCall(signedSearch, bytes, MCP_CURRENT, "/mcp");
  equals(denied, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "parse denied" },
  });
  assert(!("result" in denied!));
  assert(!("authorize" in harness));
  assert(!("core" in harness));
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
  assert(!("FixtureLocalMcpBridge" in bridgeExports));
  assert(!("BoundFixtureBridge" in bridgeExports));
});
Deno.test("frozen closure facade defeats reflection, recovered constructors, and stale rollback", async () => {
  equals(createFixtureGatewayHarness.length, 0);
  const expectedKeys = [
    "dispatch",
    "revoke",
    "revokeAndReactivate",
    "setGrantLifetime",
    "status",
  ];
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
    const harness = await createFixtureGatewayHarness();
    equals(Reflect.ownKeys(harness), expectedKeys);
    equals(Reflect.getPrototypeOf(harness), null);
    assert(Object.isFrozen(harness));
    const reflected = harness as unknown as Record<PropertyKey, unknown>;
    for (
      const forbidden of [
        "store",
        "backend",
        "bridge",
        "context",
        "core",
        "mint",
        "authority",
        "constructor",
        "authorize",
      ]
    ) equals(reflected[forbidden], undefined);
    for (const key of expectedKeys) {
      const capability = reflected[key] as object;
      equals(Reflect.getPrototypeOf(capability), null);
      assert(Object.isFrozen(capability));
      equals((capability as { constructor?: unknown }).constructor, undefined);
    }
    assert(!Reflect.set(reflected, "store", new MemoryStore()));
    await harness.revoke("grant");
    const bytes = encoder.encode(JSON.stringify(request));
    await rejects(() => harness.dispatch(bytes), "grant denied");
  }
});

Deno.test("public dispatch returns no replayable authorization or policy core", async () => {
  const request = modern("search_capabilities", { query: "github" });
  const harness = await createFixtureGatewayHarness();
  const response = await harness.dispatch(encoder.encode(JSON.stringify(request)));
  assert("result" in response!);
  const publicResult = response as Record<string, unknown>;
  equals(publicResult.auth, undefined);
  equals(publicResult.core, undefined);
  equals((harness as unknown as Record<string, unknown>).authorize, undefined);
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
Deno.test("revoked grant cannot authenticate", async () => {
  const request = modern("search_capabilities", { query: "github" });
  const harness = await createFixtureGatewayHarness();
  await harness.revoke("grant");
  const bytes = encoder.encode(JSON.stringify(request));
  await rejects(() => harness.dispatch(bytes), "grant denied");
});
