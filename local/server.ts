import { BodyTooLargeError, readBoundedBody } from "./bounded_body.ts";
import { createLocalFixtureController, type LocalFixtureController } from "./fixture_controller.ts";
import { MCP_ENDPOINT, StreamableHttpFixtureTransport } from "./mcp_transport.ts";
import { adminClientScript, renderAdminPage } from "./ui.ts";

export const LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_PORT = 8787;
const MAX_FORM_BYTES = 2 * 1024;
const MAX_ADMIN_SESSIONS = 8;
const ADMIN_SESSION_IDLE_MS = 30 * 60 * 1_000;
const SESSION_COOKIE = "cairn_local_session";
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
interface AdminSession {
  id: string;
  csrfToken: string;
  lastSeen: number;
}

function response(
  body: BodyInit | null,
  status: number,
  contentType?: string,
  allow?: string,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
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

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

function narrowNullFormNavigation(request: Request, url: URL): boolean {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  return isLoopback(url) && request.method === "POST" &&
    request.headers.get("Origin") === "null" &&
    request.headers.get("Sec-Fetch-Site") === "same-origin" &&
    request.headers.get("Sec-Fetch-Mode") === "navigate" &&
    request.headers.get("Sec-Fetch-Dest") === "document" &&
    contentType === "application/x-www-form-urlencoded";
}

function browserFormNavigation(request: Request): boolean {
  return request.headers.get("Accept")?.toLowerCase().includes("text/html") === true ||
    (request.headers.get("Sec-Fetch-Mode") === "navigate" &&
      request.headers.get("Sec-Fetch-Dest") === "document");
}

async function formValues(request: Request): Promise<URLSearchParams | undefined> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return undefined;
  const bytes = await readBoundedBody(request, MAX_FORM_BYTES);
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("Cookie");
  if (!cookie || cookie.length > 2_048) return undefined;
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name && rest.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(rest[0] ?? "")) {
      return rest[0];
    }
  }
  return undefined;
}

function sessionCookie(session: AdminSession): string {
  return `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/`;
}

function exactForm(values: URLSearchParams, fields: readonly string[]): boolean {
  const allowed = new Set(["csrf_token", ...fields]);
  const keys = [...values.keys()];
  return keys.length === fields.length + 1 && keys.every((key) => allowed.has(key)) &&
    [...allowed].every((key) => values.getAll(key).length === 1);
}

function projectedResult(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Invocation denied.";
  const result = (value as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return "Invocation denied.";
  const structured = (result as Record<string, unknown>).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    return "Invocation denied.";
  }
  return JSON.stringify(structured, null, 2);
}

function fixtureInvokeRequest(): Uint8Array {
  return encoder.encode(JSON.stringify({
    jsonrpc: "2.0",
    id: "admin-invoke",
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
  }));
}

async function fixtureInvocation(controller: LocalFixtureController): Promise<string> {
  const started = performance.now();
  try {
    return projectedResult(
      await controller.dispatch(fixtureInvokeRequest(), "/mcp", "local_admin"),
    );
  } catch {
    const elapsed = Math.max(0, performance.now() - started).toFixed(1);
    return `Invocation denied locally in ${elapsed} ms. The active authority check failed closed.`;
  }
}

