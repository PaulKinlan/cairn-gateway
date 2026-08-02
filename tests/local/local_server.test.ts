import { assert, equals, rejects } from "../assert.ts";
import {
  MAX_MCP_BODY_BYTES,
  MCP_PROTOCOL_VERSION,
  StreamableHttpFixtureTransport,
} from "../../local/mcp_transport.ts";
import { createLocalApp, startLocalServer } from "../../local/server.ts";
import { createLocalFixtureController } from "../../local/fixture_controller.ts";
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
  const notice = await mcpPost(origin, session, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  equals(notice.status, 202);
  return session;
}

async function mcpPost(origin: string, session: string, body: unknown): Promise<Response> {
  return await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: mcpHeaders(session),
    body: JSON.stringify(body),
  });
}

async function toolCall(
  origin: string,
  session: string,
  id: number,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  return await (await mcpPost(origin, session, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  })).json();
}

function csrfFrom(html: string): string {
  const token = html.match(/name="csrf_token" value="([a-f0-9]+)"/)?.[1];
  assert(token, "missing CSRF token");
  return token;
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "missing admin session cookie");
  return cookie;
}

interface AdminBrowser {
  cookie: string;
  html: string;
}

async function openAdmin(origin: string): Promise<AdminBrowser> {
  const response = await fetch(`${origin}/`);
  return { cookie: cookieFrom(response), html: await response.text() };
}

async function adminPost(
  origin: string,
  browser: AdminBrowser,
  path: string,
  fields: Record<string, string> = {},
  token = csrfFrom(browser.html),
): Promise<Response> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: browser.cookie,
      Origin: origin,
    },
    body: new URLSearchParams({ csrf_token: token, ...fields }),
  });
  if (response.headers.get("content-type")?.startsWith("text/html")) {
    browser.html = await response.clone().text();
  }
  return response;
}

async function labelFixture(origin: string, browser: AdminBrowser): Promise<void> {
  equals((await adminPost(origin, browser, "/admin/owner/create")).status, 200);
  equals(
    (await adminPost(origin, browser, "/admin/agent/create", { agent_name: "Research agent" }))
      .status,
    200,
  );
  equals(
    (await adminPost(origin, browser, "/admin/identity/enroll", {
      device_name: "Local laptop",
      workload_name: "Local worker",
    })).status,
    200,
  );
}

async function onboard(origin: string, browser: AdminBrowser): Promise<void> {
  await labelFixture(origin, browser);
  equals((await adminPost(origin, browser, "/admin/grant/create")).status, 200);
}

const invocationArgs = {
  operation: "github.user.read@v1",
  connection: "connection_a",
  arguments: {},
};
const fixtureInvokeRequest = (id: string | number = "test-invoke"): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "invoke_operation", arguments: invocationArgs },
    _meta: {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "local-test", version: "1" },
      capabilities: {},
    },
  }));

async function readyController() {
  const controller = createLocalFixtureController();
  await controller.createOwner();
  await controller.createAgent("Race agent");
  await controller.enrollIdentity("Race device", "Race workload");
  return controller;
}

