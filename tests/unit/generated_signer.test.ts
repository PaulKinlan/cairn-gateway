import { assert, equals } from "../assert.ts";
import {
  generateCapabilityKeyring,
  generateP256Signer,
} from "../../packages/core/src/crypto/generated_signer.ts";
import {
  type CapabilityClaims,
  signCapability,
  verifyCapability,
} from "../../packages/core/src/crypto/capability.ts";
import { jwkThumbprint } from "../../packages/core/src/crypto/thumbprint.ts";
import { bufferSource } from "../../packages/core/src/crypto/encoding.ts";

Deno.test("generated P-256 signer exposes the id, a public-only JWK, and verifiable signatures", async () => {
  const signer = await generateP256Signer("device_real_a");
  equals(signer.deviceId, "device_real_a");
  assert(Object.isFrozen(signer));
  const jwk = await signer.publicJwk();
  equals(jwk.kty, "EC");
  equals(jwk.crv, "P-256");
  assert(typeof jwk.x === "string" && typeof jwk.y === "string");
  equals(jwk.d, undefined);
  const message = new TextEncoder().encode("cairn generated signer coverage");
  const signature = await signer.sign(message);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      bufferSource(signature),
      bufferSource(message),
    ),
  );
  assert(
    !(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      bufferSource(signature),
      bufferSource(new TextEncoder().encode("different message")),
    )),
  );
});

Deno.test("generated signers are non-deterministic fresh keys, unlike fixture material", async () => {
  const first = await generateP256Signer("device_a");
  const second = await generateP256Signer("device_a");
  assert(
    (await jwkThumbprint(await first.publicJwk())) !==
      (await jwkThumbprint(await second.publicJwk())),
  );
});

Deno.test("generated capability keyring activates its kid and hides other kids", async () => {
  const keyring = await generateCapabilityKeyring("cap-real-1");
  assert(Object.isFrozen(keyring));
  const active = await keyring.active();
  equals(active.kid, "cap-real-1");
  assert(active.privateKey instanceof CryptoKey);
  const jwk = await keyring.verificationKey("cap-real-1", 1_700_000_000);
  assert(jwk !== undefined);
  equals(jwk.kty, "EC");
  equals(jwk.crv, "P-256");
  equals(jwk.d, undefined);
  equals(await keyring.verificationKey("cap-other", 1_700_000_000), undefined);
});

Deno.test("generated capability keyring signs capabilities that verify through the core", async () => {
  const keyring = await generateCapabilityKeyring("cap-roundtrip");
  const now = 1_700_000_000;
  const claims: CapabilityClaims = {
    iss: "urn:cairn:gateway",
    aud: "urn:cairn:invoke",
    sub: "agent_real",
    tenant_id: "tenant_real",
    user_id: "user_real",
    agent_id: "agent_real",
    device_id: "device_real",
    connection_id: "connection_real",
    operations: ["github.user.read"],
    jti: "jti_generated_signer_coverage",
    iat: now,
    nbf: now,
    exp: now + 300,
    max_calls: 1,
    cnf: { jkt: await jwkThumbprint(await (await generateP256Signer("device_real")).publicJwk()) },
    grant_id: "grant_real",
    grant_version: 1,
    principal_epoch: 1,
    agent_epoch: 1,
    device_epoch: 1,
    connection_epoch: 1,
    policy_version: 1,
    schema_version: 1,
  };
  const token = await signCapability(keyring, claims);
  const verified = await verifyCapability(keyring, token, now + 1);
  equals(verified.grant_id, "grant_real");
  equals(verified.sub, "agent_real");
});
