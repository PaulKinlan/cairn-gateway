import type {
  AuthorityMaintenanceAuthorization,
  AuthorityMaintenanceContext,
  DurableAuthorityMaintenance,
  DurableAuthorityTransactions,
  GlobalAuthorityMaintenanceAuthorization,
} from "../../../packages/core/src/store/authority_transaction.ts";
import { type FaultPoint, OfflineReferenceAuthority } from "./offline_reference_adapter.ts";
import { DenoKvCandidateAuthority } from "./deno_kv_candidate_adapter.ts";
import type { Owner } from "./candidate_fixture_data.ts";
export { FIXTURE_JWKS, FIXTURE_THUMBPRINTS, type Owner } from "./candidate_fixture_data.ts";

/** Candidate-neutral conformance seam. Swap only this factory to run the unchanged driver/harness. */
export interface CandidateAdapter {
  transactions: DurableAuthorityTransactions;
  maintenance: DurableAuthorityMaintenance;
  fixture: CandidateFixtureDriver;
}

/** Setup/inspection is explicitly outside the conformance transaction and maintenance contracts. */
export interface CandidateFixtureDriver {
  initialize(): Promise<void>;
  seed(owner: Owner, custodyRef?: string): Promise<boolean>;
  inspect(owner: Owner): Promise<Record<string, unknown>>;
  writeLegacy(owner: Owner): Promise<void>;
  issueMaintenanceContext(input: AuthorityMaintenanceAuthorization): AuthorityMaintenanceContext;
  issueAuthorityMaintenanceContext(
    input: GlobalAuthorityMaintenanceAuthorization,
  ): AuthorityMaintenanceContext;
  readonly statePath: string;
  readonly lockPath: string;
  /**
   * Optional raw-store fixtures for candidates whose durable state is not the JSON file at
   * statePath. The worker's `mutate`/`replace` actions fall back to file manipulation only when
   * the selected candidate does not provide these; the offline reference candidate does not.
   */
  injectRawMutation?(
    mutation: { path: string; value?: unknown; deletion?: boolean },
  ): Promise<void>;
  installSnapshot?(path: string): Promise<void>;
}

export interface CandidateAdapterOptions {
  fault?: FaultPoint;
}

export type CandidateAdapterKind = "offline-reference" | "deno-kv";

/**
 * Canonical gates grant no env access, so selection falls back to the offline reference and their
 * behavior is unchanged. Only the dedicated `test:stage1:kv-candidate` task grants
 * `--allow-env=CAIRN_STAGE1_CANDIDATE` and sets the variable, selecting the Deno KV candidate for
 * the same unchanged 24 scenarios (candidate evidence; never part of the canonical denominator).
 */
export function candidateAdapterKind(): CandidateAdapterKind {
  let selected: string | undefined;
  try {
    selected = Deno.env.get("CAIRN_STAGE1_CANDIDATE");
  } catch {
    selected = undefined;
  }
  if (selected === undefined || selected === "") return "offline-reference";
  if (selected === "offline-reference" || selected === "deno-kv") return selected;
  throw new Error("candidate adapter selection denied");
}

/**
 * Extra worker-spawn runtime arguments required by the selected candidate. Empty for the
 * canonical offline reference (canonical gates unchanged); the Deno KV candidate needs
 * `--unstable-kv` (unstable API under Deno 2.8.1) and env access to propagate its selection.
 */
export function candidateWorkerRuntimeArgs(): string[] {
  return candidateAdapterKind() === "deno-kv"
    ? ["--unstable-kv", "--allow-env=CAIRN_STAGE1_CANDIDATE"]
    : [];
}

export function createCandidateAdapter(
  root: string,
  options: CandidateAdapterOptions = {},
): CandidateAdapter {
  if (candidateAdapterKind() === "deno-kv") {
    const fixture = new DenoKvCandidateAuthority(root, options.fault);
    return Object.freeze({
      transactions: fixture as DurableAuthorityTransactions,
      maintenance: fixture as DurableAuthorityMaintenance,
      fixture: fixture as CandidateFixtureDriver,
    });
  }
  const fixture = new OfflineReferenceAuthority(root, options.fault);
  return Object.freeze({
    transactions: fixture as DurableAuthorityTransactions,
    maintenance: fixture as DurableAuthorityMaintenance,
    fixture: fixture as CandidateFixtureDriver,
  });
}
