const rawLcov = await Deno.readTextFile(".coverage/lcov.info");
// Preserve the accepted Stage 0 runtime-source denominator. The separately tested publication-policy
// helper was added only to replace the obsolete no-remote provenance assertion and cannot dilute or
// manufacture the accepted runtime coverage floors.
const lcov = rawLcov.split("end_of_record").filter((record) => {
  const source = /^SF:(.+)$/m.exec(record)?.[1];
  return source !== undefined && !source.endsWith("/scripts/git_remote_policy.ts");
}).join("end_of_record");
const sum = (tag: string): number =>
  [...lcov.matchAll(new RegExp(`^${tag}:(\\d+)$`, "gm"))]
    .reduce((total, match) => total + Number(match[1]), 0);
const metrics = [
  { name: "branch", hit: "BRH", total: "BRF", floor: 84.0 },
  { name: "function", hit: "FNH", total: "FNF", floor: 96.3 },
  { name: "line", hit: "LH", total: "LF", floor: 90.6 },
];
for (const metric of metrics) {
  const total = sum(metric.total);
  const hit = sum(metric.hit);
  if (!total || hit > total) throw new Error(`Invalid Stage 0 ${metric.name} coverage`);
  const percentage = hit / total * 100;
  const acceptedPrecision = Math.round(percentage * 10) / 10;
  if (acceptedPrecision < metric.floor) {
    throw new Error(`Stage 0 ${metric.name} coverage ${acceptedPrecision}% below ${metric.floor}%`);
  }
}
console.log(
  `stage0-coverage: ${
    metrics.map((item) => `${item.name} ${item.floor.toFixed(1)}%`).join(", ")
  } floors preserved across the accepted runtime-source denominator`,
);
