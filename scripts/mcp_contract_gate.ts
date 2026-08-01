import fixture from "../tests/fixtures/mcp-sdk-1.30.0-minimal-schema.json" with { type: "json" };
import {
  INPUT_SCHEMAS,
  LEGACY_INITIALIZE_RESULT,
  MCP_LEGACY,
  OUTPUT_SCHEMAS,
  TOOL_NAMES,
  TOOLS,
} from "../apps/gateway/mcp.ts";
import { validatesSchema } from "../apps/gateway/json_schema.ts";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: MCP_LEGACY,
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
assert(initialize.method === fixture.initializeRequest.method, "initialize method");
for (const key of fixture.initializeRequest.requiredParams) {
  assert(key in initialize.params, `initialize params ${key}`);
}
for (const key of fixture.initializeRequest.clientInfoRequired) {
  assert(key in initialize.params.clientInfo, `clientInfo ${key}`);
}
for (const key of fixture.initializeResult.required) {
  assert(key in LEGACY_INITIALIZE_RESULT, `initialize result ${key}`);
}
for (const key of fixture.initializeResult.serverInfoRequired) {
  assert(key in LEGACY_INITIALIZE_RESULT.serverInfo, `serverInfo ${key}`);
}
assert(initialized.method === fixture.initializedNotification.method, "initialized method");
assert(!("id" in initialized), "initialized id");
for (const tool of TOOLS) {
  for (const key of fixture.tool.required) assert(key in tool, `tool ${tool.name} ${key}`);
  assert(tool.inputSchema.type === fixture.tool.inputSchemaRootType, `input root ${tool.name}`);
  assert(validatesSchema(INPUT_SCHEMAS[tool.name], validInput(tool.name)), `input ${tool.name}`);
}
const samples: Record<string, unknown[]> = {
  search_capabilities: [
    { operations: [], count: 0 },
    { operations: [{ id: "github.user.read@v1", connection: "connection_a" }], count: 1 },
  ],
  describe_operation: [{
    id: "github.user.read@v1",
    provider: "github",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    requestUnits: 1,
  }],
  invoke_operation: [
    {
      outcome: "success",
      user: {
        id: 1,
        login: "fixture",
        name: null,
        html_url: "https://github.com/fixture",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
      },
      receipt: { decision: "allow", reason: "policy_allow", requestUnits: 1 },
    },
    ...["auth_required", "rate_limited", "provider_denied", "provider_unavailable"].map(
      (outcome) => ({
        outcome,
        receipt: {
          decision: outcome === "provider_unavailable" ? "error" : "allow",
          reason: "provider_failure",
          requestUnits: 1,
        },
      }),
    ),
  ],
  connection_status: [{
    connection: "connection_a",
    status: "active",
    operation: "github.user.read@v1",
  }],
};
const errors = ["invalid_input", "policy_denied", "invalid_output"].map((category) => ({
  outcome: "denied",
  category,
}));
let outputCount = 0;
for (const name of TOOL_NAMES) {
  for (const sample of [...samples[name]!, ...errors]) {
    assert(validatesSchema(OUTPUT_SCHEMAS[name], sample), `output ${name}`);
    outputCount++;
  }
  assert(
    !validatesSchema(OUTPUT_SCHEMAS[name], {
      outcome: { toString: () => "denied" },
      category: "invalid_output",
    }),
    `coercion ${name}`,
  );
}
console.log(
  `mcp-contract: ${TOOLS.length} tools, ${outputCount} success/error outputs, official fixture ${fixture.provenance.version}`,
);
function validInput(name: typeof TOOL_NAMES[number]) {
  if (name === "search_capabilities") return { query: "github" };
  if (name === "describe_operation") return { operation: "github.user.read@v1" };
  if (name === "connection_status") return { connection: "connection_a" };
  return { operation: "github.user.read@v1", connection: "connection_a", arguments: {} };
}
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`MCP contract gate failed: ${label}`);
}
