import { createCustodianApp, SecretToolStore } from "./deepseek_custodian.ts";

const port = Number(Deno.env.get("CAIRN_CUSTODIAN_PORT"));
const gatewayOrigin = Deno.env.get("CAIRN_GATEWAY_ORIGIN") ?? "";
const dispatchCredential = Deno.env.get("CAIRN_DISPATCH_CREDENTIAL") ?? "";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("custodian port denied");
const app = createCustodianApp({ dispatchCredential, gatewayOrigin, store: new SecretToolStore() });
Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, (request) => app.fetch(request));
console.log(`Cairn key custodian listening on http://127.0.0.1:${port}/intake`);
