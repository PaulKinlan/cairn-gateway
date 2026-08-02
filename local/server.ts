import {
  createFixtureGatewayHarness,
  type FixtureGatewayHarness,
} from "../packages/mcp-bridge/mod.ts";
import { MCP_ENDPOINT, StreamableHttpFixtureTransport } from "./mcp_transport.ts";
import { adminClientScript, renderAdminPage } from "./ui.ts";

export const LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_PORT = 8787;
const MAX_FORM_BYTES = 2 * 1024;
const encoder = new TextEncoder();

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["Cache-Control", "no-store, max-age=0"],
  [
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'none'; object-src 'none'; script-src 'self'; style-src 'unsafe-inline'",
  ],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
]);

interface LocalApp {
  fetch(request: Request): Promise<Response>;
}

function response(
  body: BodyInit | null,
  status: number,
  contentType?: string,
  allow?: string,
): Response {
  const headers = new Headers();
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  if (contentType) headers.set("Content-Type", contentType);
  if (allow) headers.set("Allow", allow);
  return new Response(body, { status, headers });
}

function jsonError(status: number, error: string, allow?: string): Response {
  return response(
    `${JSON.stringify({ error })}\n`,
    status,
    "application/json; charset=utf-8",
    allow,
  );
}

function allowedOrigin(request: Request): boolean {
  const url = new URL(request.url);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
  const origin = request.headers.get("Origin");
  return origin === null || origin === url.origin;
}

async function formValues(request: Request): Promise<URLSearchParams | undefined> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return undefined;
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return undefined;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_FORM_BYTES) return undefined;
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

async function fixtureInvocation(harness: FixtureGatewayHarness): Promise<string> {
  const request = {
    jsonrpc: "2.0",
    id: "admin-test",
    method: "tools/call",
    params: {
      name: "invoke_operation",
      arguments: {
        operation: "github.user.read@v1",
        connection: "connection_a",
        arguments: {},
      },
    },
    _meta: {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "cairn-local-admin", version: "0.1.0" },
      capabilities: {},
    },
  };
  try {
    const result = await harness.dispatch(encoder.encode(JSON.stringify(request)), "/mcp");
    return JSON.stringify(result, null, 2);
  } catch {
    return JSON.stringify({ outcome: "denied", reason: "fixture grant is not active" }, null, 2);
  }
}

export async function createLocalApp(): Promise<LocalApp> {
  const harness = await createFixtureGatewayHarness();
  const transport = new StreamableHttpFixtureTransport(harness);
  const csrfToken = crypto.randomUUID().replaceAll("-", "");

  const page = async (request: Request, result?: string): Promise<Response> => {
    const origin = new URL(request.url).origin;
    const html = renderAdminPage({
      origin,
      csrfToken,
      connectionStatus: await harness.status("connection"),
      grantStatus: await harness.status("grant"),
      ...(result === undefined ? {} : { result }),
    });
    return response(html, 200, "text/html; charset=utf-8");
  };

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (!allowedOrigin(request)) return jsonError(403, "origin_denied");
      if (url.search !== "") return jsonError(404, "not_found");

      if (url.pathname === MCP_ENDPOINT) return await transport.fetch(request);

      if (url.pathname === "/") {
        if (request.method !== "GET") return jsonError(405, "method_not_allowed", "GET");
        return await page(request);
      }
      if (url.pathname === "/admin.js") {
        if (request.method !== "GET") return jsonError(405, "method_not_allowed", "GET");
        return response(adminClientScript(), 200, "text/javascript; charset=utf-8");
      }
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") return jsonError(405, "method_not_allowed", "GET");
        return response(
          `${JSON.stringify({ status: "healthy", mode: "local_fixture" })}\n`,
          200,
          "application/json; charset=utf-8",
        );
      }

      const mutation = url.pathname === "/admin/test" ||
        url.pathname === "/admin/grant/revoke" ||
        url.pathname === "/admin/grant/reactivate";
      if (!mutation) return jsonError(404, "not_found");
      if (request.method !== "POST") return jsonError(405, "method_not_allowed", "POST");
      if (request.headers.get("Origin") !== url.origin) {
        return jsonError(403, "same_origin_required");
      }
      const values = await formValues(request);
      if (
        !values || values.get("csrf_token") !== csrfToken || [...values].length !== 1 ||
        [...values.keys()].some((key) => key !== "csrf_token")
      ) {
        return jsonError(403, "csrf_denied");
      }

      if (url.pathname === "/admin/grant/revoke") {
        await harness.revoke("grant");
        return await page(request, "Fixture grant revoked. MCP calls now fail closed.");
      }
      if (url.pathname === "/admin/grant/reactivate") {
        await harness.revokeAndReactivate("grant");
        return await page(request, "Fixture grant reactivated. MCP calls can run again.");
      }
      return await page(request, await fixtureInvocation(harness));
    },
  });
}

export function startLocalServer(app: LocalApp, port = DEFAULT_LOCAL_PORT): Deno.HttpServer {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("port denied");
  return Deno.serve({ hostname: LOCAL_HOST, port, onListen() {} }, (request) => app.fetch(request));
}
