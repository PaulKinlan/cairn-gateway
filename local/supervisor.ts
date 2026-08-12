export interface ChildSpec {
  name: "custodian" | "gateway";
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface SupervisorOptions {
  gatewayPort: number;
  custodianPort: number;
  denoPath: string;
  sourceRoot: string;
  stateDir: string;
  dispatchCredential: string;
  secretToolPath?: string;
  secretServiceEnv?: Record<string, string | undefined>;
}
export function secretServiceTransportEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const bus = env.DBUS_SESSION_BUS_ADDRESS;
  if (bus && /^unix:path=\/[^\r\n\0;]{1,4096}$/.test(bus)) {
    result.DBUS_SESSION_BUS_ADDRESS = bus;
  }
  const runtime = env.XDG_RUNTIME_DIR;
  if (
    runtime && runtime.startsWith("/") && runtime.length <= 4096 &&
    !/[\r\n\0]/.test(runtime) && !runtime.split("/").includes("..")
  ) result.XDG_RUNTIME_DIR = runtime;
  return result;
}
function parseArgs(values: string[]) {
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
export function childSpecs(options: SupervisorOptions): [ChildSpec, ChildSpec] {
  const gatewayOrigin = `http://127.0.0.1:${options.gatewayPort}`;
  const custodianOrigin = `http://127.0.0.1:${options.custodianPort}`;
  const custodianStateDir = `${options.stateDir}/custodian`;
  const gatewayStateDir = `${options.stateDir}/gateway`;
  const usagePath = `${custodianStateDir}/deepseek-usage.json`;
  const metadataPath = `${gatewayStateDir}/deepseek.json`;
  const secretToolPath = options.secretToolPath ?? "/usr/bin/secret-tool";
  const transportEnv = secretServiceTransportEnv(options.secretServiceEnv ?? {});
  const transportNames = Object.keys(transportEnv).sort();
  return [{
    name: "custodian",
    command: options.denoPath,
    args: [
      "run",
      "--allow-net=127.0.0.1,api.deepseek.com:443",
      `--allow-run=${secretToolPath}`,
      `--allow-env=CAIRN_CUSTODIAN_PORT,CAIRN_GATEWAY_ORIGIN,CAIRN_DISPATCH_CREDENTIAL,CAIRN_USAGE_PATH,CAIRN_SECRET_TOOL_PATH${
        transportNames.length ? `,${transportNames.join(",")}` : ""
      }`,
      `--allow-read=${custodianStateDir}`,
      `--allow-write=${custodianStateDir}`,
      `${options.sourceRoot}/local/custodian_main.ts`,
    ],
    env: {
      CAIRN_DISPATCH_CREDENTIAL: options.dispatchCredential,
      CAIRN_CUSTODIAN_PORT: String(options.custodianPort),
      CAIRN_GATEWAY_ORIGIN: gatewayOrigin,
      CAIRN_USAGE_PATH: usagePath,
      CAIRN_SECRET_TOOL_PATH: secretToolPath,
      ...transportEnv,
    },
  }, {
    name: "gateway",
    command: options.denoPath,
    args: [
      "run",
      "--allow-net=127.0.0.1",
      "--allow-env=CAIRN_GATEWAY_PORT,CAIRN_CUSTODIAN_ORIGIN,CAIRN_DISPATCH_CREDENTIAL,CAIRN_METADATA_PATH",
      `--allow-read=${gatewayStateDir}`,
      `--allow-write=${gatewayStateDir}`,
      `${options.sourceRoot}/local/gateway_main.ts`,
    ],
    env: {
      CAIRN_DISPATCH_CREDENTIAL: options.dispatchCredential,
      CAIRN_GATEWAY_PORT: String(options.gatewayPort),
      CAIRN_CUSTODIAN_ORIGIN: custodianOrigin,
      CAIRN_METADATA_PATH: metadataPath,
    },
  }];
}
async function ready(url: string, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`child readiness timeout: ${url}`);
}
export async function supervise(options: SupervisorOptions): Promise<void> {
  const specs = childSpecs(options);
  const children: Deno.ChildProcess[] = [];
  const spawn = (spec: ChildSpec) => {
    const child = new Deno.Command(spec.command, {
      args: spec.args,
      env: spec.env,
      clearEnv: true,
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    children.push(child);
    return child;
  };
  const stop = async () => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch { /* stopped */ }
    }
    await Promise.allSettled(children.map((child) => child.status));
  };
  try {
    const custodian = spawn(specs[0]);
    await Promise.race([
      ready(`http://127.0.0.1:${options.custodianPort}/intake`),
      custodian.status.then((status) => {
        throw new Error(`custodian exited ${status.code}`);
      }),
    ]);
    const gateway = spawn(specs[1]);
    await Promise.race([
      ready(`http://127.0.0.1:${options.gatewayPort}/`),
      gateway.status.then((status) => {
        throw new Error(`gateway exited ${status.code}`);
      }),
    ]);
    console.log(`Cairn local DeepSeek: http://127.0.0.1:${options.gatewayPort}/`);
    console.log(`Separate key custodian: http://127.0.0.1:${options.custodianPort}/intake`);
    console.log(`Antigravity MCP: http://127.0.0.1:${options.gatewayPort}/mcp`);
    const signal = new Promise<void>((resolve) => {
      const handler = () => resolve();
      Deno.addSignalListener("SIGINT", handler);
      Deno.addSignalListener("SIGTERM", handler);
    });
    await Promise.race([signal, ...children.map((child) => child.status.then(() => undefined))]);
  } finally {
    await stop();
  }
}
if (import.meta.main) {
  const ports = parseArgs(Deno.args);
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME unavailable");
  await supervise({
    ...ports,
    denoPath: Deno.execPath(),
    sourceRoot: root,
    stateDir: `${home}/.local/state/cairn`,
    dispatchCredential: crypto.randomUUID().replaceAll("-", "") +
      crypto.randomUUID().replaceAll("-", ""),
    secretServiceEnv: {
      DBUS_SESSION_BUS_ADDRESS: Deno.env.get("DBUS_SESSION_BUS_ADDRESS"),
      XDG_RUNTIME_DIR: Deno.env.get("XDG_RUNTIME_DIR"),
    },
  });
}
