import { createLocalApp, startLocalServer } from "../local/server.ts";
import { MCP_PROTOCOL_VERSION } from "../local/mcp_transport.ts";

const app = await createLocalApp();
const server = startLocalServer(app, 0);
const address = server.addr as Deno.NetAddr;
const endpoint = `http://127.0.0.1:${address.port}/mcp`;

const post = async (body: unknown, session?: string) => {
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

try {
  const initialized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cairn-smoke", version: "1" },
    },
  });
  const session = initialized.headers.get("Mcp-Session-Id");
  const initBody = await initialized.json();
  if (!initialized.ok || !session || initBody.result?.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new Error("initialize failed");
  }

  const notice = await post(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    session,
  );
  if (notice.status !== 202) throw new Error("initialized notification failed");

  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session);
  const listBody = await listed.json();
  if (
    !listed.ok ||
    !listBody.result?.tools?.some((tool: { name: string }) => tool.name === "invoke_operation")
  ) {
    throw new Error("tools/list failed");
  }

  const invoked = await post({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "invoke_operation",
      arguments: {
        operation: "github.user.read@v1",
        connection: "connection_a",
        arguments: {},
      },
    },
  }, session);
  const invokeBody = await invoked.json();
  if (
    invokeBody.result?.structuredContent?.user?.login !== "fixture" ||
    !invokeBody.result?.content?.[0]?.text?.includes('"login":"fixture"')
  ) {
    throw new Error("invoke_operation failed");
  }
  console.log(
    "local-mcp-smoke: initialize -> initialized -> tools/list -> invoke_operation passed",
  );
} finally {
  await server.shutdown();
}
