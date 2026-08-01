import type {
  AttemptFinalization,
  AuthorityTransition,
  ChallengeCreationTransaction,
  ChallengeTransaction,
  DispatchClaimTransaction,
  DispatchPermitClaim,
  DispatchRecoveryTransaction,
  InvocationReservationTransaction,
  ReplayTransaction,
} from "../../../packages/core/src/store/authority_transaction.ts";
import { ids, type TenantContext } from "../../../packages/core/src/domain/types.ts";
import {
  InjectedFault,
  OfflineReferenceAuthority,
  type Owner,
} from "../fixtures/offline_reference_adapter.ts";

type Input = {
  action: string;
  root: string;
  owner?: Owner;
  transaction?: unknown;
  claim?: DispatchPermitClaim;
  custodyRef?: string;
  path?: string;
  fault?: string;
  mutation?: { path: string; value?: unknown; deletion?: boolean };
};
const input = JSON.parse(Deno.args[0] ?? "null") as Input;
if (!input?.root || !input.action) throw new Error("worker input denied");
const adapter = new OfflineReferenceAuthority(input.root);
const owner = (): Owner => {
  if (!input.owner) throw new Error("owner required");
  return input.owner;
};
const ctx = (): TenantContext => ({
  tenantId: ids.tenant(owner().tenantId),
  userId: ids.user(owner().userId),
});
let value: unknown;
try {
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
    case "raw":
      value = await adapter.read(false);
      break;
    case "consumeReplay":
      value = await adapter.consumeReplay(ctx(), input.transaction as ReplayTransaction);
      break;
    case "reserve":
      value = await adapter.reserveInvocation(
        ctx(),
        input.transaction as InvocationReservationTransaction,
      );
      break;
    case "reserveFault":
      value = await adapter.reserveInvocationFault(
        ctx(),
        input.transaction as InvocationReservationTransaction,
        input.fault as never,
      );
      break;
    case "claim":
      value = await adapter.claimDispatch(ctx(), input.transaction as DispatchClaimTransaction);
      break;
    case "claimFault":
      value = await adapter.claimDispatchFault(
        ctx(),
        input.transaction as DispatchClaimTransaction,
        input.fault as never,
      );
      break;
    case "dispatch":
      value = await adapter.dispatchWithPermit(ctx(), input.claim!, input.fault === "ambiguous");
      break;
    case "finalize":
      value = await adapter.finalizeAttempt(ctx(), input.transaction as AttemptFinalization);
      break;
    case "recover":
      value = await adapter.recoverDispatch(
        ctx(),
        input.transaction as DispatchRecoveryTransaction,
      );
      break;
    case "issue":
      value = await adapter.issueChallenge(
        ctx(),
        input.transaction as ChallengeCreationTransaction,
      );
      break;
    case "commit":
      value = await adapter.commitChallenge(ctx(), input.transaction as ChallengeTransaction);
      break;
    case "transition":
      value = await adapter.transitionAuthority(ctx(), input.transaction as AuthorityTransition);
      break;
    case "legacy":
      await adapter.writeLegacy(owner());
      value = true;
      break;
    case "migrate":
      value = await adapter.migrate(input.fault as never);
      break;
    case "snapshot":
      await adapter.snapshot(input.path!);
      value = true;
      break;
    case "replace":
      await Deno.copyFile(input.path!, adapter.statePath);
      value = true;
      break;
    case "restore":
      value = await adapter.restore(input.path!);
      break;
    case "mutate":
    case "mutatePath": {
      const targetPath = input.action === "mutatePath" ? input.path! : adapter.statePath;
      const state = JSON.parse(await Deno.readTextFile(targetPath)) as Record<string, unknown>;
      const segments = input.mutation!.path.split(".");
      let target = state;
      for (const segment of segments.slice(0, -1)) {
        target = target[segment] as Record<string, unknown>;
      }
      const last = segments.at(-1)!;
      if (input.mutation!.deletion) delete target[last];
      else target[last] = input.mutation!.value;
      await Deno.writeTextFile(targetPath, JSON.stringify(state));
      value = true;
      break;
    }
    default:
      throw new Error("worker action denied");
  }
  console.log(JSON.stringify({ outcome: "ok", value }));
} catch (error) {
  if (error instanceof InjectedFault) Deno.exit(75);
  console.log(JSON.stringify({ outcome: "denied" }));
}