Deno.test("local page presents ordered onboarding, authority, grant, receipts, and candidate copy", async () => {
  const app = await createLocalApp();
  const response = await app.fetch(new Request("http://127.0.0.1:8787/"));
  equals(response.status, 200);
  equals(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert(response.headers.get("set-cookie")?.includes("HttpOnly"));
  assert(response.headers.get("set-cookie")?.includes("SameSite=Strict"));
  const html = await response.text();
  assert(html.startsWith("<!DOCTYPE html>"));
  assert(html.includes('<html lang="en">'));
  assert(html.includes("Create authority. Test it. Revoke it."));
  assert(html.includes('action="/admin/owner/create" method="post"'));
  assert(html.includes("Authority graph"));
  assert(html.includes("Invocation receipts"));
  assert(html.includes("Recent usage"));
  assert(html.includes("VS Code candidate, not yet tested"));
  assert(html.includes("Wire sequence"));
  assert(html.includes("Reconnect by initializing a new session"));
  assert(!html.includes("Wire evidence is not VS Code acceptance"));
  assert(!html.includes("114 cases"));
  assert(!html.includes("PROVIDER_TOKEN"));
});

Deno.test("admin mutations reject unauthorized, cross-origin, stale CSRF, and extra fields", async () => {
  const app = await createLocalApp();
  const server = startLocalServer(app, 0);
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const browser = await openAdmin(origin);
    const firstToken = csrfFrom(browser.html);
    const noSession = await fetch(`${origin}/admin/owner/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
      },
      body: new URLSearchParams({ csrf_token: firstToken }),
    });
    equals(noSession.status, 401);
    equals(
      (await fetch(`${origin}/admin/owner/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: browser.cookie,
          Origin: "http://localhost:8787",
        },
        body: new URLSearchParams({ csrf_token: firstToken }),
      })).status,
      403,
    );
    equals((await adminPost(origin, browser, "/admin/owner/create")).status, 200);
    assert(csrfFrom(browser.html) !== firstToken);
    equals(
      (await adminPost(origin, browser, "/admin/agent/create", {
        agent_name: "Agent",
      }, firstToken)).status,
      403,
    );
    equals(
      (await adminPost(origin, browser, "/admin/agent/create", {
        agent_name: "Agent",
        extra: "denied",
      })).status,
      403,
    );
    equals((await fetch(`${origin}/admin/owner/reset`)).status, 405);
  } finally {
    await server.shutdown();
  }
});

Deno.test("Chrome null-origin form navigation is accepted only with exact same-origin metadata", async () => {
  const app = createLocalApp();
  const origin = "http://127.0.0.1:8787";
  const home = await app.fetch(new Request(`${origin}/`));
  const cookie = cookieFrom(home);
  const token = csrfFrom(await home.text());
  const form = (site: string, mode = "navigate", destination = "document") =>
    new Request(`${origin}/admin/owner/create`, {
      method: "POST",
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        Origin: "null",
        "Sec-Fetch-Site": site,
        "Sec-Fetch-Mode": mode,
        "Sec-Fetch-Dest": destination,
      },
      body: new URLSearchParams({ csrf_token: token }),
    });
  const accepted = await app.fetch(form("same-origin"));
  equals(accepted.status, 200);
  assert((await accepted.text()).includes("Owner ready"));

  const other = createLocalApp();
  const otherHome = await other.fetch(new Request(`${origin}/`));
  const otherCookie = cookieFrom(otherHome);
  const otherToken = csrfFrom(await otherHome.text());
  const denied = async (site: string, mode = "navigate", destination = "document") =>
    await other.fetch(
      new Request(`${origin}/admin/owner/create`, {
        method: "POST",
        headers: {
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: otherCookie,
          Origin: "null",
          "Sec-Fetch-Site": site,
          "Sec-Fetch-Mode": mode,
          "Sec-Fetch-Dest": destination,
        },
        body: new URLSearchParams({ csrf_token: otherToken }),
      }),
    );
  equals((await denied("cross-site")).status, 403);
  equals((await denied("same-origin", "cors")).status, 403);
  equals((await denied("same-origin", "navigate", "empty")).status, 403);
});

