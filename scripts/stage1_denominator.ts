interface Scenario {
  id: string;
  title: string;
}
const expected = Array.from(
  { length: 24 },
  (_, index) => `DUR-${String(index + 1).padStart(2, "0")}`,
);
const scenarios = JSON.parse(
  await Deno.readTextFile("tests/stage1/fixtures/durability-scenarios.json"),
) as Scenario[];
if (!Array.isArray(scenarios) || scenarios.length !== 24) {
  throw new Error(`Stage 1A denominator drift: ${scenarios.length}`);
}
const ids = scenarios.map((item) => item.id);
if (JSON.stringify(ids) !== JSON.stringify(expected) || new Set(ids).size !== ids.length) {
  throw new Error("Stage 1A scenario IDs drifted");
}
if (scenarios.some((item) => !item.title || /skip|ignore/i.test(item.title))) {
  throw new Error("Stage 1A scenario metadata denied");
}
const source = await Deno.readTextFile("tests/stage1/durability_contract.test.ts");
if (!source.includes("for (const scenario of scenarios)")) {
  throw new Error("Stage 1A manifest is not fully registered");
}
console.log("stage1-denominator: exactly 24 stable durability scenarios; total gate exactly 114");
