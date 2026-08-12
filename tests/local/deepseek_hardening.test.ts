import { assert, equals, rejects } from "../assert.ts";
import {
  createCustodianApp,
  MemoryUsageStore,
  type SecretCommandRunner,
  SecretToolStore,
} from "../../local/deepseek_custodian.ts";
import {
  createDeepSeekController,
  type CustodianClient,
  FileMetadataStore,
  MemoryMetadataStore,
} from "../../local/deepseek_controller.ts";
import { childSpecs } from "../../local/supervisor.ts";

const credential = "dispatch_credential_123456789012345678901234";
const success = {
  outcome: "success" as const,
  assistant_text: "safe",
  finish_category: "complete" as const,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};
const rpc = (id = 1) =>
  new TextEncoder().encode(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "invoke_operation",
      arguments: {
        operation: "deepseek.chat.complete@v1",
        connection: "deepseek_local",
        arguments: { messages: [{ role: "user", content: "hi" }] },
      },
    },
  }));
function connectedMetadata() {
  const metadata = new MemoryMetadataStore();
  metadata.value = {
    schemaVersion: 1,
    configured: true,
    connected: true,
    grantVersion: 1,
    receipts: [],
  };
  return metadata;
}

Deno.test("SecretToolStore deletion checks clear status and verifies lookup absence", async () => {
  let mode: "clear-fails" | "remains" | "gone" = "clear-fails";
  const runner: SecretCommandRunner = {
    run: (args) => {
      if (args[0] === "clear") {
        return Promise.resolve({ success: mode !== "clear-fails", stdout: new Uint8Array() });
      }
      return Promise.resolve({
        success: mode !== "gone",
        stdout: mode === "gone" ? new Uint8Array() : new TextEncoder().encode("still-there"),
      });
    },
  };
  const store = new SecretToolStore(runner);
  await rejects(() => store.delete(), "deletion unavailable");
  mode = "remains";
  await rejects(() => store.delete(), "not confirmed");
  mode = "gone";
  await store.delete();
});

