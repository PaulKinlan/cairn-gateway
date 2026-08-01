import { OfflineReferenceAuthority, type Owner } from "../fixtures/offline_reference_adapter.ts";

type Input = {
  action: string;
  root: string;
  owner?: Owner;
  id?: string;
  hash?: string;
  hashes?: string[];
  kind?: "nonce" | "jti";
  expiresAt?: number;
  now?: number;
  suffix?: string;
  enrollmentId?: string;
  subject?: "principal" | "agent" | "device" | "grant" | "connection";
  status?: "active" | "revoked";
  version?: number;
  custodyRef?: string;
  path?: string;
};
const input = JSON.parse(Deno.args[0] ?? "null") as Input;
if (!input?.root || !input.action) throw new Error("worker input denied");
const adapter = new OfflineReferenceAuthority(input.root);
const owner = (): Owner => {
  if (!input.owner) throw new Error("owner required");
  return input.owner;
};
let value: unknown;
try {
  if (["consume", "beginDispatch", "consumeChallenge"].includes(input.action)) {
    const jitter = crypto.getRandomValues(new Uint8Array(1))[0]! % 13;
    await new Promise((resolve) => setTimeout(resolve, jitter));
  }
  switch (input.action) {
    case "initialize":
      await adapter.initialize();
      value = true;
      break;
    case "seed":
      value = await adapter.seed(owner(), input.custodyRef);
      break;
    case "inspect":
      value = await adapter.inspect(owner());
      break;
    case "consume":
      value = await adapter.consume(
        owner(),
        input.kind!,
        input.hashes!,
        input.expiresAt!,
        input.now!,
      );
      break;
    case "reserve":
      value = await adapter.reserve(owner(), input.id!, input.now!, input.suffix);
      break;
    case "beginDispatch":
      value = await adapter.beginDispatch(owner(), input.id!);
      break;
    case "unknown":
      value = await adapter.markDispatchUnknown(owner(), input.id!);
      break;
    case "issueChallenge":
      value = await adapter.issueChallenge(owner(), input.id!, input.hash!, input.expiresAt!);
      break;
    case "consumeChallenge":
      value = await adapter.consumeChallenge(
        owner(),
        input.id!,
        input.hash!,
        input.now!,
        input.enrollmentId,
      );
      break;
    case "transition":
      value = await adapter.transition(owner(), input.subject!, input.status!, input.version!);
      break;
    case "legacy":
      await adapter.writeLegacy(owner());
      value = true;
      break;
    case "migrate":
      value = await adapter.migrate();
      break;
    case "snapshot":
      await adapter.snapshot(input.path!);
      value = true;
      break;
    case "restore":
      value = await adapter.restore(input.path!);
      break;
    case "corrupt":
      await adapter.corrupt();
      value = true;
      break;
    case "crashBefore":
      Deno.exit(75);
      break;
    case "reserveExit":
      await adapter.reserve(owner(), input.id!, input.now!, input.suffix);
      Deno.exit(75);
      break;
    case "dispatchExit":
      await adapter.beginDispatch(owner(), input.id!);
      Deno.exit(75);
      break;
    default:
      throw new Error("worker action denied");
  }
  console.log(JSON.stringify({ outcome: "ok", value }));
} catch {
  console.log(JSON.stringify({ outcome: "denied" }));
}
