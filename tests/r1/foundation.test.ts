import { assert, equals, rejects } from "../assert.ts";
import { createR1FoundationFixture } from "../../packages/core/src/r1/foundation.ts";
import { R1OwnerUiSession } from "../../apps/control/r1_ui.ts";

async function journeyCall(
  client: Awaited<ReturnType<typeof createR1FoundationFixture>>["tenantA"]["clientA"],
  tool: "search_capabilities" | "describe_operation" | "connection_status" | "invoke_operation",
  connection: string,
) {
  if (tool === "search_capabilities") return await client.call(tool, { query: "github user" });
  if (tool === "describe_operation") {
    return await client.call(tool, { operation: "github.user.read@v1" });
  }
  if (tool === "connection_status") return await client.call(tool, { connection });
  return await client.call(tool, {
    operation: "github.user.read@v1",
    connection,
    arguments: {},
  });
}

Deno.test("fixture clients do not expose signing authority or gateway runtime properties", async () => {
  const foundation = await createR1FoundationFixture();
  const client = foundation.tenantA.clientA;
  equals(Reflect.ownKeys(client), ["id"]);
  equals(Reflect.ownKeys(Object.getPrototypeOf(client)).sort(), ["call", "constructor"]);
  assert(Object.isFrozen(client));

  const exposed = client as unknown as Record<string, unknown>;
  for (const key of ["signer", "gateway", "now", "sign", "dispatch", "privateKey", "publicJwk"]) {
    assert(!(key in exposed), `client exposes ${key}`);
    equals(exposed[key], undefined);
  }
});

Deno.test("verified request bodies strictly determine dispatch semantics", async () => {
  const foundation = await createR1FoundationFixture();
  equals(foundation.dispatchAdversarialResults, {
    malformed: "body denied",
    extraField: "body denied",
    schemaMismatch: "body denied",
    nonCanonical: "body denied",
    replay: "replay denied",
  });
});

Deno.test("one tenant-owned GitHub connection serves two named clients with independent revocation", async () => {
  const foundation = await createR1FoundationFixture();
  const tenant = foundation.tenantA;
  const connection = tenant.connectionId();
  const snapshot = tenant.snapshot();
  equals(snapshot.clients.length, 2);
  equals(new Set(snapshot.clients.map((client) => client.thumbprint)).size, 2);
  equals(
    new Set(snapshot.grants.map((grant) => grant.providerConnectionId)),
    new Set([connection]),
  );
  equals(snapshot.connection.configured, true);
  equals(snapshot.connection.health, "unknown");

  for (const client of [tenant.clientA, tenant.clientB]) {
    equals((await journeyCall(client, "search_capabilities", connection)).count, 1);
    equals((await journeyCall(client, "describe_operation", connection)).id, "github.user.read@v1");
    equals((await journeyCall(client, "connection_status", connection)).status, "connected");
    equals((await journeyCall(client, "invoke_operation", connection)).outcome, "success");
  }

  tenant.revokeClient("A");
  for (
    const tool of [
      "search_capabilities",
      "describe_operation",
      "connection_status",
      "invoke_operation",
    ] as const
  ) {
    await rejects(() => journeyCall(tenant.clientA, tool, connection), "client denied");
  }
  equals((await journeyCall(tenant.clientB, "search_capabilities", connection)).count, 1);
  equals((await journeyCall(tenant.clientB, "connection_status", connection)).status, "connected");
  equals((await journeyCall(tenant.clientB, "invoke_operation", connection)).outcome, "success");
});

Deno.test("disconnect denies both and reconnect creates fresh authority without reviving a client", async () => {
  const foundation = await createR1FoundationFixture();
  const tenant = foundation.tenantA;
  const oldConnection = tenant.connectionId();
  await tenant.disconnect();
  for (const client of [tenant.clientA, tenant.clientB]) {
    await rejects(
      () => journeyCall(client, "connection_status", oldConnection),
      "connection denied",
    );
    await rejects(
      () => journeyCall(client, "invoke_operation", oldConnection),
      "connection denied",
    );
  }

  const freshConnection = await tenant.reconnect();
  assert(freshConnection !== oldConnection, "reconnect reused dead connection authority");
  equals(tenant.snapshot().connection.authorityEpoch, 1);
  equals(
    (await journeyCall(tenant.clientA, "connection_status", freshConnection)).status,
    "connected",
  );
  equals(
    (await journeyCall(tenant.clientB, "invoke_operation", freshConnection)).outcome,
    "success",
  );

  tenant.revokeClient("A");
  await tenant.disconnect();
  const nextConnection = await tenant.reconnect();
  await rejects(
    () => journeyCall(tenant.clientA, "search_capabilities", nextConnection),
    "client denied",
  );
  equals(
    (await journeyCall(tenant.clientB, "invoke_operation", nextConnection)).outcome,
    "success",
  );
});

