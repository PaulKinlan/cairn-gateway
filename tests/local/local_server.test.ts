import { assert, equals } from "../assert.ts";
import { MCP_PROTOCOL_VERSION } from "../../local/mcp_transport.ts";
import { createLocalApp, startLocalServer } from "../../local/server.ts";

const mcpHeaders = (session?: string): Headers => {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (session) {
    headers.set("Mcp-Session-Id", session);
    headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
  }
  return headers;
};

async function initialize(origin: string): Promise<string> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "wire-test", version: "1" },
      },
    }),
  });
  equals(response.status, 200);
  equals(response.headers.get("content-type"), "application/json; charset=utf-8");
  const body = await response.json();
  equals(body.result.protocolVersion, MCP_PROTOCOL_VERSION);
  equals(body.result.capabilities, { tools: {} });
  const session = response.headers.get("Mcp-Session-Id");
  assert(session);
  return session;
}

async function mcpPost(origin: string, session: string, body: unknown): Promise<Response> {
  return await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(session),
    body: JSON.stringify(body),
  });
}

function csrfFrom(html: string): string {
  const token = html.match(/name="csrf_token" value="([a-f0-9]+)"/)?.[1];
  assert(token, "missing CSRF token");
  return token;
}

async function adminPost(origin: string, path: string, token: string): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
    },
    body: new URLSearchParams({ csrf_token: token }),
  });
}

Deno.test("local page leads with run/connect details and practical fixture controls", async () => {
  const app = await createLocalApp();
  const response = await app.fetch(new Request("http://127.0.0.1:8787/"));
  equals(response.status, 200);
  equals(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert(html.startsWith("<!DOCTYPE html>"));
  assert(html.includes('<html lang="en">'));
  assert(html.includes("Run Cairn, then connect VS Code."));
  assert(html.includes("deno task local:run"));
  assert(html.includes("http://127.0.0.1:8787/mcp"));
  assert(html.includes("&quot;type&quot;: &quot;http&quot;"));
  assert(html.includes("connection_a"));
  assert(html.includes("grant_a"));
  assert(html.includes("github.user.read@v1"));
  assert(html.includes('action="/admin/test" method="post"'));
  assert(html.includes('action="/admin/grant/revoke" method="post"'));
  assert(html.includes('action="/admin/grant/reactivate" method="post"'));
  assert(!html.includes("114 cases"));
  assert(!html.includes("architecture"));
});

Deno.test("admin mutations are POST-only, same-origin, and CSRF-protected", async () => {
  const app = await createLocalApp();
  const origin = "http://127.0.0.1:8787";
  const home = await (await app.fetch(new Request(`${origin}/`))).text();
  const token = csrfFrom(home);

  equals((await app.fetch(new Request(`${origin}/admin/grant/revoke`))).status, 405);
  equals(
    (await app.fetch(new Request(`${origin}/admin/grant/revoke`, { method: "POST" }))).status,
    403,
  );
  equals(
    (await app.fetch(
      new Request(`${origin}/admin/grant/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "http://localhost:8787",
        },
        body: new URLSearchParams({ csrf_token: token }),
      }),
    )).status,
    403,
  );
  equals(
    (await app.fetch(
      new Request(`${origin}/admin/grant/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
        body: new URLSearchParams({ csrf_token: "wrong" }),
      }),
    )).status,
    403,
  );

  const revoked = await app.fetch(
    new Request(`${origin}/admin/grant/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
      body: new URLSearchParams({ csrf_token: token }),
    }),
  );
  equals(revoked.status, 200);
  assert((await revoked.text()).includes("Fixture grant revoked"));
});

Deno.test("actual loopback listener completes MCP lifecycle and reflects revoke/reactivate", async () => {
  const app = await createLocalApp();
  const server = startLocalServer(app, 0);
  const address = server.addr as Deno.NetAddr;
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const session = await initialize(origin);
    const beforeNotice = await mcpPost(origin, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    equals((await beforeNotice.json()).error.message, "initialize notification required");

    const notice = await mcpPost(origin, session, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    equals(notice.status, 202);
    equals(await notice.text(), "");

    const list = await mcpPost(origin, session, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    equals(list.headers.get("content-type"), "application/json; charset=utf-8");
    const tools = (await list.json()).result.tools as Array<{ name: string }>;
    assert(tools.some((tool) => tool.name === "invoke_operation"));

    const call = {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "invoke_operation",
        arguments: {
          operation: "github.user.read@v1",
          connection: "connection_a",
          arguments: {},
        },
      },
    };
    const invoked = await mcpPost(origin, session, call);
    const invokedBody = await invoked.json();
    equals(invokedBody.result.structuredContent.user.login, "fixture");
    assert(invokedBody.result.content[0].text.includes('"login":"fixture"'));

    const page = await (await fetch(`${origin}/`)).text();
    const csrf = csrfFrom(page);
    const adminTest = await adminPost(origin, "/admin/test", csrf);
    assert((await adminTest.text()).includes("&quot;login&quot;: &quot;fixture&quot;"));
    const revoked = await adminPost(origin, "/admin/grant/revoke", csrf);
    assert((await revoked.text()).includes("Fixture grant revoked"));
    const denied = await mcpPost(origin, session, call);
    equals((await denied.json()).error.message, "fixture authority denied");

    const reactivated = await adminPost(origin, "/admin/grant/reactivate", csrf);
    assert((await reactivated.text()).includes("Fixture grant reactivated"));
    const invokedAgain = await mcpPost(origin, session, call);
    equals((await invokedAgain.json()).result.structuredContent.user.login, "fixture");

    const ended = await fetch(`${origin}/mcp`, {
      method: "DELETE",
      headers: {
        "Mcp-Session-Id": session,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
    });
    equals(ended.status, 204);
    equals((await mcpPost(origin, session, call)).status, 404);
  } finally {
    await server.shutdown();
  }
});

Deno.test("Streamable HTTP content negotiation, host, and session headers fail closed", async () => {
  const app = await createLocalApp();
  const endpoint = "http://127.0.0.1:8787/mcp";
  equals((await app.fetch(new Request(endpoint))).status, 405);
  equals((await app.fetch(new Request("http://example.test/mcp"))).status, 403);
  equals(
    (await app.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Accept: "application/json, text/event-stream" },
        body: "{}",
      }),
    )).status,
    415,
  );
  equals(
    (await app.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      }),
    )).status,
    406,
  );
  equals(
    (await app.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: mcpHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    )).status,
    404,
  );
});
