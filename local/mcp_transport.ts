import { MCP_CURRENT, MCP_LEGACY } from "../apps/gateway/mcp.ts";
import type { FixtureGatewayHarness } from "../packages/mcp-bridge/mod.ts";

export const MCP_ENDPOINT = "/mcp";
export const MCP_TRANSPORT = "Streamable HTTP";
export const MCP_PROTOCOL_VERSION = MCP_LEGACY;
export const MAX_MCP_BODY_BYTES = 64 * 1024;
const MAX_SESSIONS = 16;
const encoder = new TextEncoder();

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface Session {
  initialized: boolean;
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpc(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers });
}

function mediaTypes(value: string | null): Set<string> {
  return new Set(
    (value ?? "").split(",").map((part) => part.trim().split(";", 1)[0]?.toLowerCase()).filter(
      (part): part is string => !!part,
    ),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validRequest(value: unknown): value is JsonRpcRequest {
  if (!isObject(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return false;
  return value.id === undefined || value.id === null || typeof value.id === "string" ||
    typeof value.id === "number";
}

function validInitialize(request: JsonRpcRequest): boolean {
  if (request.method !== "initialize" || request.id === undefined || request.id === null) {
    return false;
  }
  if (!isObject(request.params)) return false;
  const { capabilities, clientInfo, protocolVersion } = request.params;
  return typeof protocolVersion === "string" && isObject(capabilities) && isObject(clientInfo) &&
    typeof clientInfo.name === "string" && typeof clientInfo.version === "string";
}

function isAllowedHost(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

function originAllowed(request: Request): boolean {
  const url = new URL(request.url);
  if (!isAllowedHost(url)) return false;
  const origin = request.headers.get("Origin");
  return origin === null || origin === url.origin;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
    throw new RangeError("request too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_MCP_BODY_BYTES) throw new RangeError("request too large");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export class StreamableHttpFixtureTransport {
  readonly #harness: FixtureGatewayHarness;
  readonly #sessions = new Map<string, Session>();

  constructor(harness: FixtureGatewayHarness) {
    this.#harness = harness;
  }

  async fetch(request: Request): Promise<Response> {
    if (!originAllowed(request)) return jsonRpc(rpcError(null, -32000, "origin denied"), 403);

    if (request.method === "GET") {
      return jsonRpc(rpcError(null, -32001, "SSE stream unavailable"), 405, {
        Allow: "POST, DELETE",
      });
    }
    if (request.method === "DELETE") return this.#deleteSession(request);
    if (request.method !== "POST") {
      return jsonRpc(rpcError(null, -32600, "method denied"), 405, { Allow: "POST, DELETE" });
    }

    const contentType = mediaTypes(request.headers.get("Content-Type"));
    if (!contentType.has("application/json")) {
      return jsonRpc(rpcError(null, -32600, "application/json required"), 415);
    }
    const accept = mediaTypes(request.headers.get("Accept"));
    if (!accept.has("application/json") || !accept.has("text/event-stream")) {
      return jsonRpc(
        rpcError(null, -32600, "Accept must include application/json and text/event-stream"),
        406,
      );
    }

    let value: unknown;
    try {
      value = await readBoundedJson(request);
    } catch (error) {
      return jsonRpc(
        rpcError(null, -32700, error instanceof RangeError ? "request too large" : "parse error"),
        error instanceof RangeError ? 413 : 400,
      );
    }
    if (!validRequest(value) || Array.isArray(value)) {
      return jsonRpc(rpcError(null, -32600, "request denied"), 400);
    }

    if (value.method === "initialize") return this.#initialize(request, value);

    const session = this.#sessionFor(request);
    if (!session) return jsonRpc(rpcError(value.id ?? null, -32002, "session not found"), 404);
    if (request.headers.get("MCP-Protocol-Version") !== MCP_PROTOCOL_VERSION) {
      return jsonRpc(rpcError(value.id ?? null, -32600, "protocol version denied"), 400);
    }

    if (value.method === "notifications/initialized") {
      if (value.id !== undefined || session.initialized) {
        return jsonRpc(rpcError(value.id ?? null, -32600, "notification denied"), 400);
      }
      session.initialized = true;
      return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (!session.initialized) {
      return jsonRpc(rpcError(value.id ?? null, -32002, "initialize notification required"));
    }
    if (value.id === undefined || value.id === null) {
      return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (value.method === "ping") {
      return jsonRpc({ jsonrpc: "2.0", id: value.id, result: {} });
    }
    if (value.method !== "tools/list" && value.method !== "tools/call") {
      return jsonRpc(rpcError(value.id, -32601, "method denied"));
    }

    const adapted = {
      jsonrpc: "2.0",
      id: value.id,
      method: value.method,
      ...(value.params === undefined ? {} : { params: value.params }),
      _meta: {
        protocolVersion: MCP_CURRENT,
        clientInfo: { name: "cairn-streamable-http", version: "0.1.0" },
        capabilities: {},
      },
    };
    try {
      const response = await this.#harness.dispatch(
        encoder.encode(JSON.stringify(adapted)),
        "/mcp",
      );
      if (value.method === "tools/call" && isObject(response) && isObject(response.result)) {
        const structured = response.result.structuredContent;
        if (isObject(structured)) {
          return jsonRpc({
            ...response,
            result: {
              ...response.result,
              content: [{ type: "text", text: JSON.stringify(structured) }],
            },
          });
        }
      }
      return jsonRpc(response ?? rpcError(value.id, -32603, "empty response denied"));
    } catch {
      return jsonRpc(rpcError(value.id, -32003, "fixture authority denied"));
    }
  }

  #initialize(request: Request, value: JsonRpcRequest): Response {
    if (request.headers.has("Mcp-Session-Id") || !validInitialize(value)) {
      return jsonRpc(rpcError(value.id ?? null, -32602, "initialize denied"), 400);
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      return jsonRpc(rpcError(value.id ?? null, -32000, "session limit reached"), 503);
    }
    const id = crypto.randomUUID();
    this.#sessions.set(id, { initialized: false });
    return jsonRpc(
      {
        jsonrpc: "2.0",
        id: value.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "cairn-local-fixture", version: "0.1.0" },
          instructions: "Use invoke_operation with github.user.read@v1 and connection_a.",
        },
      },
      200,
      { "Mcp-Session-Id": id },
    );
  }

  #sessionFor(request: Request): Session | undefined {
    const id = request.headers.get("Mcp-Session-Id");
    return id ? this.#sessions.get(id) : undefined;
  }

  #deleteSession(request: Request): Response {
    if (request.headers.get("MCP-Protocol-Version") !== MCP_PROTOCOL_VERSION) {
      return jsonRpc(rpcError(null, -32600, "protocol version denied"), 400);
    }
    const id = request.headers.get("Mcp-Session-Id");
    if (!id || !this.#sessions.delete(id)) {
      return jsonRpc(rpcError(null, -32002, "session not found"), 404);
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
}
