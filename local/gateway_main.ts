import { createDeepSeekApp, startDeepSeekServer } from "./deepseek_server.ts";

const port = Number(Deno.env.get("CAIRN_GATEWAY_PORT"));
const custodianOrigin = Deno.env.get("CAIRN_CUSTODIAN_ORIGIN") ?? "";
const dispatchCredential = Deno.env.get("CAIRN_DISPATCH_CREDENTIAL") ?? "";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("gateway port denied");
const app = await createDeepSeekApp({ custodianOrigin, dispatchCredential });
startDeepSeekServer(app, port);
console.log(`Cairn gateway listening on http://127.0.0.1:${port}/`);
