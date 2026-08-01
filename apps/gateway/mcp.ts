import { isVerifiedMcpAuth, type VerifiedMcpAuth } from "./mcp_auth.ts";
export const MCP_CURRENT = "2026-07-28" as const;
export const MCP_LEGACY = "2025-06-18" as const;
export const TOOL_NAMES = Object.freeze(
  ["search_capabilities", "describe_operation", "invoke_operation", "connection_status"] as const,
);
export type ToolName = typeof TOOL_NAMES[number];
export type Structured = Record<string, unknown>;
export interface McpCore {
  search(query: string): Promise<Structured>;
  describe(operation: string): Promise<Structured>;
  invoke(
    operation: string,
    connection: string,
    args: unknown,
    receivedBody: Uint8Array,
  ): Promise<Structured>;
  status(connection: string): Promise<Structured>;
}
export class LegacyMcpSession {
  #initialized = false;
  initialize(): void {
    this.#initialized = true;
  }
  get initialized(): boolean {
    return this.#initialized;
  }
}
interface Rpc {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
const schemas: Record<ToolName, Record<string, unknown>> = {
  search_capabilities: {
    type: "object",
    properties: { query: { type: "string", maxLength: 200 } },
    required: ["query"],
    additionalProperties: false,
  },
  describe_operation: {
    type: "object",
    properties: { operation: { type: "string", const: "github.user.read@v1" } },
    required: ["operation"],
    additionalProperties: false,
  },
  invoke_operation: {
    type: "object",
    properties: {
      operation: { type: "string", const: "github.user.read@v1" },
      connection: { type: "string", minLength: 1, maxLength: 128 },
      arguments: { type: "object", properties: {}, additionalProperties: false },
    },
    required: ["operation", "connection", "arguments"],
    additionalProperties: false,
  },
  connection_status: {
    type: "object",
    properties: { connection: { type: "string", minLength: 1, maxLength: 128 } },
    required: ["connection"],
    additionalProperties: false,
  },
};
const outputSchemas: Record<ToolName, Record<string, unknown>> = {
  search_capabilities: {
    type: "object",
    properties: { operations: { type: "array" }, count: { type: "integer", minimum: 0 } },
    required: ["operations", "count"],
    additionalProperties: false,
  },
  describe_operation: {
    type: "object",
    properties: {
      id: { const: "github.user.read@v1" },
      provider: { const: "github" },
      inputSchema: { type: "object" },
      requestUnits: { const: 1 },
    },
    required: ["id", "provider", "inputSchema", "requestUnits"],
    additionalProperties: false,
  },
  invoke_operation: {
    type: "object",
    properties: {
      outcome: { type: "string" },
      user: { type: "object" },
      receipt: { type: "object" },
    },
    required: ["outcome", "receipt"],
    additionalProperties: false,
  },
  connection_status: {
    type: "object",
    properties: {
      connection: { type: "string" },
      status: { const: "active" },
      operation: { const: "github.user.read@v1" },
    },
    required: ["connection", "status", "operation"],
    additionalProperties: false,
  },
};
export const TOOLS = Object.freeze(
  TOOL_NAMES.map((name) =>
    Object.freeze({
      name,
      description: name.replaceAll("_", " "),
      inputSchema: schemas[name],
      outputSchema: outputSchemas[name],
    })
  ),
);
const rpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
export async function handleFixtureMcp(
  body: unknown,
  receivedBody: Uint8Array,
  headerRevision: string,
  route: "/mcp" | "/mcp/legacy",
  auth: VerifiedMcpAuth,
  core: McpCore,
  legacySession?: LegacyMcpSession,
): Promise<Record<string, unknown>> {
  if (!isVerifiedMcpAuth(auth) || Array.isArray(body) || !body || typeof body !== "object") {
    return rpcError(null, -32600, "request denied");
  }
  const request = body as Rpc,
    id = request.id ?? null,
    required = route === "/mcp" ? MCP_CURRENT : MCP_LEGACY;
  if (headerRevision !== required || request.jsonrpc !== "2.0" || request.id === undefined) {
    return rpcError(id, -32600, "protocol denied");
  }
  if (route === "/mcp/legacy" && request.method === "initialize") {
    if (!legacySession) return rpcError(id, -32002, "legacy session required");
    legacySession.initialize();
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: MCP_LEGACY,
        capabilities: { tools: {} },
        serverInfo: { name: "cairn-fixture", version: "0.0.0-stage0" },
      },
    };
  }
  if (route === "/mcp/legacy" && !legacySession?.initialized) {
    return rpcError(id, -32002, "initialize required");
  }
  if (
    route === "/mcp" &&
    (request._meta?.protocolVersion !== MCP_CURRENT || !request._meta.clientInfo ||
      !request._meta.capabilities)
  ) return rpcError(id, -32600, "metadata denied");
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } };
  }
  if (request.method !== "tools/call" || typeof request.params?.name !== "string") {
    return rpcError(id, -32601, "method denied");
  }
  const name = request.params.name as ToolName, input = request.params.arguments;
  if (!TOOL_NAMES.includes(name) || !validInput(name, input)) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        isError: true,
        content: [{ type: "text", text: "request denied" }],
        structuredContent: { outcome: "denied", category: "invalid_input" },
      },
    };
  }
  try {
    const value = input as Record<string, unknown>;
    let structuredContent: Structured;
    switch (name) {
      case "search_capabilities":
        structuredContent = await core.search(value.query as string);
        break;
      case "describe_operation":
        structuredContent = await core.describe(value.operation as string);
        break;
      case "invoke_operation":
        structuredContent = await core.invoke(
          value.operation as string,
          value.connection as string,
          value.arguments,
          receivedBody,
        );
        break;
      case "connection_status":
        structuredContent = await core.status(value.connection as string);
        break;
    }
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "ok" }], structuredContent },
    };
  } catch {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        isError: true,
        content: [{ type: "text", text: "request denied" }],
        structuredContent: { outcome: "denied", category: "policy_denied" },
      },
    };
  }
}
function validInput(name: ToolName, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) =>
      !Object.keys((schemas[name].properties ?? {}) as object).includes(key)
    )
  ) return false;
  if (name === "search_capabilities") {
    return typeof input.query === "string" && input.query.length <= 200;
  }
  if (name === "describe_operation") return input.operation === "github.user.read@v1";
  if (name === "connection_status") {
    return typeof input.connection === "string" && input.connection.length > 0 &&
      input.connection.length <= 128;
  }
  return input.operation === "github.user.read@v1" && typeof input.connection === "string" &&
    input.connection.length > 0 && input.connection.length <= 128 && !!input.arguments &&
    typeof input.arguments === "object" && !Array.isArray(input.arguments) &&
    Object.keys(input.arguments as object).length === 0;
}
