import { assert, equals } from "../assert.ts";
import {
  createCustodianApp,
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  type SecretStore,
} from "../../local/deepseek_custodian.ts";
import { createDeepSeekApp, startDeepSeekServer } from "../../local/deepseek_server.ts";
import { MemoryMetadataStore } from "../../local/deepseek_controller.ts";
import { MCP_PROTOCOL_VERSION } from "../../local/mcp_transport.ts";

class FakeStore implements SecretStore {
  value?: string;
  put(value: string) {
    this.value = value;
    return Promise.resolve();
  }
  get() {
    return Promise.resolve(this.value);
  }
  delete() {
    this.value = undefined;
    return Promise.resolve();
  }
}
const credential = "dispatch_credential_123456789012345678901234";
const sentinel = "ds_FAKE_SENTINEL_NEVER_LOG_OR_PERSIST";
function csrf(html: string) {
  const value = html.match(/name="csrf_token" value="([a-f0-9]+)"/)?.[1];
  assert(value);
  return value;
}
function cookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(value);
  return value;
}

Deno.test("separate custodian intake redirects away and fixed provider request is exact", async () => {
  const store = new FakeStore();
  let captured: Request | undefined;
  const custodian = await createCustodianApp({
    dispatchCredential: credential,
    gatewayOrigin: "http://127.0.0.1:8787",
    store,
    providerFetch: (request) => {
      captured = request;
      return Promise.resolve(
        Response.json({
          choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      );
    },
  });
  const intake = await custodian.fetch(new Request("http://127.0.0.1:8788/intake"));
  const intakeCookie = cookie(intake);
  const intakeHtml = await intake.text();
  assert(intakeHtml.includes('type="password"'));
  assert(!intakeHtml.includes(sentinel));
  const submitted = await custodian.fetch(
    new Request("http://127.0.0.1:8788/intake", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:8788",
        Cookie: intakeCookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf_token: csrf(intakeHtml), api_key: sentinel }),
    }),
  );
  equals(submitted.status, 303);
  equals(submitted.headers.get("location"), "http://127.0.0.1:8787/?connected=1");
  equals(await submitted.text(), "");
  equals(store.value, sentinel);
  const invoked = await custodian.fetch(
    new Request("http://127.0.0.1:8788/internal/invoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
    }),
  );
  equals((await invoked.json()).assistant_text, "hello");
  assert(captured);
  equals(captured.url, DEEPSEEK_ENDPOINT);
  equals(captured.method, "POST");
  equals(captured.headers.get("authorization"), `Bearer ${sentinel}`);
  equals(await captured.json(), {
    model: DEEPSEEK_MODEL,
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 256,
    stream: false,
    thinking: { type: "disabled" },
  });
});

Deno.test("closed schema rejects bounds and caller-selected provider controls", async () => {
  const store = new FakeStore();
  store.value = sentinel;
  let calls = 0;
  const app = await createCustodianApp({
    dispatchCredential: credential,
    gatewayOrigin: "http://127.0.0.1:8787",
    store,
    providerFetch: () => {
      calls++;
      return Promise.resolve(new Response());
    },
  });
  const invoke = async (argumentsValue: unknown) =>
    await app.fetch(
      new Request("http://127.0.0.1:8788/internal/invoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify(argumentsValue),
      }),
    );
  equals((await invoke({ messages: [] })).status, 400);
  equals((await invoke({ messages: Array(9).fill({ role: "user", content: "x" }) })).status, 400);
  equals((await invoke({ messages: [{ role: "assistant", content: "x" }] })).status, 400);
  equals((await invoke({ messages: [{ role: "user", content: "x".repeat(8193) }] })).status, 400);
  for (const forbidden of ["url", "model", "headers", "tools", "files", "options"]) {
    equals(
      (await invoke({ messages: [{ role: "user", content: "x" }], [forbidden]: "evil" })).status,
      400,
    );
  }
  equals(
    (await invoke({ messages: [{ role: "user", content: "x" }], max_output_tokens: 1025 })).status,
    400,
  );
  equals(calls, 0);
});