Deno.test("proof-derived tenant context isolates discovery status invocation custody and receipts", async () => {
  const foundation = await createR1FoundationFixture();
  const aConnection = foundation.tenantA.connectionId();
  const bConnection = foundation.tenantB.connectionId();
  equals(
    (await journeyCall(foundation.tenantA.clientA, "invoke_operation", aConnection)).outcome,
    "success",
  );
  equals(
    (await journeyCall(foundation.tenantB.clientA, "invoke_operation", bConnection)).outcome,
    "success",
  );
  foundation.tenantA.revokeClient("A");
  await rejects(
    () => journeyCall(foundation.tenantA.clientA, "search_capabilities", aConnection),
    "client denied",
  );
  const tenantBSearch = await journeyCall(
    foundation.tenantB.clientA,
    "search_capabilities",
    bConnection,
  );
  equals(
    (tenantBSearch.operations as Array<{ connection: string }>)[0]?.connection,
    bConnection,
  );
  equals(
    (await journeyCall(foundation.tenantB.clientA, "connection_status", bConnection)).status,
    "connected",
  );

  await rejects(
    () => journeyCall(foundation.tenantA.clientB, "connection_status", bConnection),
    "connection denied",
  );
  await rejects(
    () => journeyCall(foundation.tenantB.clientA, "invoke_operation", aConnection),
    "operation denied",
  );
  await rejects(
    () => foundation.assertCustodyReferenceUniqueAcrossTenants(),
    "custody ownership denied",
  );

  const aReceipts = foundation.tenantA.snapshot().receipts;
  const bReceipts = foundation.tenantB.snapshot().receipts;
  equals(aReceipts.length, 1);
  equals(bReceipts.length, 1);
  assert(aReceipts.every((receipt) => receipt.tenantId === foundation.tenantA.tenantId));
  assert(bReceipts.every((receipt) => receipt.tenantId === foundation.tenantB.tenantId));
  const serialized = JSON.stringify({ aReceipts, bReceipts });
  assert(!serialized.includes("custody"));
  assert(!serialized.includes("fixture-user"));
  assert(!serialized.includes("publicJwk"));
});

function csrf(html: string): string {
  const value = html.match(/name="csrf_token" value="([a-f0-9]{64})"/)?.[1];
  if (!value) throw new Error("csrf missing");
  return value;
}

Deno.test("server-rendered owner views show real authority facts and protect POST actions", async () => {
  const foundation = await createR1FoundationFixture();
  const tenant = foundation.tenantA;
  await journeyCall(tenant.clientA, "invoke_operation", tenant.connectionId());
  const origin = "https://fixture.cairn.invalid";
  const ui = new R1OwnerUiSession(tenant, origin);
  const connections = ui.render("connections");
  const agents = ui.render("agents");

  for (const html of [connections, agents]) {
    assert(html.startsWith("<!doctype html>"));
    assert(html.includes('<html lang="en">'));
    assert(html.includes('<nav aria-label="Owner">'));
    assert(!html.includes("<script"));
    assert(!html.includes("opaque_custody"));
    assert(!html.includes("privateJwk"));
    assert(!html.includes('name="tenant'));
  }
  assert(connections.includes("Configured"));
  assert(connections.includes("Health"));
  assert(connections.includes("no bounded check has run"));
  assert(agents.includes("P-256 fingerprint"));
  assert(agents.includes("Client A") && agents.includes("Client B"));
  assert(agents.includes("Secret-free invocation activity"));
  assert(agents.includes("policy_allow"));

  const post = (body: URLSearchParams, requestOrigin = origin) =>
    ui.post(
      new Request(`${origin}/owner/clients/a/revoke`, {
        method: "POST",
        headers: {
          Origin: requestOrigin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }),
    );
  equals(
    (await post(new URLSearchParams({ csrf_token: csrf(agents) }), "https://evil.invalid")).status,
    403,
  );
  equals(
    (await post(new URLSearchParams({ csrf_token: csrf(agents), tenant: "tenant_b" }))).status,
    403,
  );
  const response = await post(new URLSearchParams({ csrf_token: csrf(agents) }));
  equals(response.status, 200);
  const updated = await response.text();
  assert(updated.includes("Revoked at the named-client boundary"));
  await rejects(
    () => journeyCall(tenant.clientA, "search_capabilities", tenant.connectionId()),
    "client denied",
  );
  equals(
    (await journeyCall(tenant.clientB, "search_capabilities", tenant.connectionId())).count,
    1,
  );
});
