import { assert, equals, rejects } from "../assert.ts";
import {
  handleFixtureMcp,
  LegacyMcpSession,
  MCP_CURRENT,
  MCP_LEGACY,
  type McpCore,
  TOOL_NAMES,
  TOOLS,
} from "../../apps/gateway/mcp.ts";
import { verifyMcpAuth } from "../../apps/gateway/mcp_auth.ts";
import { MemoryStore } from "../../packages/core/src/store/memory_store.ts";
import { ids, type TenantContext } from "../../packages/core/src/domain/types.ts";
import {
  fixtureAgentSigner,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";
import {
  bodyHash,
  type RequestProofPayload,
  signRequestProof,
} from "../../packages/core/src/crypto/request_proof.ts";
import sdkFixture from "../fixtures/mcp-sdk-1.30.0-minimal-schema.json" with { type: "json" };
const now = 2_000_000_000,
  ctx: TenantContext = { tenantId: ids.tenant("tenant_a"), userId: ids.user("user_a") };
const core: McpCore = {
  accepts: () => true,
  search: () =>
    Promise.resolve({
      operations: [{ id: "github.user.read@v1", connection: "connection_a" }],
      count: 1,
    }),
  describe: () =>
    Promise.resolve({
      id: "github.user.read@v1",
      provider: "github",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      requestUnits: 1,
    }),
  invoke: () =>
    Promise.resolve({
      outcome: "provider_unavailable",
      receipt: { decision: "error", reason: "provider_failure", requestUnits: 1 },
    }),
  status: () =>
    Promise.resolve({
      connection: "connection_a",
      status: "active",
      operation: "github.user.read@v1",
    }),
};
async function auth(
  body: Uint8Array,
  path: "/mcp" | "/mcp/legacy" = "/mcp",
  expiresAt = now + 600,
) {
  const store = new MemoryStore(),
    device = await fixtureDeviceSigner(0),
    agent = await fixtureAgentSigner(),
    dj = await device.publicJwk(),
    aj = await agent.publicJwk();
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
  const base: RequestProofPayload = {
    v: 1,
    method: "POST",
    authority: "fixture.cairn.invalid",
    path,
    query: "",
    audience: "urn:cairn:gateway",
    body_sha256: await bodyHash(body),
    issued_at: now,
    nonce: "mcp_auth_nonce_01234567890",
    device_id: "device_a",
    agent_id: "agent_a",
    grant_id: "grant_a",
  };
  return await verifyMcpAuth(store, {
    context: ctx,
    grantId: "grant_a",
    proofs: {
      device: await signRequestProof(device, { ...base, nonce: `${base.nonce}_device` }),
      agent: await signRequestProof(agent, { ...base, nonce: `${base.nonce}_agent00` }),
    },
    receivedBody: body,
    now,
    path,
  });
}
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
Deno.test("vendored minimal SDK 1.30 legacy schema fixture validates tool contracts", () => {
  equals(sdkFixture.provenance.version, "1.30.0");
  equals(
    sdkFixture.provenance.esmTypesSha256,
    "962836b0f8dad85bcd398ad3ddb5ba81a7c7530c706955aa846dd8dfc02dd6a9",
  );
  for (const tool of TOOLS) {
    for (const key of sdkFixture.tool.required) assert(key in tool);
    equals(tool.inputSchema.type, sdkFixture.tool.inputSchemaRootType);
  }
});
Deno.test("all four tools have exact object input schemas", () => {
  equals(TOOLS.map((x) => x.name), [...TOOL_NAMES]);
  for (const tool of TOOLS) {
    equals(tool.inputSchema.type, "object");
    equals(tool.inputSchema.additionalProperties, false);
    assert(Array.isArray(tool.inputSchema.required));
    equals(tool.outputSchema.type, "object");
    assert(Array.isArray(tool.outputSchema.oneOf));
  }
});
Deno.test("unverified auth cannot reach MCP", async () => {
  const request = modern("search_capabilities", { query: "github" }),
    bytes = new TextEncoder().encode(JSON.stringify(request)),
    response = await handleFixtureMcp(request, bytes, MCP_CURRENT, "/mcp", {} as never, core);
  equals((response!.error as { code: number }).code, -32600);
});
Deno.test("modern result structuredContent is always an object", async () => {
  const request = modern("search_capabilities", { query: "github" }),
    bytes = new TextEncoder().encode(JSON.stringify(request)),
    response = await handleFixtureMcp(request, bytes, MCP_CURRENT, "/mcp", await auth(bytes), core),
    content = (response!.result as { structuredContent: unknown }).structuredContent;
  assert(!!content && typeof content === "object" && !Array.isArray(content));
});
Deno.test("legacy tools are unavailable before initialize", async () => {
  const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" },
    bytes = new TextEncoder().encode(JSON.stringify(request)),
    response = await handleFixtureMcp(
      request,
      bytes,
      MCP_LEGACY,
      "/mcp/legacy",
      await auth(bytes, "/mcp/legacy"),
      core,
      new LegacyMcpSession(),
    );
  equals((response!.error as { code: number }).code, -32002);
});
Deno.test("legacy 2025-06-18 initialize lifecycle and tools schema", async () => {
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
    },
    bytes = new TextEncoder().encode(JSON.stringify(init)),
    response = await handleFixtureMcp(
      init,
      bytes,
      MCP_LEGACY,
      "/mcp/legacy",
      await auth(bytes, "/mcp/legacy"),
      core,
      session,
    );
  equals((response!.result as { protocolVersion: string }).protocolVersion, MCP_LEGACY);
  const earlyList = { jsonrpc: "2.0" as const, id: 2, method: "tools/list" },
    earlyBytes = new TextEncoder().encode(JSON.stringify(earlyList)),
    early = await handleFixtureMcp(
      earlyList,
      earlyBytes,
      MCP_LEGACY,
      "/mcp/legacy",
      await auth(earlyBytes, "/mcp/legacy"),
      core,
      session,
    );
  equals((early!.error as { code: number }).code, -32002);
  const initialized = { jsonrpc: "2.0" as const, method: "notifications/initialized" },
    initializedBytes = new TextEncoder().encode(JSON.stringify(initialized)),
    notificationResponse = await handleFixtureMcp(
      initialized,
      initializedBytes,
      MCP_LEGACY,
      "/mcp/legacy",
      await auth(initializedBytes, "/mcp/legacy"),
      core,
      session,
    );
  equals(notificationResponse, undefined);
  const list = { jsonrpc: "2.0" as const, id: 3, method: "tools/list" },
    listBytes = new TextEncoder().encode(JSON.stringify(list)),
    listed = await handleFixtureMcp(
      list,
      listBytes,
      MCP_LEGACY,
      "/mcp/legacy",
      await auth(listBytes, "/mcp/legacy"),
      core,
      session,
    );
  for (const tool of (listed!.result as { tools: { inputSchema?: unknown }[] }).tools) {
    assert(tool.inputSchema);
  }
});
Deno.test("expired grants cannot authenticate any MCP tool", async () => {
  const request = modern("search_capabilities", { query: "github" });
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  await rejects(() => auth(bytes, "/mcp", now - 1), "authentication denied");
});
Deno.test("authenticated session must be bound to the exact policy core", async () => {
  const request = modern("search_capabilities", { query: "github" });
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  const verifiedAuth = await auth(bytes);
  const response = await handleFixtureMcp(
    request,
    bytes,
    MCP_CURRENT,
    "/mcp",
    verifiedAuth,
    { ...core, accepts: () => false },
  );
  equals((response!.error as { code: number }).code, -32600);
});
Deno.test("unknown tools are protocol errors and malformed core output is closed", async () => {
  const unknown = modern("unknown_tool", {});
  const unknownBytes = new TextEncoder().encode(JSON.stringify(unknown));
  const unknownResponse = await handleFixtureMcp(
    unknown,
    unknownBytes,
    MCP_CURRENT,
    "/mcp",
    await auth(unknownBytes),
    core,
  );
  equals((unknownResponse!.error as { code: number }).code, -32602);
  const request = modern("connection_status", { connection: "connection_a" });
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  const response = await handleFixtureMcp(
    request,
    bytes,
    MCP_CURRENT,
    "/mcp",
    await auth(bytes),
    { ...core, status: () => Promise.resolve({ status: "PROVIDER_SECRET_SENTINEL" }) },
  );
  const result = response!.result as {
    isError: boolean;
    structuredContent: { category: string };
  };
  equals(result.isError, true);
  equals(result.structuredContent.category, "invalid_output");
  assert(!JSON.stringify(response).includes("SENTINEL"));
});
Deno.test("invalid tool arguments and methods return safe closed errors", async () => {
  const request = modern("invoke_operation", {
      operation: "evil",
      connection: "x",
      arguments: { url: "http://169.254.169.254" },
    }),
    bytes = new TextEncoder().encode(JSON.stringify(request)),
    response = await handleFixtureMcp(request, bytes, MCP_CURRENT, "/mcp", await auth(bytes), core);
  equals((response!.result as { isError: boolean }).isError, true);
  assert(!JSON.stringify(response).includes("169.254"));
});
