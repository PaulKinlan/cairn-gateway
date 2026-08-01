import type {
  AttemptFinalization,
  AuthorityTransition,
  ChallengeCreationTransaction,
  ChallengeTransaction,
  DispatchClaimTransaction,
  DispatchRecoveryTransaction,
  DispatchStartTransaction,
  DurableAuthorityMaintenance,
  DurableAuthorityTransactions,
  InvocationReservationTransaction,
  MigrationPreparation,
  ReplayTransaction,
} from "../../../packages/core/src/store/authority_transaction.ts";
import { ids, type TenantContext } from "../../../packages/core/src/domain/types.ts";
import type { DurableAuthorityEnvelope } from "../../../packages/core/src/store/schema.ts";
import { serializeDurableAuthority } from "../../../packages/core/src/store/schema.ts";
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
  custodyRef?: string;
  path?: string;
  fault?: string;
  mutation?: { path: string; value?: unknown; deletion?: boolean };
};
const input = JSON.parse(Deno.args[0] ?? "null") as Input;
if (!input?.root || !input.action) throw new Error("worker input denied");
const injectedFault = ["before_rename", "after_commit_before_reply"].includes(input.fault ?? "")
  ? input.fault as "before_rename" | "after_commit_before_reply"
  : undefined;
const fixture = new OfflineReferenceAuthority(input.root, injectedFault);
const transactions: DurableAuthorityTransactions = fixture;
const maintenance: DurableAuthorityMaintenance = fixture;
const owner = (): Owner => {
  if (!input.owner) throw new Error("owner required");
  return input.owner;
};
const ctx = (): TenantContext => ({
  tenantId: ids.tenant(owner().tenantId),
  userId: ids.user(owner().userId),
});
const envelopeFromPath = async (): Promise<DurableAuthorityEnvelope> =>
  JSON.parse(await Deno.readTextFile(input.path!)) as DurableAuthorityEnvelope;
let value: unknown;
try {
  switch (input.action) {
    case "initialize":
      await fixture.initialize();
      value = true;
      break;
    case "seed":
      value = await fixture.seed(owner(), input.custodyRef);
      break;
    case "inspect":
      value = await fixture.inspect(owner());
      break;
    case "inspectAuthority":
    case "raw":
      value = await maintenance.inspectAuthority(input.transaction !== false);
      break;
    case "export":
      value = await maintenance.exportAuthority();
      break;
    case "consumeReplay":
      value = await transactions.consumeReplay(ctx(), input.transaction as ReplayTransaction);
      break;
    case "reserve":
      value = await transactions.reserveInvocation(
        ctx(),
        input.transaction as InvocationReservationTransaction,
      );
      break;
    case "reserveFault":
      value = await transactions.reserveInvocation(
        ctx(),
        input.transaction as InvocationReservationTransaction,
      );
      break;
    case "claim":
      value = await transactions.claimDispatch(
        ctx(),
        input.transaction as DispatchClaimTransaction,
      );
      break;
    case "claimFault":
      value = await transactions.claimDispatch(
        ctx(),
        input.transaction as DispatchClaimTransaction,
      );
      break;
    case "start":
    case "dispatch":
      value = await transactions.startDispatch(
        ctx(),
        input.transaction as DispatchStartTransaction,
      );
      if (input.fault === "ambiguous" && (value as { outcome: string }).outcome === "authorized") {
        throw new InjectedFault("dispatch_start_ambiguity");
      }
      break;
    case "finalize":
      value = await transactions.finalizeAttempt(ctx(), input.transaction as AttemptFinalization);
      break;
    case "recover":
      value = await transactions.recoverDispatch(
        ctx(),
        input.transaction as DispatchRecoveryTransaction,
      );
      break;
    case "issue":
      value = await transactions.issueChallenge(
        ctx(),
        input.transaction as ChallengeCreationTransaction,
      );
      break;
    case "commit":
      value = await transactions.commitChallenge(ctx(), input.transaction as ChallengeTransaction);
      break;
    case "transition":
      value = await transactions.transitionAuthority(
        ctx(),
        input.transaction as AuthorityTransition,
      );
      break;
    case "legacy":
      await fixture.writeLegacy(owner());
      value = true;
      break;
    case "initializeAuthority":
      value = await maintenance.initializeAuthority(
        input.path ? await envelopeFromPath() : input.transaction as DurableAuthorityEnvelope,
      );
      break;
    case "prepareMigration":
      value = await maintenance.prepareMigration(input.transaction as MigrationPreparation);
      break;
    case "advanceMigration":
      value = await maintenance.advanceMigration();
      break;
    case "failMigration":
      value = await maintenance.failMigration();
      break;
    case "recoverMigration":
    case "migrate":
      value = await maintenance.recoverMigration();
      break;
    case "snapshot":
      await Deno.writeFile(
        input.path!,
        serializeDurableAuthority(await maintenance.exportAuthority()),
      );
      value = true;
      break;
    case "restore":
      value = await maintenance.restoreAuthority(
        input.path ? await envelopeFromPath() : input.transaction as DurableAuthorityEnvelope,
      );
      break;
    case "replace":
      await Deno.copyFile(input.path!, fixture.statePath);
      value = true;
      break;
    case "mutate":
    case "mutatePath": {
      const targetPath = input.action === "mutatePath" ? input.path! : fixture.statePath;
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