Deno.test("metadata corruption and missing bootstrap fail closed; disconnect survives new instance", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/state/deepseek.json`;
  const custodian: CustodianClient = {
    status: () => Promise.resolve({ configured: true, healthy: null }),
    invoke: () => Promise.resolve(success),
    delete: () => Promise.resolve(),
  };
  try {
    const missing = await createDeepSeekController(custodian, new FileMetadataStore(path));
    const missingView = await missing.view();
    equals(missingView.connected, false);
    await rejects(() => missing.dispatch(rpc()), "authority unavailable");
    await missing.connect();
    await missing.disconnect();
    const restarted = await createDeepSeekController(custodian, new FileMetadataStore(path));
    equals((await restarted.view()).connected, false);
    await Deno.writeTextFile(path, '{"schemaVersion":1,"connected":true');
    const corrupt = await createDeepSeekController(custodian, new FileMetadataStore(path));
    equals((await corrupt.view()).connected, false);
    await rejects(() => corrupt.connect(), "metadata unavailable");
    const mode = (await Deno.stat(path)).mode;
    if (mode !== null) equals(mode & 0o777, 0o600);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("custodian rejects extra provider fields, excess output tokens, and persists reservations", async () => {
  const usageStore = new MemoryUsageStore();
  const store = {
    value: "fake",
    put: () => Promise.resolve(),
    get: () => Promise.resolve("fake"),
    delete: () => Promise.resolve(),
  };
  let extra = true;
  const provider = () =>
    Promise.resolve(
      Response.json(
        extra
          ? {
            choices: [{ message: { content: "safe" }, finish_reason: "stop", extra_secret: "NO" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }
          : {
            choices: [{ message: { content: "safe" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
          },
      ),
    );
  const invoke = async (app: Awaited<ReturnType<typeof createCustodianApp>>, max = 2) =>
    await app.fetch(
      new Request("http://127.0.0.1:8788/internal/invoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "x" }],
          max_output_tokens: max,
        }),
      }),
    );
  const app = await createCustodianApp({
    dispatchCredential: credential,
    gatewayOrigin: "http://127.0.0.1:8787",
    store,
    usageStore,
    providerFetch: provider,
    tokenLimitPerDay: 20,
  });
  const response = await invoke(app);
  equals((await response.json()).outcome, "provider_unavailable");
  extra = false;
  const over = await invoke(app);
  equals((await over.json()).outcome, "provider_unavailable");
  const restarted = await createCustodianApp({
    dispatchCredential: credential,
    gatewayOrigin: "http://127.0.0.1:8787",
    store,
    usageStore,
    providerFetch: provider,
    tokenLimitPerDay: 7,
  });
  equals((await invoke(restarted)).status, 429);
});

Deno.test("gateway projects exact custodian output and lifecycle race cannot return success or receipt", async () => {
  let resolve!: (value: typeof success & { extra_secret: string }) => void;
  const deferred = new Promise<typeof success & { extra_secret: string }>((done) => resolve = done);
  const custodian = {
    status: () => Promise.resolve({ configured: true, healthy: true }),
    invoke: () => deferred,
    delete: () => Promise.resolve(),
  } as unknown as CustodianClient;
  const metadata = connectedMetadata();
  const controller = await createDeepSeekController(custodian, metadata);
  const pending = controller.dispatch(rpc());
  await new Promise((done) => setTimeout(done, 0));
  const disconnect = controller.disconnect();
  resolve({ ...success, extra_secret: "NEVER" });
  await disconnect;
  await rejects(() => pending, "authority changed");
  assert(!JSON.stringify(metadata.value).includes("NEVER"));
  equals(metadata.value?.receipts.length, 0);

  let resolveDeleteRace!: (value: typeof success) => void;
  const deleteDeferred = new Promise<typeof success>((done) => resolveDeleteRace = done);
  const deleteMetadata = connectedMetadata();
  const deleteController = await createDeepSeekController({
    status: custodian.status,
    invoke: () => deleteDeferred,
    delete: () => Promise.resolve(),
  }, deleteMetadata);
  const pendingDeleteRace = deleteController.dispatch(rpc(3));
  await new Promise((done) => setTimeout(done, 0));
  const deletion = deleteController.delete();
  resolveDeleteRace(success);
  await deletion;
  await rejects(() => pendingDeleteRace, "authority changed");
  equals(deleteMetadata.value?.receipts.length, 0);

  const projectedCustodian = {
    status: custodian.status,
    invoke: () => Promise.resolve({ ...success, extra_secret: "NEVER" }),
    delete: custodian.delete,
  } as unknown as CustodianClient;
  const projected = await createDeepSeekController(projectedCustodian, connectedMetadata());
  const output = await projected.dispatch(rpc(2));
  assert(!JSON.stringify(output).includes("NEVER"));
});

Deno.test("supervisor child composition is exact and child boundary starts deterministically", async () => {
  const directory = await Deno.makeTempDir();
  const sourceRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const fakeDeno = `${directory}/deno`;
  await Deno.writeTextFile(
    fakeDeno,
    `#!/bin/sh\nentry=""\nfor arg in "$@"; do entry="$arg"; done\ncase "$entry" in *custodian_main.ts) port="$CAIRN_CUSTODIAN_PORT";; *gateway_main.ts) port="$CAIRN_GATEWAY_PORT";; *) exit 2;; esac\nexec ${Deno.execPath()} run --allow-net=127.0.0.1 --allow-env=FAKE_PORT - <<EOF\nDeno.serve({hostname:"127.0.0.1",port:Number(Deno.env.get("FAKE_PORT")),onListen(){}},()=>new Response("ok"));\nEOF\n`,
  );
  await Deno.chmod(fakeDeno, 0o700);
  const listener1 = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const custodianPort = (listener1.addr as Deno.NetAddr).port;
  listener1.close();
  const listener2 = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const gatewayPort = (listener2.addr as Deno.NetAddr).port;
  listener2.close();
  const specs = childSpecs({
    gatewayPort,
    custodianPort,
    denoPath: fakeDeno,
    sourceRoot,
    stateDir: `${directory}/state`,
    dispatchCredential: credential,
  });
  assert(
    specs[0].args.includes(
      "--allow-env=CAIRN_CUSTODIAN_PORT,CAIRN_GATEWAY_ORIGIN,CAIRN_DISPATCH_CREDENTIAL,CAIRN_USAGE_PATH",
    ),
  );
  assert(
    specs[1].args.includes(
      "--allow-env=CAIRN_GATEWAY_PORT,CAIRN_CUSTODIAN_ORIGIN,CAIRN_DISPATCH_CREDENTIAL,CAIRN_METADATA_PATH",
    ),
  );
  assert(specs[1].args.some((arg) => arg === `--allow-read=${directory}/state/deepseek.json`));
  assert(!specs[1].args.includes("--allow-read"));
  const children = specs.map((spec) =>
    new Deno.Command(spec.command, {
      args: spec.args,
      env: {
        ...spec.env,
        FAKE_PORT: spec.name === "custodian" ? String(custodianPort) : String(gatewayPort),
      },
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).spawn()
  );
  try {
    for (const port of [custodianPort, gatewayPort]) {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 30 && !response; attempt++) {
        try {
          response = await fetch(`http://127.0.0.1:${port}/`);
        } catch {
          await new Promise((done) => setTimeout(done, 20));
        }
      }
      equals(response?.status, 200);
    }
  } finally {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch { /* stopped */ }
    }
    await Promise.all(children.map((child) => child.status));
    await Deno.remove(directory, { recursive: true });
  }
});
