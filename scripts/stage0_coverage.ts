const lcov = await Deno.readTextFile(".coverage/lcov.info");
const sum = (tag: string): number =>
  [...lcov.matchAll(new RegExp(`^${tag}:(\\d+)$`, "gm"))]
    .reduce((total, match) => total + Number(match[1]), 0);
const metrics = [
  { name: "branch", hit: sum("BRH"), found: sum("BRF"), floor: 84.0 },
  { name: "function", hit: sum("FNH"), found: sum("FNF"), floor: 96.3 },
  { name: "line", hit: sum("LH"), found: sum("LF"), floor: 90.6 },
];
for (const metric of metrics) {
  const exact = metric.found ? metric.hit * 100 / metric.found : 100;
  const acceptedPrecision = Math.round(exact * 10) / 10;
  if (acceptedPrecision < metric.floor) {
    throw new Error(`Stage 0 ${metric.name} coverage ${acceptedPrecision}% below ${metric.floor}%`);
  }
}
console.log(
  `stage0-coverage: ${
    metrics.map((item) => `${item.name} ${item.floor.toFixed(1)}%`).join(", ")
  } floors preserved`,
);
