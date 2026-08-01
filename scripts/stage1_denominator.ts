interface Scenario {
  id: string;
  title: string;
}
const expectedIds = Array.from(
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
if (JSON.stringify(ids) !== JSON.stringify(expectedIds) || new Set(ids).size !== ids.length) {
  throw new Error("Stage 1A scenario IDs drifted");
}
if (scenarios.some((item) => !item.title || /skip|ignore/i.test(item.title))) {
  throw new Error("Stage 1A scenario metadata denied");
}

// Consume the runner's actual JUnit events; source registration text is not denominator evidence.
const report = await Deno.makeTempFile({ prefix: "cairn-stage1-events-", suffix: ".xml" });
try {
  const execution = await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--allow-read=.",
      "--allow-write",
      "--allow-run",
      `--junit-path=${report}`,
      "tests/stage1/durability_contract.test.ts",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!execution.success) {
    await Deno.stdout.write(execution.stdout);
    await Deno.stderr.write(execution.stderr);
    throw new Error(`Stage 1A execution failed: ${execution.code}`);
  }
  const xml = await Deno.readTextFile(report);
  const suite = /<testsuites\b([^>]*)>/.exec(xml)?.[1] ?? "";
  const attribute = (name: string): number => {
    const value = new RegExp(`${name}="(\\d+)"`).exec(suite)?.[1];
    if (value === undefined) throw new Error(`Stage 1A event count missing: ${name}`);
    return Number(value);
  };
  if (
    attribute("tests") !== 24 || attribute("failures") !== 0 || attribute("errors") !== 0 ||
    /<(skipped|failure|error)\b/.test(xml) || /disabled="[1-9]\d*"/.test(xml)
  ) {
    throw new Error("Stage 1A skipped, ignored, filtered, or failed event denied");
  }
  const actualNames = [...xml.matchAll(/<testcase\s+name="([^"]+)"/g)].map((match) =>
    match[1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&")
  );
  const expectedNames = scenarios.map((item) => `${item.id}: ${item.title}`);
  if (
    actualNames.length !== 24 || new Set(actualNames).size !== 24 ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(`Stage 1A executed-name denominator drift: ${JSON.stringify(actualNames)}`);
  }
  console.log(
    "stage1-denominator: 24 exact executed pass events; zero duplicate/skipped/ignored/filtered; total gate exactly 114",
  );
} finally {
  await Deno.remove(report).catch(() => undefined);
}
