import { assert, equals, rejects } from "../assert.ts";
import { validatesSchema } from "../../apps/gateway/json_schema.ts";
import { atomicWriteJson, readJsonFile } from "../../local/atomic_json.ts";
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
import { DEEPSEEK_TOOLS } from "../../local/deepseek_server.ts";
import { childSpecs, secretServiceTransportEnv } from "../../local/supervisor.ts";

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

Deno.test("SecretToolStore deletion confirms only exact lookup absence", async () => {
  let mode: "clear-fails" | "remains" | "gone" | "lookup-fails" = "clear-fails";
  const runner: SecretCommandRunner = {
    run: (args) => {
      if (args[0] === "clear") {
        return Promise.resolve({
          category: mode === "clear-fails" ? "failure" : "success",
          code: mode === "clear-fails" ? 2 : 0,
          stdout: new Uint8Array(),
        });
      }
      if (mode === "gone") {
        return Promise.resolve({ category: "absent", code: 1, stdout: new Uint8Array() });
      }
      if (mode === "lookup-fails") {
        return Promise.resolve({ category: "failure", code: 2, stdout: new Uint8Array() });
      }
      return Promise.resolve({
        category: "success",
        code: 0,
        stdout: new TextEncoder().encode("still-there"),
      });
    },
  };
  const store = new SecretToolStore(runner);
  await rejects(() => store.delete(), "deletion unavailable");
  mode = "remains";
  await rejects(() => store.delete(), "not confirmed");
  mode = "lookup-fails";
  await rejects(() => store.delete(), "lookup unavailable");
  mode = "gone";
  await store.delete();
});

