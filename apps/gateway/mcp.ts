export const MCP_CURRENT = "2026-07-28" as const;
export const MCP_LEGACY = "2025-06-18" as const;
export const TOOL_NAMES = Object.freeze(
  [
    "search_capabilities",
    "describe_operation",
    "invoke_operation",
    "connection_status",
  ] as const,
);
export type ToolName = typeof TOOL_NAMES[number];
export interface McpCore {
  search(query: string): Promise<unknown>;
  describe(operation: string): Promise<unknown>;
  invoke(operation: string, connection: string, args: unknown): Promise<unknown>;
  status(connection: string): Promise<unknown>;
}
interface Rpc {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
export async function handleFixtureMcp(
  body: unknown,
  headerRevision: string,
  route: "/mcp" | "/mcp/legacy",
  authenticated: boolean,
  core: McpCore,
): Promise<Record<string, unknown>> {
  if (!authenticated || Array.isArray(body) || !body || typeof body !== "object") {
    throw new Error("MCP request denied");
  }
  const request = body as Rpc;
  const required = route === "/mcp" ? MCP_CURRENT : MCP_LEGACY;
  if (headerRevision !== required || request.jsonrpc !== "2.0" || request.id === undefined) {
    throw new Error("MCP protocol denied");
  }
  if (
    route === "/mcp" &&
    (request._meta?.protocolVersion !== MCP_CURRENT || !request._meta.clientInfo ||
      !request._meta.capabilities)
  ) throw new Error("MCP metadata denied");
  if (request.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { tools: TOOL_NAMES.map((name) => ({ name })) },
    };
  }
  if (request.method !== "tools/call" || typeof request.params?.name !== "string") {
    throw new Error("MCP method denied");
  }
  const name = request.params.name as ToolName;
  const input = request.params.arguments as Record<string, unknown> ?? {};
  let structuredContent: unknown;
  switch (name) {
    case "search_capabilities":
      structuredContent = await core.search(String(input.query ?? ""));
      break;
    case "describe_operation":
      structuredContent = await core.describe(String(input.operation ?? ""));
      break;
    case "invoke_operation":
      structuredContent = await core.invoke(
        String(input.operation ?? ""),
        String(input.connection ?? ""),
        input.arguments ?? {},
      );
      break;
    case "connection_status":
      structuredContent = await core.status(String(input.connection ?? ""));
      break;
    default:
      throw new Error("MCP tool denied");
  }
  return { jsonrpc: "2.0", id: request.id, result: { structuredContent } };
}