Deno.test("gateway four-tool Antigravity journey, receipts, disconnect delete and restart retain no sentinel", async () => {
  const store = new FakeStore();
  store.value = sentinel;
  const provider = () =>
    Promise.resolve(
      Response.json({
        choices: [{ message: { content: "Projected answer" }, finish_reason: "length" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    );
  const custodian = await createCustodianApp({
    dispatchCredential: credential,
    gatewayOrigin: "http://127.0.0.1:8787",
    store,
    providerFetch: provider,
  });
  const custodianClient = {
    status: async () =>
      await (await custodian.fetch(
        new Request("http://127.0.0.1:8788/internal/status", {
          headers: { Authorization: `Bearer ${credential}` },
        }),
      )).json(),
    invoke: async (input: unknown) =>
      await (await custodian.fetch(
        new Request("http://127.0.0.1:8788/internal/invoke", {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      )).json(),
    delete: async () => {
      await custodian.fetch(
        new Request("http://127.0.0.1:8788/internal/delete", {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}` },
        }),
      );
    },
  };
  const metadata = new MemoryMetadataStore();
  metadata.value = {
    schemaVersion: 1,
    configured: true,
    connected: true,
    grantVersion: 1,
    receipts: [],
  };
  const app = await createDeepSeekApp({
    custodianOrigin: "http://127.0.0.1:8788",
    dispatchCredential: credential,
    custodian: custodianClient,
    metadata,
  });
  const server = startDeepSeekServer(app, 0);
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try {
    const init = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "antigravity", version: "1.1.12" },
        },
      }),
    });
    const session = init.headers.get("Mcp-Session-Id")!;
    const post = async (body: unknown) =>
      await (await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "Mcp-Session-Id": session,
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify(body),
      })).json();
    await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": session,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    equals(listed.result.tools.map((t: { name: string }) => t.name), [
      "search_capabilities",
      "describe_operation",
      "invoke_operation",
      "connection_status",
    ]);
    const call = (id: number, name: string, argumentsValue: unknown) =>
      post({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: argumentsValue },
      });
    assert(
      JSON.stringify(await call(3, "search_capabilities", { query: "deepseek" })).includes(
        "deepseek.chat.complete@v1",
      ),
    );
    assert(
      JSON.stringify(
        await call(4, "describe_operation", { operation: "deepseek.chat.complete@v1" }),
      ).includes("deepseek"),
    );
    assert(
      JSON.stringify(await call(5, "connection_status", { connection: "deepseek_local" })).includes(
        "active",
      ),
    );
    const invoked = await call(6, "invoke_operation", {
      operation: "deepseek.chat.complete@v1",
      connection: "deepseek_local",
      arguments: { messages: [{ role: "user", content: "test prompt" }] },
    });
    assert(JSON.stringify(invoked).includes("Projected answer"));
    const home = await fetch(`${origin}/`);
    const homeCookie = cookie(home);
    let html = await home.text();
    assert(html.includes("policy_allow"));
    assert(!html.includes("test prompt"));
    assert(!html.includes("Projected answer"));
    assert(!html.includes(sentinel));
    assert(!JSON.stringify(metadata.value).includes(sentinel));
    const admin = async (path: string) => {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: homeCookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf_token: csrf(html) }),
      });
      html = await response.text();
      return response;
    };
    await admin("/admin/disconnect");
    assert(html.includes("Connection disabled"));
    assert((await call(7, "search_capabilities", { query: "deepseek" })).error);
    await admin("/admin/connect");
    assert(html.includes("Connection enabled"));
    const restarted = await createDeepSeekApp({
      custodianOrigin: "http://127.0.0.1:8788",
      dispatchCredential: credential,
      custodian: custodianClient,
      metadata,
    });
    const restartPage = await restarted.fetch(new Request("http://127.0.0.1:8787/"));
    assert((await restartPage.text()).includes('Configured: <span class="status">yes'));
    await admin("/admin/delete");
    equals(store.value, undefined);
    assert(html.includes("key deleted"));
    assert(!JSON.stringify(metadata.value).includes(sentinel));
  } finally {
    await server.shutdown();
  }
});
