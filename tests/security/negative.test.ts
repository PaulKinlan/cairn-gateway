import { assert, rejects } from "../assert.ts";
import { invokeGithubUserRead } from "../../packages/core/src/connectors/github_user.ts";
import type {
  CustodyAdapter,
  CustodyBinding,
  CustodyResponse,
  FixedOperationInput,
} from "../../packages/core/src/custody/custody_adapter.ts";
import { MemorySafeLogger } from "../../packages/core/src/logging/safe_logger.ts";
class ResponseFixture implements CustodyAdapter {
  constructor(private response: CustodyResponse) {}
  beginAuthorization() {
    return Promise.resolve({ handle: "h", callbackOwnership: "gateway" as const, expiresAt: 1 });
  }
  completeAuthorization() {
    return Promise.resolve({ status: "active" as const });
  }
  connectionStatus() {
    return Promise.resolve({ status: "active" as const });
  }
  proxyOperation(_binding: CustodyBinding, input: FixedOperationInput) {
    assert(
      input.path === "/user" && input.method === "GET" && input.integration === "github-cairn-v1",
    );
    return Promise.resolve(this.response);
  }
  revokeConnection() {
    return Promise.resolve({ status: "revoked" as const });
  }
}
const binding: CustodyBinding = {
  context: { tenantId: "tenant_a" as never, userId: "user_a" as never },
  connectionId: "connection_a",
  connectionRef: "ref",
  integration: "github-cairn-v1",
  redirectUri: "https://fixture.cairn.invalid/oauth/github/callback",
};
const response = (body: unknown, contentType = "application/json"): CustodyResponse => ({
  outcome: "success",
  status: 200,
  contentType,
  body: new TextEncoder().encode(JSON.stringify(body)),
});
const good = {
  id: 1,
  login: "fixture",
  name: null,
  html_url: "https://github.com/fixture",
  avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
};
Deno.test("SSRF-shaped connector arguments are rejected before custody", async () => {
  for (
    const args of [
      { url: "http://169.254.169.254/latest/meta-data" },
      { base: "https://127.0.0.1" },
      { headers: { Authorization: "sentinel" } },
      { path: "//evil.invalid" },
      { method: "POST" },
      { body: "x" },
    ]
  ) {
    await rejects(
      () => invokeGithubUserRead(new ResponseFixture(response(good)), binding, args),
      "arguments denied",
    );
  }
});
Deno.test("projector rejects unsafe reflected URLs", async () => {
  for (
    const url of [
      "http://github.com/x",
      "https://github.com@evil.invalid/x",
      "https://127.0.0.1/x",
      "https://github.com/x?token=sentinel",
      "https://github.com/x#fragment",
    ]
  ) {
    const result = await invokeGithubUserRead(
      new ResponseFixture(response({ ...good, html_url: url })),
      binding,
      {},
    );
    assert(result.outcome === "provider_unavailable");
  }
});
Deno.test("projector denies wrong content type and oversized response", async () => {
  assert(
    (await invokeGithubUserRead(new ResponseFixture(response(good, "text/html")), binding, {}))
      .outcome === "provider_unavailable",
  );
  const oversized: CustodyResponse = {
    outcome: "success",
    status: 200,
    contentType: "application/json",
    body: new Uint8Array(65_537),
  };
  assert(
    (await invokeGithubUserRead(new ResponseFixture(oversized), binding, {})).outcome ===
      "provider_unavailable",
  );
});
Deno.test("projector drops unknown provider fields and sentinels", async () => {
  const result = await invokeGithubUserRead(
    new ResponseFixture(response({ ...good, tokenish_field: "PROVIDER_SENTINEL_9x" })),
    binding,
    {},
  );
  assert(result.outcome === "success" && !JSON.stringify(result).includes("PROVIDER_SENTINEL_9x"));
});
Deno.test("schema poisoning types fail safely", async () => {
  for (
    const poisoned of [
      { ...good, id: "1" },
      { ...good, login: ["x"] },
      { ...good, name: { toString: "x" } },
      null,
      [],
      "string",
    ]
  ) {
    assert(
      (await invokeGithubUserRead(new ResponseFixture(response(poisoned)), binding, {})).outcome ===
        "provider_unavailable",
    );
  }
});
Deno.test("allowlisted logger cannot accept provider objects at type boundary", () => {
  const logger = new MemorySafeLogger();
  logger.emit({
    type: "decision",
    correlationId: "c",
    tenantId: "t",
    operation: "github.user.read",
    decision: "deny",
    reason: "policy",
  });
  assert(!JSON.stringify(logger.events).includes("PROVIDER_SENTINEL"));
});
Deno.test("property sweep of hostile argument keys always denies", async () => {
  const alphabet = [
    "url",
    "URL",
    "redirect",
    "host",
    "__proto__",
    "query",
    "cookie",
    "credential",
    "baseUrlOverride",
  ];
  for (let i = 0; i < 128; i++) {
    const key = `${alphabet[i % alphabet.length]}_${i}`;
    await rejects(() =>
      invokeGithubUserRead(new ResponseFixture(response(good)), binding, { [key]: `value_${i}` })
    );
  }
});
