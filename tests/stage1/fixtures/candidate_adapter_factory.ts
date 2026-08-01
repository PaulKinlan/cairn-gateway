import type {
  DurableAuthorityMaintenance,
  DurableAuthorityTransactions,
} from "../../../packages/core/src/store/authority_transaction.ts";
import { type FaultPoint, OfflineReferenceAuthority } from "./offline_reference_adapter.ts";
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
  readonly statePath: string;
  readonly lockPath: string;
}

export interface CandidateAdapterOptions {
  fault?: FaultPoint;
}

export function createCandidateAdapter(
  root: string,
  options: CandidateAdapterOptions = {},
): CandidateAdapter {
  const fixture = new OfflineReferenceAuthority(root, options.fault);
  return Object.freeze({
    transactions: fixture as DurableAuthorityTransactions,
    maintenance: fixture as DurableAuthorityMaintenance,
    fixture: fixture as CandidateFixtureDriver,
  });
}
