import fixture from "../tests/fixtures/mcp-sdk-1.30.0-minimal-schema.json" with { type: "json" };
import {
  INPUT_SCHEMAS,
  LegacyMcpSession,
  MCP_LEGACY,
  OUTPUT_SCHEMAS,
  processLegacyLifecycle,
  TOOL_NAMES,
  type ToolName,
  TOOLS,
  validCallToolResult,
} from "../apps/gateway/mcp.ts";
import { validatesSchema } from "../apps/gateway/json_schema.ts";

type Fixture = typeof fixture;
const EXPECTED_PROVENANCE = {
  package: "@modelcontextprotocol/sdk",
  version: "1.30.0",
  sourceFile: "dist/esm/types.js",
  packageJsonSha256: "0690cbe02511a95d1ff199acf20b5a12ac4dfde1bbe30c82a0de73afa92dffc9",
  esmTypesSha256: "962836b0f8dad85bcd398ad3ddb5ba81a7c7530c706955aa846dd8dfc02dd6a9",
  scope: "minimal immutable legacy 2025-06-18 fixture; not SDK or transport conformance",
} as const;

/** Runs the immutable fixture contract and rejects any newly unconsumed leaf. */
export function runMcpContractGate(candidate: Fixture = fixture, quiet = false): void {
  const used = new Set<string>();
  const read = <T>(path: string): T => {
    used.add(path);
    let value: unknown = candidate;
    for (const part of path.split(".")) value = (value as Record<string, unknown>)[part];
    return value as T;
  };
  for (const [key, expected] of Object.entries(EXPECTED_PROVENANCE)) {
    assert(read(`provenance.${key}`) === expected, `provenance ${key}`);
  }
  const initialize = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_LEGACY,
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    },
  };
  assert(initialize.method === read<string>("initializeRequest.method"), "initialize method");
  for (const key of read<string[]>("initializeRequest.requiredParams")) {
    assert(key in initialize.params, `initialize params ${key}`);
  }
  for (const key of read<string[]>("initializeRequest.clientInfoRequired")) {
    assert(key in initialize.params.clientInfo, `clientInfo ${key}`);
  }
  const session = new LegacyMcpSession();
  const initialized = processLegacyLifecycle(initialize, session);
  assert(initialized.handled && !!initialized.response, "initialize handled");
  const initializeResult = initialized.response!.result as Record<string, unknown>;
  for (const key of read<string[]>("initializeResult.required")) {
    assert(key in initializeResult, `initialize result ${key}`);
  }
  const serverInfo = initializeResult.serverInfo as Record<string, unknown>;
  for (const key of read<string[]>("initializeResult.serverInfoRequired")) {
    assert(key in serverInfo, `serverInfo ${key}`);
  }
  const notification = {
    jsonrpc: "2.0" as const,
    method: read<string>("initializedNotification.method"),
  };
  assert(read<boolean>("initializedNotification.mustNotHaveId") === true, "notification id rule");
  assert(!("id" in notification), "initialized id");
  const notificationResult = processLegacyLifecycle(notification, session);
  assert(notificationResult.handled, "notification handled");
  assert(
    read<boolean>("initializedNotification.mustNotProduceResponse") === true &&
      notificationResult.response === undefined,
    "notification response",
  );
  const toolRequired = read<string[]>("tool.required");
  const inputRoot = read<string>("tool.inputSchemaRootType");
  for (const tool of TOOLS) {
    for (const key of toolRequired) assert(key in tool, `tool ${tool.name} ${key}`);
    assert(tool.inputSchema.type === inputRoot, `input root ${tool.name}`);
    assert(validatesSchema(INPUT_SCHEMAS[tool.name], validInput(tool.name)), `input ${tool.name}`);
  }
  const rootType = read<string>("callToolResult.structuredContentRootType");
  const errorFlag = read<string>("callToolResult.errorFlag");
  assert(rootType === "object", "call result structured root");
  assert(errorFlag === "isError", "call result error flag");

  const samples = outputSamples();
  const errors = ["invalid_input", "policy_denied", "invalid_output"].map((category) => ({
    outcome: "denied",
    category,
  }));
  let outputCount = 0;
  for (const name of TOOL_NAMES) {
    for (const sample of samples[name]) {
      assert(validatesSchema(OUTPUT_SCHEMAS[name], sample), `output ${name}`);
      const result = { content: [{ type: "text", text: "ok" }], structuredContent: sample };
      assert(typeof result.structuredContent === "object", `result root ${name}`);
      assert(validCallToolResult(name, result), `success envelope ${name}`);
      outputCount++;
    }
    for (const sample of errors) {
      const result = {
        [errorFlag]: true,
        content: [{ type: "text", text: "request denied" }],
        structuredContent: sample,
      };
      assert(validCallToolResult(name, result), `error envelope ${name}`);
      assert(result[errorFlag] === true, `error flag ${name}`);
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
  const leaves = leafPaths(candidate);
  const missing = leaves.filter((path) => !used.has(path));
  assert(missing.length === 0, `unconsumed fixture fields: ${missing.join(",")}`);
  if (!quiet) {
    console.log(
      `mcp-contract: ${TOOLS.length} tools, ${outputCount} success/error envelopes, ${used.size}/${leaves.length} fixture leaves consumed, official fixture ${candidate.provenance.version}`,
    );
  }
}

function outputSamples(): Record<ToolName, Record<string, unknown>[]> {
  return {
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
}
function validInput(name: ToolName) {
  if (name === "search_capabilities") return { query: "github" };
  if (name === "describe_operation") return { operation: "github.user.read@v1" };
  if (name === "connection_status") return { connection: "connection_a" };
  return { operation: "github.user.read@v1", connection: "connection_a", arguments: {} };
}
function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value) || !value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`MCP contract gate failed: ${label}`);
}

if (import.meta.main) runMcpContractGate();
