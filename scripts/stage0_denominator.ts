const BASE = "25ee6526f683fbd4aa1e955b93c3eb3adf53211d";
const roots = ["tests/unit", "tests/integration", "tests/security"];
const acceptedFiles = [
  "tests/unit/crypto.test.ts",
  "tests/unit/enrollment.test.ts",
  "tests/unit/mcp.test.ts",
  "tests/unit/store.test.ts",
  "tests/integration/local_flow.test.ts",
  "tests/security/forbidden_surface.test.ts",
  "tests/security/negative.test.ts",
];
const command = async (args: string[]): Promise<string> => {
  const result = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error("Stage 0 provenance denied");
  return new TextDecoder().decode(result.stdout).trim();
};
if (!(await command(["merge-base", "--is-ancestor", BASE, "HEAD"]).then(() => true, () => false))) {
  throw new Error("HEAD does not descend from accepted Stage 0");
}
if ((await command(["remote"])).length) throw new Error("Git remote denied");
const changed = await command(["diff", "--name-only", BASE, "--", ...roots]);
if (changed) throw new Error(`accepted Stage 0 tests changed: ${changed}`);
let count = 0;
for (const file of acceptedFiles) {
  const source = await Deno.readTextFile(file);
  count += source.match(/\bDeno\.test\s*\(/g)?.length ?? 0;
}
if (count !== 90) throw new Error(`Stage 0 denominator drift: ${count}`);
console.log(`stage0-denominator: base ${BASE}; 7 unchanged files; exactly ${count} tests`);
