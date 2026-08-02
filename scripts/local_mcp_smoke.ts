import { createLocalApp, startLocalServer } from "../local/server.ts";
import { MCP_PROTOCOL_VERSION } from "../local/mcp_transport.ts";

const app = await createLocalApp();
const server = startLocalServer(app, 0);
const address = server.addr as Deno.NetAddr;
const origin = `http://127.0.0.1:${address.port}`;
const endpoint = `${origin}/mcp`;

const mcpPost = async (body: unknown, session?: string) => {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  });
  if (session) {
    headers.set("Mcp-Session-Id", session);
    headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
  }
  return await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
};

const initialize = async (): Promise<string> => {
  const response = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cairn-wire-demo", version: "1" },
    },
  });
  const session = response.headers.get("Mcp-Session-Id");
  const body = await response.json();
  if (!response.ok || !session || body.result?.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new Error("initialize failed");
  }
  const notice = await mcpPost(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    session,
  );
  if (notice.status !== 202) throw new Error("initialized notification failed");
  return session;
};

const call = async (session: string, id: number, name: string, args: unknown) => {
  const response = await mcpPost({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }, session);
  return await response.json();
};

const csrf = (html: string): string => {
  const value = html.match(/name="csrf_token" value="([a-f0-9]+)"/)?.[1];
  if (!value) throw new Error("CSRF token missing");
  return value;
};

try {
  const homeResponse = await fetch(`${origin}/`);
  const cookie = homeResponse.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("admin session missing");
  let html = await homeResponse.text();
  const adminPost = async (path: string, fields: Record<string, string> = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        Origin: origin,
      },
      body: new URLSearchParams({ csrf_token: csrf(html), ...fields }),
    });
    html = await response.text();
    if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  };

  await adminPost("/admin/owner/create");
  await adminPost("/admin/agent/create", { agent_name: "Demo agent" });
  await adminPost("/admin/identity/enroll", {
    device_name: "Demo laptop",
    workload_name: "Demo worker",
  });
  await adminPost("/admin/grant/create");
  if (!html.includes("Version</dt><dd>1</dd>") || !html.includes("0 of 5")) {
    throw new Error("grant policy not visible");
  }

  const firstSession = await initialize();
  const search = await call(firstSession, 2, "search_capabilities", { query: "github user" });
  if (search.result?.structuredContent?.operations?.[0]?.id !== "github.user.read@v1") {
    throw new Error("search_capabilities failed");
  }
  const describe = await call(firstSession, 3, "describe_operation", {
    operation: "github.user.read@v1",
  });
  if (describe.result?.structuredContent?.provider !== "github") {
    throw new Error("describe_operation failed");
  }
  const status = await call(firstSession, 4, "connection_status", {
    connection: "connection_a",
  });
  if (status.result?.structuredContent?.status !== "active") {
    throw new Error("connection_status failed");
  }
  const invoke = await call(firstSession, 5, "invoke_operation", {
    operation: "github.user.read@v1",
    connection: "connection_a",
    arguments: {},
  });
  if (invoke.result?.structuredContent?.user?.login !== "fixture") {
    throw new Error("invoke_operation failed");
  }
  html = await (await fetch(`${origin}/`, { headers: { Cookie: cookie } })).text();
  if (!html.includes("Invocation receipts") || !html.includes("policy_allow")) {
    throw new Error("visible MCP receipt missing");
  }

  await adminPost("/admin/grant/revoke");
  if (!html.includes("Grant revoked") || !html.includes("Test denied call")) {
    throw new Error("revocation audit or denial control missing");
  }
  const denialStarted = performance.now();
  await adminPost("/admin/invoke");
  const denialLatencyMs = performance.now() - denialStarted;
  if (
    denialLatencyMs >= 1_000 || !html.includes("grant_inactive") ||
    !html.includes("Invocation denied locally in")
  ) throw new Error("visible measured denial missing");
  for (
    const [id, name, args] of [
      [6, "search_capabilities", { query: "github" }],
      [7, "describe_operation", { operation: "github.user.read@v1" }],
      [8, "connection_status", { connection: "connection_a" }],
      [9, "invoke_operation", {
        operation: "github.user.read@v1",
        connection: "connection_a",
        arguments: {},
      }],
    ] as const
  ) {
    const denied = await call(firstSession, id, name, args);
    if (denied.error?.message !== "fixture authority denied") {
      throw new Error(`${name} did not deny after revoke`);
    }
  }

  await adminPost("/admin/grant/reactivate");
  if (!html.includes("Version</dt><dd>4</dd>") || !html.includes("0 of 5")) {
    throw new Error("replacement grant version not visible");
  }
  const restored = await call(firstSession, 10, "invoke_operation", {
    operation: "github.user.read@v1",
    connection: "connection_a",
    arguments: {},
  });
  if (restored.result?.structuredContent?.user?.login !== "fixture") {
    throw new Error("replacement grant not usable");
  }

  const secondSession = await initialize();
  const reconnected = await call(secondSession, 11, "invoke_operation", {
    operation: "github.user.read@v1",
    connection: "connection_a",
    arguments: {},
  });
  if (reconnected.result?.structuredContent?.user?.login !== "fixture") {
    throw new Error("reconnect failed");
  }
  console.log("local-mcp-demo: owner -> agent -> device/workload -> grant passed");
  console.log(
    "local-mcp-demo: search -> describe -> status -> invoke -> receipt passed",
  );
  console.log(
    `local-mcp-demo: revoke denial (${
      denialLatencyMs.toFixed(1)
    }ms) -> audit -> replacement v4 -> invoke -> reconnect passed`,
  );
} finally {
  await server.shutdown();
}
