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
    new FileMetadataStore(`${Deno.env.get("HOME") ?? "."}/.local/state/cairn/deepseek.json`);
  const controller = await createDeepSeekController(
    options.custodian ?? httpCustodianClient(options.custodianOrigin, options.dispatchCredential),
    metadata,
  );
  const transport = new StreamableHttpFixtureTransport(controller, {}, DEEPSEEK_TOOLS, "deepseek");
  const sessions = new Map<string, string>();
  const page = async (request: Request, notice = "") => {
    let id = cookie(request);
    if (!id || !sessions.has(id)) {
      id = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
      sessions.set(id, crypto.randomUUID().replaceAll("-", ""));
    }
    return response(
      renderDeepSeekPage(
        new URL(request.url).origin,
        options.custodianOrigin,
        sessions.get(id)!,
        await controller.view(),
        notice,
      ),
      200,
      "text/html; charset=utf-8",
      { "Set-Cookie": `cairn_local=${id}; HttpOnly; SameSite=Strict; Path=/` },
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
            ? "Key stored by the custodian. Connect or invoke when ready."
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
      const csrf = id ? sessions.get(id) : undefined;
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
        sessions.set(id!, crypto.randomUUID().replaceAll("-", ""));
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
