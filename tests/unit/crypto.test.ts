import { assert, equals, rejects } from "../assert.ts";
import { makeReceipt } from "../../packages/core/src/receipts/receipt.ts";
import {
  fixtureAgentSigner,
  fixtureCapabilityKeyring,
  fixtureDeviceSigner,
} from "../../packages/core/src/crypto/fixture_keys.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";
import {
  type CapabilityClaims,
  signCapability,
  verifyCapability,
} from "../../packages/core/src/crypto/capability.ts";
import {
  bodyHash,
  type RequestProofPayload,
  signRequestProof,
  verifyRequestProof,
} from "../../packages/core/src/crypto/request_proof.ts";
import {
  generateFlowKey,
  openFlowValue,
  sealFlowValue,
} from "../../packages/core/src/crypto/flow_crypto.ts";

const now = 2_000_000_000;
async function claims(): Promise<CapabilityClaims> {
  const signer = await fixtureDeviceSigner(0);
  return {
    iss: "urn:cairn:gateway",
    aud: "urn:cairn:invoke",
    sub: "agent_a",
    tenant_id: "tenant_a",
    user_id: "user_a",
    agent_id: "agent_a",
    device_id: signer.deviceId,
    connection_id: "connection_a",
    operations: ["github.user.read"],
    jti: "jti_01234567890123456789",
    iat: now,
    nbf: now,
    exp: now + 300,
    max_calls: 1,
    cnf: { jkt: await jwkThumbprint(await signer.publicJwk()) },
    grant_id: "grant_a",
    grant_version: 1,
    principal_epoch: 1,
    agent_epoch: 1,
    device_epoch: 1,
    connection_epoch: 1,
    policy_version: 1,
    schema_version: 1,
  };
}
Deno.test("RFC 7638 thumbprint is stable and excludes optional members", async () => {
  const jwk = await (await fixtureDeviceSigner(0)).publicJwk();
  equals(
    await jwkThumbprint(jwk),
    await jwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }),
  );
});
Deno.test("thumbprint rejects private JWK", async () => {
  await rejects(
    () => jwkThumbprint({ kty: "EC", crv: "P-256", x: "x", y: "y", d: "private" }),
    "public",
  );
});
Deno.test("strict five-minute one-call ES256 capability round trips", async () => {
  const keyring = await fixtureCapabilityKeyring();
  const input = await claims();
  equals(await verifyCapability(keyring, await signCapability(keyring, input), now), input);
});
Deno.test("capability signature tamper is denied", async () => {
  const keyring = await fixtureCapabilityKeyring();
  const token = await signCapability(keyring, await claims());
  const parts = token.split(".");
  parts[2] = `${parts[2]![0] === "A" ? "B" : "A"}${parts[2]!.slice(1)}`;
  await rejects(() => verifyCapability(keyring, parts.join("."), now), "invalid");
});
Deno.test("algorithm substitution is denied", async () => {
  const keyring = await fixtureCapabilityKeyring();
  const token = await signCapability(keyring, await claims());
  const parts = token.split(".");
  parts[0] = btoa(JSON.stringify({ alg: "none", kid: "fixture-2026-08", typ: "cairn-cap+jwt" }))
    .replaceAll("=", "");
  await rejects(() => verifyCapability(keyring, parts.join("."), now), "invalid");
});
Deno.test("overlong and expired capabilities are denied", async () => {
  const keyring = await fixtureCapabilityKeyring();
  const overlong = await claims();
  overlong.exp++;
  await rejects(() => signCapability(keyring, overlong), "invalid");
  const good = await claims();
  const token = await signCapability(keyring, good);
  await rejects(() => verifyCapability(keyring, token, now + 301), "invalid");
});
Deno.test("unknown semantic capability claim is denied", async () => {
  const keyring = await fixtureCapabilityKeyring();
  const token = await signCapability(keyring, await claims());
  const parts = token.split(".");
  const input = JSON.parse(atob(parts[1]!.replaceAll("-", "+").replaceAll("_", "/")));
  input.scope = "admin";
  parts[1] = btoa(JSON.stringify(input)).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
  await rejects(() => verifyCapability(keyring, parts.join("."), now), "invalid");
});
Deno.test("detached device proof binds query audience grant body and capability", async () => {
  const signer = await fixtureDeviceSigner(0);
  const body = new TextEncoder().encode("{}");
  const payload: RequestProofPayload = {
    v: 1,
    method: "POST",
    authority: "fixture.cairn.invalid",
    path: "/mcp",
    query: "",
    audience: "urn:cairn:gateway",
    body_sha256: await bodyHash(body),
    issued_at: now,
    nonce: "nonce_012345678901234567890",
    device_id: signer.deviceId,
    agent_id: "agent_a",
    grant_id: "grant_a",
    capability_sha256: "cap_hash",
  };
  const proof = await signRequestProof(signer, payload);
  assert(await verifyRequestProof(proof, await signer.publicJwk(), payload, now));
  assert(
    !await verifyRequestProof(
      proof,
      await signer.publicJwk(),
      { ...payload, grant_id: "grant_b" },
      now,
    ),
  );
  assert(
    !await verifyRequestProof(
      proof,
      await signer.publicJwk(),
      { ...payload, body_sha256: "other" },
      now,
    ),
  );
});
Deno.test("device proof timestamp outside skew is denied", async () => {
  const signer = await fixtureDeviceSigner(0);
  const payload: RequestProofPayload = {
    v: 1,
    method: "POST",
    authority: "fixture.cairn.invalid",
    path: "/mcp",
    query: "",
    audience: "urn:cairn:gateway",
    body_sha256: "hash",
    issued_at: now,
    nonce: "nonce_012345678901234567890",
    device_id: signer.deviceId,
    agent_id: "agent_a",
  };
  assert(
    !await verifyRequestProof(
      await signRequestProof(signer, payload),
      await signer.publicJwk(),
      payload,
      now + 31,
    ),
  );
});
Deno.test("agent key and capability issuer key are cryptographically distinct", async () => {
  const agent = await fixtureAgentSigner(), keyring = await fixtureCapabilityKeyring();
  const issuer = await keyring.verificationKey("fixture-2026-08", now);
  assert(issuer);
  assert(await jwkThumbprint(await agent.publicJwk()) !== await jwkThumbprint(issuer));
});
Deno.test("request proof rejects unknown semantic members", async () => {
  const signer = await fixtureDeviceSigner(0),
    payload: RequestProofPayload = {
      v: 1,
      method: "POST",
      authority: "fixture.cairn.invalid",
      path: "/mcp",
      query: "",
      audience: "urn:cairn:gateway",
      body_sha256: "hash",
      issued_at: now,
      nonce: "nonce_unknown_01234567890",
      device_id: signer.deviceId,
      agent_id: "agent_a",
    };
  const proof = await signRequestProof(
    signer,
    { ...payload, scope: "admin" } as RequestProofPayload,
  );
  assert(!await verifyRequestProof(proof, await signer.publicJwk(), payload, now));
});
Deno.test("receipt runtime gate sanitizes identifiers and rejects open reasons", () => {
  const base = {
    correlationId: "raw\nsecret",
    tenantId: "tenant",
    userId: "user",
    agentId: "agent",
    deviceId: "device",
    connectionId: "connection",
    operation: "github.user.read" as const,
    decision: "deny" as const,
    reason: "binding_denied" as const,
    at: now,
    latency: "lt100ms" as const,
    statusClass: "policy_denied" as const,
    responseSize: "none" as const,
    requestUnits: 0 as const,
    retryCount: 0 as const,
    redactionPolicyVersion: 1 as const,
  };
  equals(makeReceipt(base).correlationId, "invalid");
  let denied = false;
  try {
    makeReceipt({ ...base, reason: "raw_provider_error" as never });
  } catch {
    denied = true;
  }
  assert(denied);
  for (
    const patch of [
      { decision: "maybe" },
      { operation: "generic.http" },
      { latency: "raw" },
      { statusClass: "PROVIDER_SECRET_SENTINEL" },
      { responseSize: "unbounded" },
      { requestUnits: 2 },
      { retryCount: 1 },
      { redactionPolicyVersion: 2 },
    ]
  ) {
    let rejected = false;
    try {
      makeReceipt({ ...base, ...patch } as never);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});
Deno.test("flow PKCE material uses bound non-extractable AEAD", async () => {
  const key = await generateFlowKey();
  assert(!key.extractable);
  const sealed = await sealFlowValue(key, "verifier-sentinel", "flow_a");
  equals(await openFlowValue(key, sealed, "flow_a"), "verifier-sentinel");
  await rejects(() => openFlowValue(key, sealed, "flow_b"));
});
