import type {
  AttemptFinalization,
  AuthorityMaintenanceContext,
  AuthorityMaintenancePurpose,
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
import { createCandidateAdapter, type Owner } from "../fixtures/candidate_adapter_factory.ts";

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
const fault = input.fault === "abrupt_before_commit"
  ? "abrupt_before_commit"
  : input.fault === "abrupt_after_commit" || input.fault === "ambiguous"
  ? "abrupt_after_commit"
  : undefined;
const candidate = createCandidateAdapter(input.root, { fault });
const fixture = candidate.fixture;
const transactions: DurableAuthorityTransactions = candidate.transactions;
const maintenance: DurableAuthorityMaintenance = candidate.maintenance;
const owner = (): Owner => {
  if (!input.owner) throw new Error("owner required");
  return input.owner;
};
const ctx = (): TenantContext => ({
  tenantId: ids.tenant(owner().tenantId),
  userId: ids.user(owner().userId),
});
const maintenanceCtx = (
  purpose: "export" | "inspect" | "restore",
): AuthorityMaintenanceContext => {
  const value = input.owner ?? { tenantId: "tenant_a", userId: "user" };
  return fixture.issueMaintenanceContext({
    tenant: { tenantId: ids.tenant(value.tenantId), userId: ids.user(value.userId) },
    actorId: "stage1_worker",
    purpose,
  });
};
const authorityMaintenanceCtx = (
  purpose: AuthorityMaintenancePurpose,
): AuthorityMaintenanceContext =>
  fixture.issueAuthorityMaintenanceContext({ actorId: "stage1_authority_worker", purpose });
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
      value = await maintenance.inspectAuthority(
        maintenanceCtx("inspect"),
        input.transaction !== false,
      );
      break;
    case "export":
      value = await maintenance.exportAuthority(maintenanceCtx("export"));
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
        authorityMaintenanceCtx("initialize"),
        input.path ? await envelopeFromPath() : input.transaction as DurableAuthorityEnvelope,
      );
      break;
    case "prepareMigration":
      value = await maintenance.prepareMigration(
        authorityMaintenanceCtx("prepare_migration"),
        input.transaction as MigrationPreparation,
      );
      break;
    case "advanceMigration":
      value = await maintenance.advanceMigration(authorityMaintenanceCtx("advance_migration"));
      break;
    case "failMigration":
      value = await maintenance.failMigration(authorityMaintenanceCtx("fail_migration"));
      break;
    case "recoverMigration":
    case "migrate":
      value = await maintenance.recoverMigration(authorityMaintenanceCtx("recover_migration"));
      break;
    case "snapshot":
      await Deno.writeFile(
        input.path!,
        serializeDurableAuthority(await maintenance.exportAuthority(maintenanceCtx("export"))),
      );
      value = true;
      break;
    case "restore":
      value = await maintenance.restoreAuthority(
        maintenanceCtx("restore"),
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
} catch {
  console.log(JSON.stringify({ outcome: "denied" }));
}
