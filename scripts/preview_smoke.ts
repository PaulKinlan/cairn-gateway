import preview from "../preview/main.ts";

const response = preview.fetch(new Request("https://preview.cairn.invalid/healthz"));
const health = await response.json();
if (
  response.status !== 200 ||
  health.schema !== "cairn.preview.health.v1" ||
  health.status !== "healthy" ||
  health.previewProcess !== "healthy" ||
  health.invocationEnabled !== false
) {
  throw new Error("credential-free preview smoke check failed");
}
console.log("preview-smoke: healthy; invocation disabled; no runtime permissions requested");
