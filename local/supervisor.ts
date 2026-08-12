function args(values: string[]) {
  let gatewayPort = 8787;
  let custodianPort = 8788;
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i];
    const value = Number(values[i + 1]);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("port denied");
    if (name === "--gateway-port") gatewayPort = value;
    else if (name === "--custodian-port") custodianPort = value;
    else throw new Error("usage: deno task local:run [--gateway-port PORT --custodian-port PORT]");
  }
  if (gatewayPort === custodianPort) throw new Error("origins must be distinct");
  return { gatewayPort, custodianPort };
}
if (import.meta.main) {
  const ports = args(Deno.args);
  const gatewayOrigin = `http://127.0.0.1:${ports.gatewayPort}`;
  const custodianOrigin = `http://127.0.0.1:${ports.custodianPort}`;
  const credential = crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const common = { CAIRN_DISPATCH_CREDENTIAL: credential };
  const custodian = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net=127.0.0.1,api.deepseek.com",
      "--allow-run=/usr/bin/secret-tool",
      "local/custodian_main.ts",
    ],
    env: {
      ...common,
      CAIRN_CUSTODIAN_PORT: String(ports.custodianPort),
      CAIRN_GATEWAY_ORIGIN: gatewayOrigin,
    },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const gateway = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net=127.0.0.1",
      "--allow-read",
      "--allow-write",
      "--allow-env=HOME,CAIRN_GATEWAY_PORT,CAIRN_CUSTODIAN_ORIGIN,CAIRN_DISPATCH_CREDENTIAL",
      "local/gateway_main.ts",
    ],
    env: {
      ...common,
      CAIRN_GATEWAY_PORT: String(ports.gatewayPort),
      CAIRN_CUSTODIAN_ORIGIN: custodianOrigin,
    },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  console.log(`Cairn local DeepSeek: ${gatewayOrigin}/`);
  console.log(`Separate key custodian: ${custodianOrigin}/intake`);
  console.log(`Antigravity MCP: ${gatewayOrigin}/mcp`);
  const stop = async () => {
    try {
      custodian.kill("SIGTERM");
    } catch { /* stopped */ }
    try {
      gateway.kill("SIGTERM");
    } catch { /* stopped */ }
    await Promise.allSettled([custodian.status, gateway.status]);
    Deno.exit();
  };
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  const completed = await Promise.race([custodian.status, gateway.status]);
  if (!completed.success) await stop();
}
