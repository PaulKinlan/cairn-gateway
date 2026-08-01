import { assert, equals, rejects } from "../assert.ts";
import {
  handleFixtureMcp,
  MCP_CURRENT,
  MCP_LEGACY,
  type McpCore,
  TOOL_NAMES,
} from "../../apps/gateway/mcp.ts";
const core: McpCore = {
  search: (query) => Promise.resolve([{ id: "github.user.read@v1", query }]),
  describe: () => Promise.resolve({ inputSchema: { additionalProperties: false } }),
  invoke: () => Promise.resolve({ outcome: "success", user: { id: 1, login: "fixture" } }),
  status: () => Promise.resolve({ status: "active" }),
};
const modern = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
  _meta: {
    protocolVersion: MCP_CURRENT,
    clientInfo: { name: "fixture", version: "1" },
    capabilities: {},
  },
});
Deno.test("modern MCP exposes exactly four stable tools", async () => {
  const response = await handleFixtureMcp(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      _meta: { protocolVersion: MCP_CURRENT, clientInfo: {}, capabilities: {} },
    },
    MCP_CURRENT,
    "/mcp",
    true,
    core,
  );
  equals((response.result as { tools: { name: string }[] }).tools.map((tool) => tool.name), [
    ...TOOL_NAMES,
  ]);
});
Deno.test("legacy pinned revision exposes identical tool semantics", async () => {
  const response = await handleFixtureMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    MCP_LEGACY,
    "/mcp/legacy",
    true,
    core,
  );
  equals((response.result as { tools: { name: string }[] }).tools.map((tool) => tool.name), [
    ...TOOL_NAMES,
  ]);
});
Deno.test("modern MCP requires matching metadata", async () => {
  await rejects(
    () =>
      handleFixtureMcp(
        { jsonrpc: "2.0", id: 1, method: "tools/list", _meta: {} },
        MCP_CURRENT,
        "/mcp",
        true,
        core,
      ),
    "metadata",
  );
  await rejects(
    () => handleFixtureMcp(modern("search_capabilities"), MCP_LEGACY, "/mcp", true, core),
    "protocol",
  );
});
Deno.test("MCP requests independently require authentication", async () => {
  await rejects(
    () => handleFixtureMcp(modern("connection_status"), MCP_CURRENT, "/mcp", false, core),
    "denied",
  );
});
Deno.test("MCP batch and unknown methods are rejected", async () => {
  await rejects(
    () => handleFixtureMcp([modern("search_capabilities")], MCP_CURRENT, "/mcp", true, core),
    "denied",
  );
  await rejects(
    () =>
      handleFixtureMcp(
        { ...modern("search_capabilities"), method: "unknown" },
        MCP_CURRENT,
        "/mcp",
        true,
        core,
      ),
    "method",
  );
});
Deno.test("MCP structured result contains no internal material", async () => {
  const output = await handleFixtureMcp(
    modern("invoke_operation", {
      operation: "github.user.read@v1",
      connection: "github",
      arguments: {},
    }),
    MCP_CURRENT,
    "/mcp",
    true,
    core,
  );
  const text = JSON.stringify(output);
  assert(!text.includes("custody"));
  assert(!text.includes("capability_sha256"));
  assert(!text.includes("signature"));
});
