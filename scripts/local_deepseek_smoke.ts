import { createCustodianApp, type SecretStore } from "../local/deepseek_custodian.ts";
import { createDeepSeekApp, startDeepSeekServer } from "../local/deepseek_server.ts";
import { MemoryMetadataStore } from "../local/deepseek_controller.ts";

class FakeStore implements SecretStore {
  value = "FAKE_SMOKE_KEY";
  put(value: string) {
    this.value = value;
    return Promise.resolve();
  }
  get() {
    return Promise.resolve(this.value);
  }
  delete() {
    this.value = "";
    return Promise.resolve();
  }
}
const credential = "smoke_dispatch_123456789012345678901234567890";
const store = new FakeStore();
const custodian = await createCustodianApp({
  dispatchCredential: credential,
  gatewayOrigin: "http://127.0.0.1:8787",
  store,
  providerFetch: () =>
    Promise.resolve(
      Response.json({
        choices: [{ message: { content: "smoke answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    ),
});
const client = {
  status: async () =>
    await (await custodian.fetch(
      new Request("http://127.0.0.1/internal/status", {
        headers: { Authorization: `Bearer ${credential}` },
      }),
    )).json(),
  invoke: async (input: unknown) =>
    await (await custodian.fetch(
      new Request("http://127.0.0.1/internal/invoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    )).json(),
  delete: async () => {},
};
const app = await createDeepSeekApp({
  custodianOrigin: "http://127.0.0.1:8788",
  dispatchCredential: credential,
  custodian: client,
  metadata: new MemoryMetadataStore(),
});
const server = startDeepSeekServer(app, 0);
try {
  const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  const home = await (await fetch(origin)).text();
  if (!home.includes("deepseek.chat.complete@v1") || home.includes(store.value)) {
    throw new Error("safe UI smoke failed");
  }
  console.log(
    "local-deepseek-smoke: fake custody configured; fixed grant visible; sentinel absent",
  );
} finally {
  await server.shutdown();
}