Deno.test("post-rename directory sync failure is consistently reported as committed", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/authority.json`;
  try {
    await atomicWriteJson(path, { connected: false });
    await atomicWriteJson(path, { connected: true }, {
      syncDirectory: () => Promise.reject(new Error("injected directory sync failure")),
    });
    equals(await readJsonFile(path, 1024), { connected: true });
    const mode = (await Deno.stat(path)).mode;
    if (mode !== null) equals(mode & 0o777, 0o600);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
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
    await rejects(
      () => createDeepSeekController(custodian, new FileMetadataStore(path)),
      "metadata invalid",
    );
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

Deno.test("simultaneous invokes serialize reservation and dispatch only once", async () => {
  let providerCalls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const app = await createCustodianApp({
    dispatchCredential: credential,
    gatewayOrigin: "http://127.0.0.1:8787",
    store: {
      put: () => Promise.resolve(),
      get: () => Promise.resolve("fake"),
      delete: () => Promise.resolve(),
    },
    usageStore: new MemoryUsageStore(),
    requestLimitPerDay: 1,
    concurrency: 1,
    providerFetch: async () => {
      providerCalls++;
      await blocked;
      return Response.json({
        choices: [{ message: { content: "safe" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  const request = () =>
    app.fetch(
      new Request("http://127.0.0.1:8788/internal/invoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      }),
    );
  const first = request();
  const second = request();
  await new Promise((done) => setTimeout(done, 0));
  equals(providerCalls, 1);
  release();
  const responses = await Promise.all([first, second]);
  equals(providerCalls, 1);
  assert(responses.some((response) => response.status === 429));
});

Deno.test("failed controller persistence rolls back authority and receipts", async () => {
  class FailingStore extends MemoryMetadataStore {
    fail = false;
    override save(value: Parameters<MemoryMetadataStore["save"]>[0]) {
      if (this.fail) return Promise.reject(new Error("save failed"));
      return super.save(value);
    }
  }
  const metadata = new FailingStore();
  metadata.value = {
    schemaVersion: 1,
    configured: true,
    connected: false,
    grantVersion: 1,
    receipts: [],
  };
  const custodian: CustodianClient = {
    status: () => Promise.resolve({ configured: true, healthy: true }),
    invoke: () => Promise.resolve(success),
    delete: () => Promise.resolve(),
  };
  const controller = await createDeepSeekController(custodian, metadata);
  metadata.fail = true;
  await rejects(() => controller.connect(), "save failed");
  metadata.fail = false;
  await rejects(() => controller.dispatch(rpc()), "authority unavailable");
  equals(metadata.value?.connected, false);

  await controller.connect();
  metadata.fail = true;
  await rejects(() => controller.dispatch(rpc()), "save failed");
  metadata.fail = false;
  equals(metadata.value?.receipts.length, 0);
});

Deno.test("delayed status refresh cannot restore authority after disconnect or dispatch provider", async () => {
  class RacingMetadataStore extends MemoryMetadataStore {
    racing = false;
    disableStarted!: () => void;
    readonly disabling = new Promise<void>((resolve) => this.disableStarted = resolve);
    releaseDisable!: () => void;
    readonly disabled = new Promise<void>((resolve) => this.releaseDisable = resolve);
    releaseRestore!: () => void;
    readonly restoreReleased = new Promise<void>((resolve) => this.releaseRestore = resolve);
    override async save(value: Parameters<MemoryMetadataStore["save"]>[0]) {
      if (this.racing && !value.connected) {
        this.disableStarted();
        await this.disabled;
      } else if (this.racing && value.connected) {
        // Under the rejected implementation, the delayed refresh snapshots connected=true while
        // the disconnect write is pending and reaches this stale write. Releasing it after the
        // disconnect deterministically reproduced BYPASS (restored authority and provider call).
        await this.restoreReleased;
      }
      await super.save(value);
    }
  }
  let releaseStatus!: () => void;
  let statusCalls = 0;
  let providerCalls = 0;
  const statusBlocked = new Promise<void>((resolve) => releaseStatus = resolve);
  const metadata = new RacingMetadataStore();
  metadata.value = connectedMetadata().value;
  const controller = await createDeepSeekController({
    status: async () => {
      statusCalls++;
      if (statusCalls === 2) await statusBlocked;
      return { configured: true, healthy: true };
    },
    invoke: () => {
      providerCalls++;
      return Promise.resolve(success);
    },
    delete: () => Promise.resolve(),
  }, metadata);
  metadata.racing = true;
  const delayedView = controller.view();
  await new Promise((done) => setTimeout(done, 0));
  const disconnect = controller.disconnect();
  await metadata.disabling;
  releaseStatus();
  await new Promise((done) => setTimeout(done, 0));
  metadata.releaseDisable();
  await disconnect;
  metadata.releaseRestore();
  equals((await delayedView).connected, false);
  await rejects(() => controller.dispatch(rpc()), "authority unavailable");
  equals(providerCalls, 0);
  equals(metadata.value?.connected, false);
  equals((await controller.view()).connected, false);
});

Deno.test("advertised DeepSeek and described operation schemas validate actual values", async () => {
  const outputSchema = (name: string): Record<string, unknown> => {
    const found = DEEPSEEK_TOOLS.find((tool) => tool.name === name);
    assert(found?.outputSchema);
    return found.outputSchema;
  };
  const custodian: CustodianClient = {
    status: () => Promise.resolve({ configured: true, healthy: null }),
    invoke: () => Promise.resolve(success),
    delete: () => Promise.resolve(),
  };
  const controller = await createDeepSeekController(custodian, connectedMetadata());
  const call = async (id: number, name: string, args: Record<string, unknown>) => {
    const output = await controller.dispatch(new TextEncoder().encode(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })));
    return (output.result as Record<string, unknown>).structuredContent;
  };
  const responses = [
    ["search_capabilities", await call(1, "search_capabilities", { query: "deepseek" })],
    [
      "describe_operation",
      await call(2, "describe_operation", { operation: "deepseek.chat.complete@v1" }),
    ],
    ["connection_status", await call(3, "connection_status", { connection: "deepseek_local" })],
    [
      "invoke_operation",
      await call(4, "invoke_operation", {
        operation: "deepseek.chat.complete@v1",
        connection: "deepseek_local",
        arguments: { messages: [{ role: "user", content: "hi" }] },
      }),
    ],
  ] as const;
  for (const [name, response] of responses) {
    assert(
      validatesSchema(outputSchema(name), response),
      `${name} schema rejected output`,
    );
  }
  const described = responses[1][1] as Record<string, unknown>;
  assert(validatesSchema(described.inputSchema as Record<string, unknown>, {
    messages: [{ role: "user", content: "hello" }],
    max_output_tokens: 32,
  }));
  assert(validatesSchema(described.outputSchema as Record<string, unknown>, {
    outcome: "success",
    assistant_text: "answer",
    finish_category: "complete",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    receipt: { decision: "allow", reason: "policy_allow", requestUnits: 1 },
  }));
  assert(
    !validatesSchema(described.inputSchema as Record<string, unknown>, {
      messages: [{ role: "user", content: "x".repeat(8193) }],
    }),
  );

  const errorController = await createDeepSeekController({
    ...custodian,
    invoke: () => Promise.resolve({ outcome: "rate_limited" }),
  }, connectedMetadata());
  const error = await errorController.dispatch(rpc(5));
  assert(
    validatesSchema(
      outputSchema("invoke_operation"),
      (error.result as Record<string, unknown>).structuredContent,
    ),
  );
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

Deno.test("production permission flags persist both file stores through real child processes", async () => {
  const directory = await Deno.makeTempDir();
  const sourceRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const probe = `${directory}/probe.ts`;
  await Deno.writeTextFile(
    probe,
    `import { FileMetadataStore } from ${
      JSON.stringify(`${sourceRoot}/local/deepseek_controller.ts`)
    };
import { FileUsageStore } from ${JSON.stringify(`${sourceRoot}/local/deepseek_custodian.ts`)};
if(Deno.args[0]==="gateway"){const path=${
      JSON.stringify(`${directory}/state/gateway/deepseek.json`)
    };const store=new FileMetadataStore(path);await store.save({schemaVersion:1,configured:false,connected:false,grantVersion:1,receipts:[]});if(!(await store.load()))throw new Error("metadata load failed");}
else if(Deno.args[0]==="custodian"){const path=${
      JSON.stringify(`${directory}/state/custodian/deepseek-usage.json`)
    };const store=new FileUsageStore(path);await store.save({version:1,day:"2026-08-13",requests:1,reservedTokens:2});if((await store.load())?.requests!==1)throw new Error("usage load failed");}
else throw new Error("mode unavailable");`,
  );
  const specs = childSpecs({
    gatewayPort: 18787,
    custodianPort: 18788,
    denoPath: Deno.execPath(),
    sourceRoot,
    stateDir: `${directory}/state`,
    dispatchCredential: credential,
  });
  try {
    for (const spec of specs) {
      const args = [...spec.args];
      args[args.length - 1] = probe;
      args.push(spec.name);
      const output = await new Deno.Command(spec.command, {
        args,
        env: spec.env,
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("custodian production-shape child receives only validated Secret Service transport", async () => {
  const directory = await Deno.makeTempDir();
  const sourceRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const fakeSecretTool = `${directory}/secret-tool`;
  await Deno.writeTextFile(
    fakeSecretTool,
    `#!/bin/sh
[ -n "$DBUS_SESSION_BUS_ADDRESS" ] || exit 9
[ -n "$XDG_RUNTIME_DIR" ] || exit 10
[ -z "$DISPLAY" ] || exit 11
exit 1
`,
  );
  await Deno.chmod(fakeSecretTool, 0o700);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const [spec] = childSpecs({
    gatewayPort: 18787,
    custodianPort: port,
    denoPath: Deno.execPath(),
    sourceRoot,
    stateDir: `${directory}/state`,
    dispatchCredential: credential,
    secretToolPath: fakeSecretTool,
    secretServiceEnv: {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DISPLAY: ":0",
    },
  });
  const child = new Deno.Command(spec.command, {
    args: spec.args,
    env: spec.env,
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  }).spawn();
  try {
    let intake: Response | undefined;
    for (let attempt = 0; attempt < 50 && !intake; attempt++) {
      try {
        intake = await fetch(`http://127.0.0.1:${port}/intake`);
      } catch {
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    equals(intake?.status, 200);
    const status = await fetch(`http://127.0.0.1:${port}/internal/status`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    equals(status.status, 200);
    equals(await status.json(), { configured: false, healthy: null });
  } finally {
    try {
      child.kill("SIGTERM");
    } catch { /* stopped */ }
    await child.status;
    await Deno.remove(directory, { recursive: true });
  }
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
    secretServiceEnv: {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DISPLAY: ":0",
    },
  });
  assert(
    specs[0].args.includes(
      "--allow-env=CAIRN_CUSTODIAN_PORT,CAIRN_GATEWAY_ORIGIN,CAIRN_DISPATCH_CREDENTIAL,CAIRN_USAGE_PATH,CAIRN_SECRET_TOOL_PATH,DBUS_SESSION_BUS_ADDRESS,XDG_RUNTIME_DIR",
    ),
  );
  assert(
    specs[1].args.includes(
      "--allow-env=CAIRN_GATEWAY_PORT,CAIRN_CUSTODIAN_ORIGIN,CAIRN_DISPATCH_CREDENTIAL,CAIRN_METADATA_PATH",
    ),
  );
  assert(
    specs[1].args.some((arg) => arg === `--allow-read=${directory}/state/gateway`),
  );
  assert(specs[0].args.some((arg) => arg === `--allow-write=${directory}/state/custodian`));
  assert(!("DBUS_SESSION_BUS_ADDRESS" in specs[1].env));
  assert(!("XDG_RUNTIME_DIR" in specs[1].env));
  assert(!("DISPLAY" in specs[0].env));
  equals(specs[0].env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  equals(specs[0].env.XDG_RUNTIME_DIR, "/run/user/1000");
  equals(
    secretServiceTransportEnv({
      DBUS_SESSION_BUS_ADDRESS: "tcp:host=evil",
      XDG_RUNTIME_DIR: "relative",
    }),
    {},
  );
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
