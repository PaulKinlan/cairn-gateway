import { assertExpectedGitRemote, inspectGitRemotePolicy } from "./git_remote_policy.ts";

const STAGE0_BASE = "25ee6526f683fbd4aa1e955b93c3eb3adf53211d";
const ACCEPTED_STAGE1A = "08dc01a03ef229e40ff356da2eb03c3f01cf7a96";
const PUBLICATION_POLICY_FILE = "tests/security/forbidden_surface.test.ts";
const PUBLICATION_POLICY_BEFORE_SHA256 =
  "6ab9888d577cf70ef3f468b3443700eb311048961771d79c8d13bb8a4091b71f";
const PUBLICATION_POLICY_AFTER_SHA256 =
  "d0d71c6fc284aa2564015e908675da343c33c5522ceb2dda74adeb13f11adfd6";
// M2 enrollment-wiring migration (feature/m2-real-enrollment, independent review
// f41a2f18): admits the real-enrollment product-path journey test and the Stage 0
// unit coverage for the new generated-signer core. Both hashes pinned so any later
// edit requires the same reviewed migration as the publication-policy precedent.
const ENROLLMENT_JOURNEY_FILE = "tests/integration/enrolled_journey.test.ts";
const ENROLLMENT_JOURNEY_SHA256 =
  "fc4380891d973043169af401572bed78d9b5e83505cec68c78c4ed30ca0e8b61";
const GENERATED_SIGNER_TEST_FILE = "tests/unit/generated_signer.test.ts";
const GENERATED_SIGNER_TEST_SHA256 =
  "f527e94390975c8ebef69638a99c737c96591e68367b48edb05c3f3191c5e04d";
const MIGRATED_FILES = [
  ENROLLMENT_JOURNEY_FILE,
  PUBLICATION_POLICY_FILE,
  GENERATED_SIGNER_TEST_FILE,
];
const roots = ["tests/unit", "tests/integration", "tests/security"];
const acceptedFiles = [
  "tests/unit/crypto.test.ts",
  "tests/unit/enrollment.test.ts",
  GENERATED_SIGNER_TEST_FILE,
  "tests/unit/mcp.test.ts",
  "tests/unit/store.test.ts",
  ENROLLMENT_JOURNEY_FILE,
  "tests/integration/local_flow.test.ts",
  PUBLICATION_POLICY_FILE,
  "tests/security/negative.test.ts",
];
const command = async (args: string[]): Promise<string> => {
  const result = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error("Stage 0 provenance denied");
  return new TextDecoder().decode(result.stdout).trim();
};
for (const ancestor of [STAGE0_BASE, ACCEPTED_STAGE1A]) {
  if (
    !(await command(["merge-base", "--is-ancestor", ancestor, "HEAD"]).then(
      () => true,
      () => false,
    ))
  ) {
    throw new Error(`HEAD does not descend from accepted provenance ${ancestor}`);
  }
}
assertExpectedGitRemote(await inspectGitRemotePolicy());
const changed = (await command(["diff", "--name-only", ACCEPTED_STAGE1A, "--", ...roots]))
  .split("\n").filter(Boolean);
if (JSON.stringify(changed) !== JSON.stringify(MIGRATED_FILES)) {
  throw new Error(`accepted Stage 0 tests changed outside policy migration: ${changed.join(",")}`);
}
const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const migratedHash = await sha256(await Deno.readFile(PUBLICATION_POLICY_FILE));
if (migratedHash !== PUBLICATION_POLICY_AFTER_SHA256) {
  throw new Error("publication-policy test hash drifted");
}
// The before hash is retained in executable provenance so review can verify the one-file migration.
if (PUBLICATION_POLICY_BEFORE_SHA256 === PUBLICATION_POLICY_AFTER_SHA256) {
  throw new Error("publication-policy provenance invalid");
}
for (
  const [file, expected] of [
    [ENROLLMENT_JOURNEY_FILE, ENROLLMENT_JOURNEY_SHA256],
    [GENERATED_SIGNER_TEST_FILE, GENERATED_SIGNER_TEST_SHA256],
  ] as const
) {
  if (await sha256(await Deno.readFile(file)) !== expected) {
    throw new Error(`enrollment-wiring migration test hash drifted: ${file}`);
  }
}
let count = 0;
for (const file of acceptedFiles) {
  const source = await Deno.readTextFile(file);
  count += source.match(/\bDeno\.test\s*\(/g)?.length ?? 0;
}
if (count !== 96) throw new Error(`Stage 0 denominator drift: ${count}`);
console.log(
  `stage0-denominator: base ${STAGE0_BASE}; accepted Stage1A ${ACCEPTED_STAGE1A}; 6 byte-identical files + 1 exact publication-policy migration (${PUBLICATION_POLICY_BEFORE_SHA256} -> ${PUBLICATION_POLICY_AFTER_SHA256}) + 2 pinned enrollment-wiring tests; exactly ${count} tests`,
);
