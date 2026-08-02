import { createLocalApp, DEFAULT_LOCAL_PORT, LOCAL_HOST, startLocalServer } from "./server.ts";

function portFromArgs(args: string[]): number {
  if (args.length === 0) return DEFAULT_LOCAL_PORT;
  if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1] ?? "")) {
    throw new Error("usage: deno task local:run [--port PORT]");
  }
  const port = Number(args[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("port denied");
  return port;
}

if (import.meta.main) {
  const port = portFromArgs(Deno.args);
  const app = await createLocalApp();
  startLocalServer(app, port);
  console.log(`Cairn local fixture: http://${LOCAL_HOST}:${port}/`);
  console.log(`MCP endpoint: http://${LOCAL_HOST}:${port}/mcp`);
}
