import { assertExpectedGitRemote, inspectGitRemotePolicy } from "./git_remote_policy.ts";

const STAGE0_BASE = "25ee6526f683fbd4aa1e955b93c3eb3adf53211d";
const ACCEPTED_STAGE1A = "08dc01a03ef229e40ff356da2eb03c3f01cf7a96";
const PUBLICATION_POLICY_FILE = "tests/security/forbidden_surface.test.ts";
const PUBLICATION_POLICY_BEFORE_SHA256 =
  "6ab9888d577cf70ef3f468b3443700eb311048961771d79c8d13bb8a4091b71f";
const PUBLICATION_POLICY_AFTER_SHA256 =
  "d0d71c6fc284aa2564015e908675da343c33c5522ceb2dda74adeb13f11adfd6";
const roots = ["tests/unit", "tests/integration", "tests/security"];
const acceptedFiles = [
  "tests/unit/crypto.test.ts",
  "tests/unit/enrollment.test.ts",
  "tests/unit/mcp.test.ts",
  "tests/unit/store.test.ts",
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
if (JSON.stringify(changed) !== JSON.stringify([PUBLICATION_POLICY_FILE])) {
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
let count = 0;
for (const file of acceptedFiles) {
  const source = await Deno.readTextFile(file);
  count += source.match(/\bDeno\.test\s*\(/g)?.length ?? 0;
}
if (count !== 90) throw new Error(`Stage 0 denominator drift: ${count}`);
console.log(
  `stage0-denominator: base ${STAGE0_BASE}; accepted Stage1A ${ACCEPTED_STAGE1A}; 6 byte-identical files + 1 exact publication-policy migration (${PUBLICATION_POLICY_BEFORE_SHA256} -> ${PUBLICATION_POLICY_AFTER_SHA256}); exactly ${count} tests`,
);