export function createLocalApp(): LocalApp {
  const controller = createLocalFixtureController();
  const transport = new StreamableHttpFixtureTransport(controller);
  const sessions = new Map<string, AdminSession>();

  const now = (): number => {
    const value = Date.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("local session clock denied");
    return value;
  };
  const purgeSessions = (): void => {
    const at = now();
    for (const [id, session] of sessions) {
      if (at - session.lastSeen >= ADMIN_SESSION_IDLE_MS) sessions.delete(id);
    }
  };
  const newSession = (): AdminSession => {
    purgeSessions();
    if (sessions.size >= MAX_ADMIN_SESSIONS) {
      let oldest: AdminSession | undefined;
      for (const session of sessions.values()) {
        if (!oldest || session.lastSeen < oldest.lastSeen) oldest = session;
      }
      if (oldest) sessions.delete(oldest.id);
    }
    const at = now();
    const session = {
      id: crypto.randomUUID().replaceAll("-", ""),
      csrfToken: crypto.randomUUID().replaceAll("-", ""),
      lastSeen: at,
    };
    sessions.set(session.id, session);
    return session;
  };
  const requestSession = (request: Request): AdminSession | undefined => {
    purgeSessions();
    const id = cookieValue(request, SESSION_COOKIE);
    const session = id ? sessions.get(id) : undefined;
    if (session) session.lastSeen = now();
    return session;
  };
  const page = (
    request: Request,
    session: AdminSession,
    notice?: string,
    result?: string,
    status = 200,
  ): Response => {
    const html = renderAdminPage({
      origin: new URL(request.url).origin,
      csrfToken: session.csrfToken,
      fixture: controller.view(),
      ...(notice === undefined ? {} : { notice }),
      ...(result === undefined ? {} : { result }),
    });
    return response(html, status, "text/html; charset=utf-8", undefined, {
      "Set-Cookie": sessionCookie(session),
    });
  };

  const formFailure = (
    request: Request,
    status: number,
    error: string,
    notice: string,
    session?: AdminSession,
  ): Response => {
    if (!browserFormNavigation(request)) return jsonError(status, error);
    return page(request, session ?? newSession(), notice, undefined, status);
  };

  const mutations = new Map<string, readonly string[]>([
    ["/admin/owner/create", []],
    ["/admin/owner/reset", []],
    ["/admin/agent/create", ["agent_name"]],
    ["/admin/identity/enroll", ["device_name", "workload_name"]],
    ["/admin/grant/create", []],
    ["/admin/grant/revoke", []],
    ["/admin/grant/reactivate", []],
    ["/admin/invoke", []],
  ]);

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (!isLoopback(url)) return jsonError(403, "origin_denied");
      if (url.search !== "") return jsonError(404, "not_found");

      if (url.pathname === MCP_ENDPOINT) return await transport.fetch(request);
      const origin = request.headers.get("Origin");
      if (origin !== null && origin !== url.origin && !narrowNullFormNavigation(request, url)) {
        return jsonError(403, "origin_denied");
      }

      if (url.pathname === "/") {
        if (request.method !== "GET") return jsonError(405, "method_not_allowed", "GET");
        return page(request, requestSession(request) ?? newSession());
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

      const fields = mutations.get(url.pathname);
      if (!fields) return jsonError(404, "not_found");
      if (request.method !== "POST") return jsonError(405, "method_not_allowed", "POST");
      const mutationOriginAllowed = origin === url.origin || narrowNullFormNavigation(request, url);
      if (!mutationOriginAllowed) return jsonError(403, "same_origin_required");
      const session = requestSession(request);
      if (!session) {
        return formFailure(
          request,
          401,
          "admin_session_required",
          "Your local admin session expired. A new session is ready; repeat the action.",
        );
      }

      let values: URLSearchParams | undefined;
      try {
        values = await formValues(request);
      } catch (error) {
        if (error instanceof BodyTooLargeError) return jsonError(413, "request_too_large");
        return formFailure(
          request,
          400,
          "invalid_request_body",
          "The form could not be read. Reload the page and try again.",
          session,
        );
      }
      if (
        !values || !exactForm(values, fields) || values.get("csrf_token") !== session.csrfToken
      ) {
        return formFailure(
          request,
          403,
          "csrf_denied",
          "This form is stale. Use the updated controls below to repeat the action.",
          session,
        );
      }

      try {
        let notice: string;
        let result: string | undefined;
        switch (url.pathname) {
          case "/admin/owner/create":
            await controller.createOwner();
            notice = "Fixture owner created. Add an agent label next.";
            break;
          case "/admin/owner/reset":
            await controller.resetOwner();
            notice = "Fixture owner reset. Previous authority and receipts are gone.";
            break;
          case "/admin/agent/create":
            await controller.createAgent(values.get("agent_name") ?? "");
            notice = "Agent label saved. Add device and workload labels next.";
            break;
          case "/admin/identity/enroll":
            await controller.enrollIdentity(
              values.get("device_name") ?? "",
              values.get("workload_name") ?? "",
            );
            notice = "Fixture identity labels saved. Create the grant next.";
            break;
          case "/admin/grant/create":
            await controller.createGrant();
            notice = "Grant created. It is active for 24 hours and up to 5 calls.";
            break;
          case "/admin/grant/revoke":
            await controller.revokeGrant();
            notice = "Grant revoked. Test a denied call before creating a replacement.";
            break;
          case "/admin/grant/reactivate":
            await controller.reactivateGrant();
            notice = "Replacement grant created with a new version and expiry.";
            break;
          case "/admin/invoke":
            result = await fixtureInvocation(controller);
            notice = "Invocation finished. The receipt and usage entry are below.";
            break;
          default:
            throw new Error("route denied");
        }
        session.csrfToken = crypto.randomUUID().replaceAll("-", "");
        return page(request, session, notice, result);
      } catch {
        return page(
          request,
          session,
          "That action is not valid yet. Complete the steps in order and avoid duplicate enrollment.",
          undefined,
          409,
        );
      }
    },
  });
}

export function startLocalServer(app: LocalApp, port = DEFAULT_LOCAL_PORT): Deno.HttpServer {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("port denied");
  return Deno.serve({ hostname: LOCAL_HOST, port, onListen() {} }, (request) => app.fetch(request));
}
