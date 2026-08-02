import { assert, equals, rejects } from "../assert.ts";
import {
  MAX_MCP_BODY_BYTES,
  MCP_PROTOCOL_VERSION,
  StreamableHttpFixtureTransport,
} from "../../local/mcp_transport.ts";
import { createLocalApp, startLocalServer } from "../../local/server.ts";
import { createFixtureGatewayHarness } from "../../packages/mcp-bridge/mod.ts";

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
  assert(html.includes("Run Cairn and test the local fixture."));
  assert(html.includes("deno task local:run"));
  assert(html.includes("http://127.0.0.1:8787/mcp"));
  assert(html.includes("candidate pending named-client validation"));
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
    400,
  );
  equals(
    (await app.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: mcpHeaders("unknown-session"),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    )).status,
    404,
  );
  equals(
    (await app.fetch(
      new Request(endpoint, {
        method: "DELETE",
        headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION },
      }),
    )).status,
    400,
  );
  equals(
    (await app.fetch(
      new Request(endpoint, {
        method: "DELETE",
        headers: {
          "Mcp-Session-Id": "unknown-session",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
      }),
    )).status,
    404,
  );
});

Deno.test("expired fixture grant is visible and reactivation restores usable authority", async () => {
  const originalDateNow = Date.now;
  let uiNow = 1_000;
  Date.now = () => uiNow;
  try {
    const app = await createLocalApp();
    const origin = "http://127.0.0.1:8787";
    const activePage = await (await app.fetch(new Request(`${origin}/`))).text();
    assert(activePage.includes('<span class="status">active</span>'));
    const csrf = csrfFrom(activePage);
    uiNow += 24 * 60 * 60 * 1_000;
    const expiredPage = await (await app.fetch(new Request(`${origin}/`))).text();
    assert(expiredPage.includes('<span class="status">expired</span>'));
    const reactivatedPage = await (await app.fetch(
      new Request(`${origin}/admin/grant/reactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
        body: new URLSearchParams({ csrf_token: csrf }),
      }),
    )).text();
    assert(reactivatedPage.includes("Fixture grant reactivated"));
    assert(reactivatedPage.includes('<span class="status">active</span>'));
  } finally {
    Date.now = originalDateNow;
  }

  const harness = await createFixtureGatewayHarness();
  const request = new TextEncoder().encode(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
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
      clientInfo: { name: "expiry-test", version: "1" },
      capabilities: {},
    },
  }));
  await harness.setGrantLifetime(1);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await rejects(() => harness.dispatch(request), "grant denied");

  await harness.revokeAndReactivate("grant");
  equals(await harness.status("grant"), "active");
  const response = await harness.dispatch(request);
  equals(
    (response!.result as { structuredContent: { outcome: string } }).structuredContent.outcome,
    "success",
  );
});

Deno.test("session initialization and idle expiry recover capacity with isolated sessions", async () => {
  const harness = await createFixtureGatewayHarness();
  let now = 1_000;
  const transport = new StreamableHttpFixtureTransport(harness, {
    now: () => now,
    initializationTimeoutMs: 100,
    idleTimeoutMs: 200,
  });
  const endpoint = "http://127.0.0.1:8787/mcp";
  const initializeTransport = async (): Promise<string> => {
    const response = await transport.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: mcpHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "session-test", version: "1" },
          },
        }),
      }),
    );
    equals(response.status, 200);
    const id = response.headers.get("Mcp-Session-Id");
    assert(id);
    return id;
  };
  const post = async (session: string, body: unknown) => {
    return await transport.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: mcpHeaders(session),
        body: JSON.stringify(body),
      }),
    );
  };

  const abandoned: string[] = [];
  for (let index = 0; index < 16; index++) abandoned.push(await initializeTransport());
  const replacement = await initializeTransport();
  equals((await post(abandoned[0]!, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 404);
  equals((await post(replacement, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 200);

  now += 100;
  equals((await post(replacement, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status, 404);

  const first = await initializeTransport();
  const second = await initializeTransport();
  equals((await post(first, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const secondBeforeNotice = await post(second, { jsonrpc: "2.0", id: 4, method: "tools/list" });
  equals((await secondBeforeNotice.json()).error.message, "initialize notification required");
  equals((await post(first, { jsonrpc: "2.0", id: 5, method: "tools/list" })).status, 200);
  equals((await post(second, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  const deleted = await transport.fetch(
    new Request(endpoint, {
      method: "DELETE",
      headers: {
        "Mcp-Session-Id": first,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
    }),
  );
  equals(deleted.status, 204);
  equals((await post(second, { jsonrpc: "2.0", id: 6, method: "tools/list" })).status, 200);
  equals((await post(first, { jsonrpc: "2.0", id: 7, method: "tools/list" })).status, 404);

  now += 200;
  equals((await post(second, { jsonrpc: "2.0", id: 8, method: "tools/list" })).status, 404);
});

Deno.test("MCP and admin bodies stop at streaming limits", async () => {
  const app = await createLocalApp();
  const streamingBody = (limit: number) => {
    let cancelled = false;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(limit + 1));
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    return { stream, cancelled: () => cancelled };
  };

  const mcp = streamingBody(MAX_MCP_BODY_BYTES);
  const mcpResponse = await app.fetch(
    new Request("http://127.0.0.1:8787/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: mcp.stream,
    }),
  );
  equals(mcpResponse.status, 413);
  assert(mcp.cancelled());

  const form = streamingBody(2 * 1024);
  const formResponse = await app.fetch(
    new Request("http://127.0.0.1:8787/admin/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "http://127.0.0.1:8787",
      },
      body: form.stream,
    }),
  );
  equals(formResponse.status, 413);
  assert(form.cancelled());

  const mcpSource = await Deno.readTextFile("local/mcp_transport.ts");
  const serverSource = await Deno.readTextFile("local/server.ts");
  assert(!mcpSource.includes("request.arrayBuffer()"));
  assert(!serverSource.includes("request.arrayBuffer()"));
});
