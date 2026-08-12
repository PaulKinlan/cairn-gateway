import {
  createDeepSeekController,
  type CustodianClient,
  DEEPSEEK_OPERATION,
  FileMetadataStore,
  httpCustodianClient,
  type MetadataStore,
} from "./deepseek_controller.ts";
import {
  MCP_ENDPOINT,
  StreamableHttpFixtureTransport,
  type ToolDescriptor,
} from "./mcp_transport.ts";
import { renderDeepSeekPage } from "./deepseek_ui.ts";
import { readBoundedBody } from "./bounded_body.ts";

const RECEIPT_ERROR_SCHEMA = {
  type: "object",
  properties: {
    decision: { const: "error" },
    reason: { const: "custodian_denied" },
    requestUnits: { const: 0 },
  },
  required: ["decision", "reason", "requestUnits"],
  additionalProperties: false,
};
const SUCCESS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { const: "success" },
    assistant_text: { type: "string" },
    finish_category: { enum: ["complete", "length"] },
    usage: {
      type: "object",
      properties: {
        input_tokens: { type: "integer", minimum: 0 },
        output_tokens: { type: "integer", minimum: 0 },
        total_tokens: { type: "integer", minimum: 0 },
      },
      required: ["input_tokens", "output_tokens", "total_tokens"],
      additionalProperties: false,
    },
    receipt: {
      type: "object",
      properties: {
        decision: { const: "allow" },
        reason: { const: "policy_allow" },
        requestUnits: { const: 1 },
      },
      required: ["decision", "reason", "requestUnits"],
      additionalProperties: false,
    },
  },
  required: ["outcome", "assistant_text", "finish_category", "usage", "receipt"],
  additionalProperties: false,
};
export const DEEPSEEK_TOOLS: readonly ToolDescriptor[] = Object.freeze([
  {
    name: "search_capabilities",
    description: "search capabilities",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { const: DEEPSEEK_OPERATION },
              connection: { const: "deepseek_local" },
            },
            required: ["id", "connection"],
            additionalProperties: false,
          },
        },
        count: { type: "integer", minimum: 0 },
      },
      required: ["operations", "count"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_operation",
    description: "describe operation",
    inputSchema: {
      type: "object",
      properties: { operation: { const: DEEPSEEK_OPERATION } },
      required: ["operation"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { const: DEEPSEEK_OPERATION },
        provider: { const: "deepseek" },
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        requestUnits: { const: 1 },
      },
      required: ["id", "provider", "inputSchema", "outputSchema", "requestUnits"],
      additionalProperties: false,
    },
  },
  {
    name: "invoke_operation",
    description: "invoke operation",
    inputSchema: {
      type: "object",
      properties: {
        operation: { const: DEEPSEEK_OPERATION },
        connection: { const: "deepseek_local" },
        arguments: {
          type: "object",
          properties: {
            messages: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: {
                type: "object",
                properties: { role: { enum: ["system", "user"] }, content: { type: "string" } },
                required: ["role", "content"],
                additionalProperties: false,
              },
            },
            max_output_tokens: { type: "integer", minimum: 1, maximum: 1024 },
          },
          required: ["messages"],
          additionalProperties: false,
        },
      },
      required: ["operation", "connection", "arguments"],
      additionalProperties: false,
    },
    outputSchema: {
      oneOf: [
        SUCCESS_OUTPUT_SCHEMA,
        {
          type: "object",
          properties: {
            outcome: {
              enum: [
                "invalid_input",
                "rate_limited",
                "auth_required",
                "provider_unavailable",
                "authority_changed",
              ],
            },
            receipt: RECEIPT_ERROR_SCHEMA,
          },
          required: ["outcome", "receipt"],
          additionalProperties: false,
        },
      ],
    },
  },
  {
    name: "connection_status",
    description: "connection status",
    inputSchema: {
      type: "object",
      properties: { connection: { const: "deepseek_local" } },
      required: ["connection"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        connection: { const: "deepseek_local" },
        status: { const: "active" },
        configured: { const: true },
        healthy: { type: ["boolean", "null"] },
        operation: { const: DEEPSEEK_OPERATION },
      },
      required: ["connection", "status", "configured", "healthy", "operation"],
      additionalProperties: false,
    },
  },
]);
function cookie(request: Request) {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)cairn_local=([a-f0-9]{32})/)?.[1];
}
function response(body: BodyInit | null, status: number, contentType: string, extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { status, headers });
}
export async function createDeepSeekApp(
  options: {
    custodianOrigin: string;
    dispatchCredential: string;
    metadata?: MetadataStore;
    custodian?: CustodianClient;
  },
) {
  const metadata = options.metadata ??
    new FileMetadataStore(
      `${Deno.env.get("HOME") ?? "."}/.local/state/cairn/gateway/deepseek.json`,
    );
  const controller = await createDeepSeekController(
    options.custodian ?? httpCustodianClient(options.custodianOrigin, options.dispatchCredential),
    metadata,
  );
  const transport = new StreamableHttpFixtureTransport(controller, {}, DEEPSEEK_TOOLS, "deepseek");
  const sessions = new Map<string, { csrf: string; lastSeen: number }>();
  const purgeSessions = () => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, session] of sessions) if (session.lastSeen < cutoff) sessions.delete(id);
    while (sessions.size >= 16) sessions.delete(sessions.keys().next().value!);
  };
  const page = async (request: Request, notice = "") => {
    purgeSessions();
    let id = cookie(request);
    if (!id || !sessions.has(id)) {
      id = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
      sessions.set(id, { csrf: crypto.randomUUID().replaceAll("-", ""), lastSeen: Date.now() });
    }
    const session = sessions.get(id)!;
    session.lastSeen = Date.now();
    return response(
      renderDeepSeekPage(
        new URL(request.url).origin,
        options.custodianOrigin,
        session.csrf,
        await controller.view(),
        notice,
      ),
      200,
      "text/html; charset=utf-8",
      { "Set-Cookie": `cairn_local=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600` },
    );
  };
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        return response("denied", 403, "text/plain");
      }
      if (url.pathname === MCP_ENDPOINT) return await transport.fetch(request);
      if (url.pathname === "/" && request.method === "GET") {
        return await page(
          request,
          url.searchParams.get("connected") === "1"
            ? "Key stored by the custodian. Click Connect before invoking."
            : "",
        );
      }
      if (
        !["/admin/connect", "/admin/disconnect", "/admin/delete"].includes(url.pathname) ||
        request.method !== "POST"
      ) return response("not found", 404, "text/plain");
      if (request.headers.get("origin") !== url.origin) {
        return response("denied", 403, "text/plain");
      }
      const id = cookie(request);
      purgeSessions();
      const csrf = id ? sessions.get(id)?.csrf : undefined;
      let values: URLSearchParams;
      try {
        values = new URLSearchParams(
          new TextDecoder().decode(await readBoundedBody(request, 2048)),
        );
      } catch {
        return response("denied", 400, "text/plain");
      }
      if (
        !csrf || [...values.keys()].join(",") !== "csrf_token" || values.get("csrf_token") !== csrf
      ) return response("denied", 403, "text/plain");
      try {
        if (url.pathname === "/admin/connect") await controller.connect();
        else if (url.pathname === "/admin/disconnect") await controller.disconnect();
        else await controller.delete();
        sessions.set(id!, { csrf: crypto.randomUUID().replaceAll("-", ""), lastSeen: Date.now() });
        return await page(
          request,
          url.pathname.endsWith("delete")
            ? "DeepSeek key deleted from Secret Service and authority disabled."
            : url.pathname.endsWith("disconnect")
            ? "Connection disabled. The retained key remains only in Secret Service."
            : "Connection enabled with fresh grant authority.",
        );
      } catch {
        return await page(request, "Action denied. Add a key through the custodian first.");
      }
    },
  });
}
export function startDeepSeekServer(
  app: { fetch(request: Request): Promise<Response> },
  port: number,
) {
  return Deno.serve(
    { hostname: "127.0.0.1", port, onListen() {} },
    (request) => app.fetch(request),
  );
}
