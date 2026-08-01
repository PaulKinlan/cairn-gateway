import { consumeVerifiedMcpAuth, isVerifiedMcpAuth, type VerifiedMcpAuth } from "./mcp_auth.ts";
import { isTrustedPolicyMcpCore } from "./policy_core.ts";
import { validatesSchema } from "./json_schema.ts";
export const MCP_CURRENT = "2026-07-28" as const;
export const MCP_LEGACY = "2025-06-18" as const;
export const TOOL_NAMES = Object.freeze(
  ["search_capabilities", "describe_operation", "invoke_operation", "connection_status"] as const,
);
export type ToolName = typeof TOOL_NAMES[number];
export type Structured = Record<string, unknown>;
export class LegacyMcpSession {
  #state: "new" | "negotiating" | "ready" = "new";
  begin(): boolean {
    if (this.#state !== "new") return false;
    this.#state = "negotiating";
    return true;
  }
  complete(): boolean {
    if (this.#state !== "negotiating") return false;
    this.#state = "ready";
    return true;
  }
  get initialized(): boolean {
    return this.#state === "ready";
  }
}
interface Rpc {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
const emptyArgumentsSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
});
export const INPUT_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  search_capabilities: {
    type: "object",
    properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
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
      arguments: emptyArgumentsSchema,
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
const errorSchema = {
  type: "object",
  properties: {
    outcome: { const: "denied" },
    category: { enum: ["invalid_input", "policy_denied", "invalid_output"] },
  },
  required: ["outcome", "category"],
  additionalProperties: false,
};
const receiptSchema = {
  type: "object",
  properties: {
    decision: { enum: ["allow", "deny", "error"] },
    reason: { type: "string", minLength: 1, maxLength: 64 },
    requestUnits: { enum: [0, 1] },
  },
  required: ["decision", "reason", "requestUnits"],
  additionalProperties: false,
};
const successSchemas: Record<ToolName, Record<string, unknown>> = {
  search_capabilities: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        maxItems: 1,
        items: {
          type: "object",
          properties: {
            id: { const: "github.user.read@v1" },
            connection: { type: "string", minLength: 1, maxLength: 128 },
          },
          required: ["id", "connection"],
          additionalProperties: false,
        },
      },
      count: { enum: [0, 1] },
    },
    required: ["operations", "count"],
    additionalProperties: false,
  },
  describe_operation: {
    type: "object",
    properties: {
      id: { const: "github.user.read@v1" },
      provider: { const: "github" },
      inputSchema: { const: emptyArgumentsSchema },
      requestUnits: { const: 1 },
    },
    required: ["id", "provider", "inputSchema", "requestUnits"],
    additionalProperties: false,
  },
  invoke_operation: {
    oneOf: [
      {
        type: "object",
        properties: {
          outcome: { const: "success" },
          user: {
            type: "object",
            properties: {
              id: { type: "integer" },
              login: { type: "string", maxLength: 100 },
              name: { type: ["string", "null"] },
              html_url: { type: "string" },
              avatar_url: { type: "string" },
            },
            required: ["id", "login", "name", "html_url", "avatar_url"],
            additionalProperties: false,
          },
          receipt: receiptSchema,
        },
        required: ["outcome", "user", "receipt"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          outcome: {
            enum: ["auth_required", "rate_limited", "provider_denied", "provider_unavailable"],
          },
          receipt: receiptSchema,
        },
        required: ["outcome", "receipt"],
        additionalProperties: false,
      },
    ],
  },
  connection_status: {
    type: "object",
    properties: {
      connection: { type: "string", minLength: 1, maxLength: 128 },
      status: { const: "active" },
      operation: { const: "github.user.read@v1" },
    },
    required: ["connection", "status", "operation"],
    additionalProperties: false,
  },
};
export const OUTPUT_SCHEMAS: Record<ToolName, Record<string, unknown>> = Object.fromEntries(
  TOOL_NAMES.map((name) => [
    name,
    Object.freeze({ type: "object", oneOf: [successSchemas[name], errorSchema] }),
  ]),
) as unknown as Record<ToolName, Record<string, unknown>>;
export const TOOLS = Object.freeze(
  TOOL_NAMES.map((name) =>
    Object.freeze({
      name,
      description: name.replaceAll("_", " "),
      inputSchema: INPUT_SCHEMAS[name],
      outputSchema: OUTPUT_SCHEMAS[name],
    })
  ),
);
export const LEGACY_INITIALIZE_RESULT = Object.freeze({
  protocolVersion: MCP_LEGACY,
  capabilities: Object.freeze({ tools: Object.freeze({}) }),
  serverInfo: Object.freeze({ name: "cairn-fixture", version: "0.0.0-stage0" }),
});
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
  core: unknown,
  legacySession?: LegacyMcpSession,
  authority = "fixture.cairn.invalid",
): Promise<Record<string, unknown> | undefined> {
  if (!isVerifiedMcpAuth(auth) || Array.isArray(body) || !body || typeof body !== "object") {
    return rpcError(null, -32600, "request denied");
  }
  const request = body as Rpc;
  const id = request.id ?? null;
  const required = route === "/mcp" ? MCP_CURRENT : MCP_LEGACY;
  if (
    headerRevision !== required || request.jsonrpc !== "2.0" || typeof request.method !== "string"
  ) {
    return rpcError(id, -32600, "protocol denied");
  }
  if (
    !isTrustedPolicyMcpCore(core, auth) ||
    !await consumeVerifiedMcpAuth(auth, { receivedBody, authority, path: route })
  ) return rpcError(id, -32600, "authentication binding denied");

  if (route === "/mcp/legacy") {
    if (!legacySession) return rpcError(id, -32002, "legacy session required");
    if (request.method === "initialize") {
      if (request.id === undefined || !validInitialize(request.params) || !legacySession.begin()) {
        return rpcError(id, -32602, "initialize denied");
      }
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: LEGACY_INITIALIZE_RESULT,
      };
    }
    if (request.method === "notifications/initialized") {
      if (request.id !== undefined || !legacySession.complete()) {
        return request.id === undefined ? undefined : rpcError(id, -32600, "notification denied");
      }
      return undefined;
    }
    if (!legacySession.initialized) return rpcError(id, -32002, "initialize required");
  }
  if (request.id === undefined) return undefined;
  if (
    route === "/mcp" &&
    (request._meta?.protocolVersion !== MCP_CURRENT || !plainObject(request._meta.clientInfo) ||
      !plainObject(request._meta.capabilities))
  ) return rpcError(id, -32600, "metadata denied");
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } };
  }
  if (request.method !== "tools/call" || typeof request.params?.name !== "string") {
    return rpcError(id, -32601, "method denied");
  }
  if (!TOOL_NAMES.includes(request.params.name as ToolName)) {
    return rpcError(id, -32602, "unknown tool");
  }
  const name = request.params.name as ToolName;
  const input = request.params.arguments;
  if (!validInput(name, input)) return toolError(request.id, name, "invalid_input");
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
    if (!validOutput(name, structuredContent)) return toolError(request.id, name, "invalid_output");
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "ok" }], structuredContent },
    };
  } catch {
    return toolError(request.id, name, "policy_denied");
  }
}
function toolError(id: string | number, name: ToolName, category: string) {
  const structuredContent = { outcome: "denied", category };
  if (!validOutput(name, structuredContent)) throw new Error("internal error schema mismatch");
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [{ type: "text", text: "request denied" }],
      structuredContent,
    },
  };
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function validInitialize(value: unknown): boolean {
  if (!plainObject(value) || !exactKeys(value, ["protocolVersion", "capabilities", "clientInfo"])) {
    return false;
  }
  return value.protocolVersion === MCP_LEGACY && plainObject(value.capabilities) &&
    plainObject(value.clientInfo) && typeof value.clientInfo.name === "string" &&
    typeof value.clientInfo.version === "string";
}
function validInput(name: ToolName, value: unknown): boolean {
  if (!plainObject(value)) return false;
  const input = value;
  if (name === "search_capabilities") {
    return exactKeys(input, ["query"]) && typeof input.query === "string" &&
      input.query.length > 0 && input.query.length <= 200;
  }
  if (name === "describe_operation") {
    return exactKeys(input, ["operation"]) && input.operation === "github.user.read@v1";
  }
  if (name === "connection_status") {
    return exactKeys(input, ["connection"]) && validId(input.connection);
  }
  return exactKeys(input, ["operation", "connection", "arguments"]) &&
    input.operation === "github.user.read@v1" && validId(input.connection) &&
    plainObject(input.arguments) && Object.keys(input.arguments).length === 0;
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
export function validOutput(name: ToolName, value: unknown): value is Structured {
  return validatesSchema(OUTPUT_SCHEMAS[name], value);
}