Deno.test("browser form failures render recovery pages while API-like failures stay JSON", async () => {
  const app = createLocalApp();
  const origin = "http://127.0.0.1:8787";
  const home = await app.fetch(new Request(`${origin}/`));
  const cookie = cookieFrom(home);
  const html = await home.text();
  const stale = await app.fetch(
    new Request(`${origin}/admin/owner/create`, {
      method: "POST",
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        Origin: origin,
      },
      body: new URLSearchParams({ csrf_token: `${csrfFrom(html)}stale` }),
    }),
  );
  equals(stale.status, 403);
  equals(stale.headers.get("content-type"), "text/html; charset=utf-8");
  const stalePage = await stale.text();
  assert(stalePage.includes("This form is stale"));
  assert(stalePage.includes("Create fixture owner"));

  const api = await app.fetch(
    new Request(`${origin}/admin/owner/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        Origin: origin,
      },
      body: new URLSearchParams({ csrf_token: "wrong" }),
    }),
  );
  equals(api.status, 403);
  equals(api.headers.get("content-type"), "application/json; charset=utf-8");
  equals(await api.json(), { error: "csrf_denied" });
});

Deno.test("admin idle expiry returns a browser recovery page with a fresh session", async () => {
  const original = Date.now;
  let current = original();
  Date.now = () => current;
  try {
    const app = createLocalApp();
    const origin = "http://127.0.0.1:8787";
    const home = await app.fetch(new Request(`${origin}/`));
    const cookie = cookieFrom(home);
    const token = csrfFrom(await home.text());
    current += 30 * 60 * 1_000;
    const expired = await app.fetch(
      new Request(`${origin}/admin/owner/create`, {
        method: "POST",
        headers: {
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookie,
          Origin: origin,
        },
        body: new URLSearchParams({ csrf_token: token }),
      }),
    );
    equals(expired.status, 401);
    assert(cookieFrom(expired) !== cookie);
    const page = await expired.text();
    assert(page.includes("session expired"));
    assert(page.includes("repeat the action"));
  } finally {
    Date.now = original;
  }
});

Deno.test("admin sessions isolate CSRF while sharing only the one local fixture authority", async () => {
  const app = await createLocalApp();
  const server = startLocalServer(app, 0);
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const first = await openAdmin(origin);
    const second = await openAdmin(origin);
    const secondToken = csrfFrom(second.html);
    equals((await adminPost(origin, first, "/admin/owner/create", {}, secondToken)).status, 403);
    equals((await adminPost(origin, first, "/admin/owner/create")).status, 200);
    const secondPage = await fetch(`${origin}/`, { headers: { Cookie: second.cookie } });
    second.html = await secondPage.text();
    assert(second.html.includes("Owner ready"));
    equals(
      (await adminPost(origin, second, "/admin/agent/create", {
        agent_name: "Shared local agent",
      })).status,
      200,
    );
    const firstPage = await fetch(`${origin}/`, { headers: { Cookie: first.cookie } });
    first.html = await firstPage.text();
    assert(first.html.includes("Shared local agent"));
  } finally {
    await server.shutdown();
  }
});

Deno.test("admin session capacity evicts the least-recently-used session", async () => {
  const app = createLocalApp();
  const server = startLocalServer(app, 0);
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const browsers: AdminBrowser[] = [];
    for (let index = 0; index < 9; index++) browsers.push(await openAdmin(origin));
    equals((await adminPost(origin, browsers[0]!, "/admin/owner/create")).status, 401);
    equals((await adminPost(origin, browsers[8]!, "/admin/owner/create")).status, 200);
  } finally {
    await server.shutdown();
  }
});

Deno.test("fixture controller rejects invalid lifecycle order and duplicate enrollment", async () => {
  const controller = createLocalFixtureController();
  await rejects(() => controller.createAgent("Early agent"), "lifecycle");
  await rejects(() => controller.enrollIdentity("Device", "Worker"), "lifecycle");
  await rejects(() => controller.createGrant(), "lifecycle");
  await controller.createOwner();
  await rejects(() => controller.createOwner(), "already exists");
  await controller.createAgent("Research agent");
  await rejects(() => controller.createAgent("Duplicate agent"), "lifecycle");
  await rejects(
    () => controller.enrollIdentity("Research agent", "Worker"),
    "distinct",
  );
  await controller.enrollIdentity("Laptop", "Worker");
  await rejects(() => controller.enrollIdentity("Other laptop", "Other worker"), "lifecycle");
  await controller.createGrant();
  await rejects(() => controller.createGrant(), "lifecycle");
});

Deno.test("controller serializes createGrant/reset and concurrent duplicate grant creation", async () => {
  const resetRace = await readyController();
  const createThenReset = await Promise.allSettled([
    resetRace.createGrant(),
    resetRace.resetOwner(),
  ]);
  equals(createThenReset.filter((result) => result.status === "fulfilled").length, 2);
  const resetView = resetRace.view();
  equals(resetView.owner, "missing");
  equals(resetView.grant, undefined);
  equals(resetView.receipts, []);
  equals(resetView.usage, []);
  equals(resetView.audit, []);
  await rejects(() => resetRace.dispatch(fixtureInvokeRequest()), "authority denied");
  equals(resetRace.view().receipts, []);

  const duplicate = await readyController();
  const duplicateResults = await Promise.allSettled([
    duplicate.createGrant(),
    duplicate.createGrant(),
  ]);
  equals(duplicateResults.filter((result) => result.status === "fulfilled").length, 1);
  equals(duplicateResults.filter((result) => result.status === "rejected").length, 1);
  equals(duplicate.view().grant?.version, 1);
});

Deno.test("controller serializes invoke/reset and revoke/invoke without post-reset state", async () => {
  const invokeReset = await readyController();
  await invokeReset.createGrant();
  await Promise.allSettled([
    invokeReset.dispatch(fixtureInvokeRequest("invoke-reset")),
    invokeReset.resetOwner(),
  ]);
  const resetView = invokeReset.view();
  equals(resetView.owner, "missing");
  equals(resetView.grant, undefined);
  equals(resetView.receipts, []);
  equals(resetView.usage, []);
  await rejects(
    () => invokeReset.dispatch(fixtureInvokeRequest("after-reset")),
    "authority denied",
  );
  equals(invokeReset.view().receipts, []);

  const revokeFirst = await readyController();
  await revokeFirst.createGrant();
  const results = await Promise.allSettled([
    revokeFirst.revokeGrant(),
    revokeFirst.dispatch(fixtureInvokeRequest("revoke-invoke")),
  ]);
  equals(results[0]?.status, "fulfilled");
  equals(results[1]?.status, "rejected");
  const revoked = revokeFirst.view();
  equals(revoked.grant?.status, "revoked");
  equals(revoked.receipts[0]?.reason, "grant_inactive");
  equals(revoked.receipts[0]?.grantVersion, 2);
  assert(revoked.receipts.every((receipt) => receipt.grantVersion > 0));
  equals(revoked.audit[0]?.event, "grant_revoked");
});

Deno.test("removing fixture identity labels invalidates the mapped MCP authority", async () => {
  const controller = await readyController();
  await controller.createGrant();
  const allowed = await controller.dispatch(fixtureInvokeRequest("before-remove"));
  assert(allowed && "result" in allowed);
  await controller.resetOwner();
  const view = controller.view();
  equals(view.agent, undefined);
  equals(view.identity, undefined);
  equals(view.grant, undefined);
  await rejects(
    () => controller.dispatch(fixtureInvokeRequest("after-remove")),
    "authority denied",
  );
  equals(controller.view().receipts, []);
});

Deno.test("receipts are sanitized and receipt and usage histories stay bounded", async () => {
  const controller = createLocalFixtureController();
  await controller.createOwner();
  await controller.createAgent("Bounded agent");
  await controller.enrollIdentity("Bounded device", "Bounded worker");
  await controller.createGrant();
  for (let index = 0; index < 12; index++) {
    try {
      await controller.dispatch(fixtureInvokeRequest(index), "/mcp", "mcp");
    } catch {
      // The fixed five-call limit intentionally creates bounded denial receipts.
    }
  }
  const view = controller.view();
  equals(view.receipts.length, 8);
  equals(view.usage.length, 8);
  equals(view.grant?.used, 5);
  equals(view.grant?.status, "exhausted");
  for (const receipt of view.receipts) {
    equals(Object.keys(receipt).sort(), [
      "at",
      "decision",
      "grantVersion",
      "id",
      "operation",
      "reason",
      "requestUnits",
      "source",
    ]);
    assert(receipt.id.length <= 16);
    assert(receipt.requestUnits === 0 || receipt.requestUnits === 1);
  }
  const serialized = JSON.stringify(view).toLowerCase();
  for (
    const forbidden of [
      "proof",
      "capability",
      "signer",
      "custody",
      "privatejwk",
      "access_token",
      "provider_token",
      "store",
      "connection_a",
      "grant_a",
    ]
  ) assert(!serialized.includes(forbidden), `receipt view exposed ${forbidden}`);
});

Deno.test("local admin invocation shows a projected result, receipt, and usage", async () => {
  const app = createLocalApp();
  const server = startLocalServer(app, 0);
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const browser = await openAdmin(origin);
    await onboard(origin, browser);
    const response = await adminPost(origin, browser, "/admin/invoke");
    equals(response.status, 200);
    assert(browser.html.includes("Projected result"));
    assert(browser.html.includes("&quot;login&quot;: &quot;fixture&quot;"));
    assert(browser.html.includes("Local admin"));
    assert(browser.html.includes("policy_allow"));
    assert(browser.html.includes("1 of 5"));
    for (const forbidden of ["capability", "signer", "access_token", "PROVIDER_TOKEN"]) {
      assert(!browser.html.includes(forbidden));
    }
  } finally {
    await server.shutdown();
  }
});

Deno.test("expired grant is displayed and a denied call records the expired version", async () => {
  const original = Date.now;
  let current = original();
  Date.now = () => current;
  const app = createLocalApp();
  const server = startLocalServer(app, 0);
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const browser = await openAdmin(origin);
    await onboard(origin, browser);
    current += 24 * 60 * 60 * 1_000;
    const refreshed = await fetch(`${origin}/`, { headers: { Cookie: browser.cookie } });
    browser.cookie = cookieFrom(refreshed);
    browser.html = await refreshed.text();
    assert(browser.html.includes('<span class="status">expired</span>'));
    assert(browser.html.includes("Test denied call"));
    const denied = await adminPost(origin, browser, "/admin/invoke");
    equals(denied.status, 200);
    assert(browser.html.includes("grant_expired"));
    assert(browser.html.includes("Invocation denied locally in"));
    assert(browser.html.includes("Grant version</th>"));
  } finally {
    Date.now = original;
    await server.shutdown();
  }
});

Deno.test("revocation and replacement create a new version, expiry, and usable limit", async () => {
  const controller = createLocalFixtureController();
  await controller.createOwner();
  await controller.createAgent("Lifecycle agent");
  await controller.enrollIdentity("Lifecycle device", "Lifecycle worker");
  await controller.createGrant();
  const initial = controller.view().grant!;
  equals(initial.version, 1);
  equals(initial.usageLimit, 5);
  await controller.revokeGrant();
  const revoked = controller.view().grant!;
  equals(revoked.status, "revoked");
  equals(revoked.version, 2);
  equals(controller.view().audit[0]?.event, "grant_revoked");
  await rejects(() => controller.dispatch(fixtureInvokeRequest()), "authority denied");
  equals(controller.view().receipts[0]?.reason, "grant_inactive");
  equals(controller.view().receipts[0]?.grantVersion, 2);
  await controller.reactivateGrant();
  const replacement = controller.view().grant!;
  equals(replacement.status, "active");
  equals(replacement.version, 4);
  assert(replacement.expiresAt > initial.expiresAt);
  equals(replacement.used, 0);
  equals(controller.view().audit[0]?.event, "grant_replaced");
  const response = await controller.dispatch(fixtureInvokeRequest());
  const structured = ((response!.result as Record<string, unknown>).structuredContent) as Record<
    string,
    unknown
  >;
  equals((structured.user as Record<string, unknown>).login, "fixture");
});

Deno.test("actual listener completes all four tools, visible receipt, revoke, replacement, and reconnect", async () => {
  const app = await createLocalApp();
  const server = startLocalServer(app, 0);
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const browser = await openAdmin(origin);
    await onboard(origin, browser);
    assert(browser.html.includes("Version</dt><dd>1</dd>"));
    assert(browser.html.includes("0 of 5"));
    assert(
      browser.html.indexOf("Invoke fixture operation") <
        browser.html.indexOf("Reset fixture owner"),
    );

    const first = await initialize(origin);
    const search = await toolCall(origin, first, 2, "search_capabilities", {
      query: "github user",
    });
    equals(
      (((search.result as Record<string, unknown>).structuredContent as Record<string, unknown>)
        .operations as Array<Record<string, unknown>>)[0]?.id,
      "github.user.read@v1",
    );
    const described = await toolCall(origin, first, 3, "describe_operation", {
      operation: "github.user.read@v1",
    });
    equals(
      ((described.result as Record<string, unknown>).structuredContent as Record<string, unknown>)
        .provider,
      "github",
    );
    const status = await toolCall(origin, first, 4, "connection_status", {
      connection: "connection_a",
    });
    equals(
      ((status.result as Record<string, unknown>).structuredContent as Record<string, unknown>)
        .status,
      "active",
    );
    const invoked = await toolCall(origin, first, 5, "invoke_operation", invocationArgs);
    equals(
      (((invoked.result as Record<string, unknown>).structuredContent as Record<string, unknown>)
        .user as Record<string, unknown>).login,
      "fixture",
    );

    browser.html = await (await fetch(`${origin}/`, { headers: { Cookie: browser.cookie } }))
      .text();
    assert(browser.html.includes("policy_allow"));
    assert(browser.html.includes("MCP"));
    assert(browser.html.includes("1 of 5"));

    equals((await adminPost(origin, browser, "/admin/grant/revoke")).status, 200);
    assert(browser.html.includes("Grant revoked"));
    assert(browser.html.includes("Test denied call"));
    assert(
      browser.html.indexOf("Test denied call") < browser.html.indexOf("Create replacement grant"),
    );
    const denialStarted = performance.now();
    equals((await adminPost(origin, browser, "/admin/invoke")).status, 200);
    const denialLatencyMs = performance.now() - denialStarted;
    assert(denialLatencyMs < 1_000, `local denial took ${denialLatencyMs}ms`);
    assert(browser.html.includes("grant_inactive"));
    assert(browser.html.includes("Invocation denied locally in"));
    assert(browser.html.includes("Grant audit"));
    for (
      const [id, name, args] of [
        [6, "search_capabilities", { query: "github" }],
        [7, "describe_operation", { operation: "github.user.read@v1" }],
        [8, "connection_status", { connection: "connection_a" }],
        [9, "invoke_operation", invocationArgs],
      ] as const
    ) {
      const denial = await toolCall(origin, first, id, name, args);
      equals((denial.error as Record<string, unknown>).message, "fixture authority denied");
    }

    const revokedExpiry = browser.html.match(/datetime="([^"]+)"/)?.[1];
    equals((await adminPost(origin, browser, "/admin/grant/reactivate")).status, 200);
    assert(browser.html.includes("Version</dt><dd>4</dd>"));
    const replacementExpiry = browser.html.match(/datetime="([^"]+)"/)?.[1];
    assert(revokedExpiry && replacementExpiry && replacementExpiry > revokedExpiry);
    equals(
      (((await toolCall(origin, first, 10, "invoke_operation", invocationArgs)).result as Record<
        string,
        unknown
      >).structuredContent as Record<string, unknown>).outcome,
      "success",
    );

    const second = await initialize(origin);
    equals(
      (((await toolCall(origin, second, 11, "invoke_operation", invocationArgs)).result as Record<
        string,
        unknown
      >).structuredContent as Record<string, unknown>).outcome,
      "success",
    );
    const deleted = await fetch(`${origin}/mcp`, {
      method: "DELETE",
      headers: {
        "Mcp-Session-Id": first,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
    });
    equals(deleted.status, 204);
    equals((await mcpPost(origin, first, { jsonrpc: "2.0", id: 12, method: "ping" })).status, 404);
    equals(
      (await mcpPost(origin, second, { jsonrpc: "2.0", id: 13, method: "ping" })).status,
      200,
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("actual listener serializes grant/reset, duplicate grant, invoke/reset, and revoke/invoke races", async () => {
  const app = createLocalApp();
  const server = startLocalServer(app, 0);
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const browser = await openAdmin(origin);
    const refresh = async () => {
      browser.html = await (await fetch(`${origin}/`, { headers: { Cookie: browser.cookie } }))
        .text();
    };
    const rawAdmin = async (path: string, token: string) => {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: browser.cookie,
          Origin: origin,
        },
        body: new URLSearchParams({ csrf_token: token }),
      });
      await response.text();
      return response.status;
    };

    await labelFixture(origin, browser);
    const duplicateToken = csrfFrom(browser.html);
    const duplicateStatuses = await Promise.all([
      rawAdmin("/admin/grant/create", duplicateToken),
      rawAdmin("/admin/grant/create", duplicateToken),
    ]);
    equals([...duplicateStatuses].sort(), [200, 409]);
    await refresh();
    assert(browser.html.includes("Version</dt><dd>1</dd>"));
    equals((await adminPost(origin, browser, "/admin/owner/reset")).status, 200);

    await labelFixture(origin, browser);
    const createResetToken = csrfFrom(browser.html);
    await Promise.all([
      rawAdmin("/admin/grant/create", createResetToken),
      rawAdmin("/admin/owner/reset", createResetToken),
    ]);
    await refresh();
    assert(browser.html.includes("Create fixture owner"));
    assert(!browser.html.includes("Version</dt><dd>1</dd>"));

    await onboard(origin, browser);
    const invokeResetSession = await initialize(origin);
    const invokeResetToken = csrfFrom(browser.html);
    await Promise.allSettled([
      toolCall(origin, invokeResetSession, 30, "invoke_operation", invocationArgs),
      rawAdmin("/admin/owner/reset", invokeResetToken),
    ]);
    await refresh();
    assert(browser.html.includes("Create fixture owner"));
    assert(browser.html.includes("No invocation receipts yet"));
    assert(browser.html.includes("No usage yet"));
    const postReset = await toolCall(
      origin,
      invokeResetSession,
      31,
      "invoke_operation",
      invocationArgs,
    );
    equals((postReset.error as Record<string, unknown>).message, "fixture authority denied");
    await refresh();
    assert(browser.html.includes("No invocation receipts yet"));

    await onboard(origin, browser);
    const revokeSession = await initialize(origin);
    const revokeToken = csrfFrom(browser.html);
    await Promise.allSettled([
      rawAdmin("/admin/grant/revoke", revokeToken),
      toolCall(origin, revokeSession, 32, "invoke_operation", invocationArgs),
    ]);
    await refresh();
    assert(browser.html.includes('<span class="status">revoked</span>'));
    assert(browser.html.includes("Grant revoked"));
    assert(!browser.html.includes('grantVersion": 0'));
    const afterRevoke = await toolCall(
      origin,
      revokeSession,
      33,
      "invoke_operation",
      invocationArgs,
    );
    equals((afterRevoke.error as Record<string, unknown>).message, "fixture authority denied");
  } finally {
    await server.shutdown();
  }
});

Deno.test("Streamable HTTP host, negotiation, lifecycle, and unrelated sessions fail closed", async () => {
  const controller = createLocalFixtureController();
  const transport = new StreamableHttpFixtureTransport(controller);
  const endpoint = "http://127.0.0.1:8787/mcp";
  equals((await transport.fetch(new Request(endpoint))).status, 405);
  equals((await transport.fetch(new Request("http://example.test/mcp"))).status, 403);
  equals(
    (await transport.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Accept: "application/json, text/event-stream" },
        body: "{}",
      }),
    )).status,
    415,
  );
  equals(
    (await transport.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
      }),
    )).status,
    406,
  );
  equals(
    (await transport.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: mcpHeaders("unknown-session"),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    )).status,
    404,
  );

  const harness = await createFixtureGatewayHarness();
  let now = 1_000;
  const isolated = new StreamableHttpFixtureTransport(harness, {
    now: () => now,
    initializationTimeoutMs: 100,
    idleTimeoutMs: 200,
  });
  const initializeTransport = async (): Promise<string> => {
    const response = await isolated.fetch(
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
    const id = response.headers.get("Mcp-Session-Id");
    assert(id);
    return id;
  };
  const post = async (session: string, body: unknown) =>
    await isolated.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: mcpHeaders(session),
        body: JSON.stringify(body),
      }),
    );
  const first = await initializeTransport();
  const second = await initializeTransport();
  equals((await post(first, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  equals((await post(second, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  equals((await post(first, { jsonrpc: "2.0", id: 2, method: "ping" })).status, 200);
  equals((await post(second, { jsonrpc: "2.0", id: 3, method: "ping" })).status, 200);
  equals(
    (await isolated.fetch(
      new Request(endpoint, {
        method: "DELETE",
        headers: {
          "Mcp-Session-Id": first,
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
      }),
    )).status,
    204,
  );
  equals((await post(first, { jsonrpc: "2.0", id: 4, method: "ping" })).status, 404);
  equals((await post(second, { jsonrpc: "2.0", id: 5, method: "ping" })).status, 200);
  now += 200;
  equals((await post(second, { jsonrpc: "2.0", id: 6, method: "ping" })).status, 404);
});

Deno.test("MCP and admin streaming bodies stop at their limits", async () => {
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

  const home = await app.fetch(new Request("http://127.0.0.1:8787/"));
  const cookie = cookieFrom(home);
  const form = streamingBody(2 * 1024);
  const formResponse = await app.fetch(
    new Request("http://127.0.0.1:8787/admin/owner/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
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
