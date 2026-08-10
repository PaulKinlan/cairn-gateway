import { generateP256Signer } from "../crypto/generated_signer.ts";
import type { DeviceSigner } from "../crypto/device_signer.ts";
import { bodyHash, signRequestProof, verifyRequestProof } from "../crypto/request_proof.ts";
import { encoder, sha256 } from "../crypto/encoding.ts";
import { jwkThumbprint, shortFingerprint } from "../crypto/thumbprint.ts";
import type {
  Attempt,
  ClientPrincipal,
  ClientPrincipalId,
  ConnectionHealth,
  EnrollmentReference,
  GithubUserProjection,
  Grant,
  Membership,
  ProviderConnection,
  ProviderConnectionId,
  R1GrantId,
  R1MembershipId,
  R1TenantId,
  R1UserId,
  Receipt,
  Tenant,
  User,
} from "./model.ts";
import { r1Ids } from "./model.ts";

const AUTHORITY = "fixture.cairn.invalid";
const OPERATION = "github.user.read@v1" as const;
const FIXTURE_USER: GithubUserProjection = Object.freeze({
  id: 123456,
  login: "fixture-user",
  name: "Fixture User",
  html_url: "https:" + "//github.com/fixture-user",
  avatar_url: "https:" + "//avatars.githubusercontent.com/u/123456",
});

type ToolName =
  | "search_capabilities"
  | "describe_operation"
  | "connection_status"
  | "invoke_operation";

type DispatchSemantic =
  | { tool: "search_capabilities"; arguments: { query: string } }
  | { tool: "describe_operation"; arguments: { operation: typeof OPERATION } }
  | { tool: "connection_status"; arguments: { connection: string } }
  | {
    tool: "invoke_operation";
    arguments: {
      operation: typeof OPERATION;
      connection: string;
      arguments: Record<string, never>;
    };
  };

export interface R1DispatchAdversarialResults {
  readonly malformed: string;
  readonly extraField: string;
  readonly schemaMismatch: string;
  readonly nonCanonical: string;
  readonly replay: string;
}

interface OwnerAuthorityContext {
  tenantId: R1TenantId;
  userId: R1UserId;
  membershipId: R1MembershipId;
}

interface EnrollmentDraft {
  tenantId: R1TenantId;
  clientPrincipalId: ClientPrincipalId;
  name: string;
}

interface TenantSnapshot {
  tenant: Tenant;
  connection: Omit<ProviderConnection, "custodyReference">;
  clients: Array<Pick<ClientPrincipal, "id" | "name" | "thumbprint" | "status" | "keyEpoch">>;
  grants: Grant[];
  attempts: Attempt[];
  receipts: Receipt[];
}

class R1MemoryAuthority {
  tenants = new Map<R1TenantId, Tenant>();
  users = new Map<R1UserId, User>();
  memberships = new Map<R1MembershipId, Membership>();
  clients = new Map<ClientPrincipalId, ClientPrincipal>();
  connections = new Map<string, ProviderConnection>();
  grants = new Map<string, Grant>();
  enrollmentReferences = new Map<string, EnrollmentReference>();
  enrollmentDrafts = new Map<string, EnrollmentDraft>();
  custodyClaims = new Map<string, string>();
  replay = new Map<string, number>();
  attempts = new Map<string, Attempt>();
  receipts = new Map<string, Receipt>();
  tail: Promise<void> = Promise.resolve();

  async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const prior = this.tail;
    this.tail = prior.then(() => gate);
    await prior;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function connectionKey(tenantId: R1TenantId, id: ProviderConnectionId): string {
  return `${tenantId}/connection/${id}`;
}
function grantKey(tenantId: R1TenantId, id: R1GrantId): string {
  return `${tenantId}/grant/${id}`;
}
function clean(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid opaque identifier");
  return value;
}
function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parseDispatchBody(body: Uint8Array): DispatchSemantic {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    parsed = JSON.parse(text);
  } catch {
    throw new Error("body denied");
  }
  if (!exactObject(parsed, ["tool", "arguments"]) || typeof parsed.tool !== "string") {
    throw new Error("body denied");
  }

  let semantic: DispatchSemantic;
  if (parsed.tool === "search_capabilities") {
    if (!exactObject(parsed.arguments, ["query"]) || typeof parsed.arguments.query !== "string") {
      throw new Error("body denied");
    }
    semantic = { tool: parsed.tool, arguments: { query: parsed.arguments.query } };
  } else if (parsed.tool === "describe_operation") {
    if (
      !exactObject(parsed.arguments, ["operation"]) ||
      parsed.arguments.operation !== OPERATION
    ) throw new Error("body denied");
    semantic = { tool: parsed.tool, arguments: { operation: OPERATION } };
  } else if (parsed.tool === "connection_status") {
    if (
      !exactObject(parsed.arguments, ["connection"]) ||
      typeof parsed.arguments.connection !== "string"
    ) throw new Error("body denied");
    semantic = { tool: parsed.tool, arguments: { connection: parsed.arguments.connection } };
  } else if (parsed.tool === "invoke_operation") {
    if (
      !exactObject(parsed.arguments, ["operation", "connection", "arguments"]) ||
      parsed.arguments.operation !== OPERATION ||
      typeof parsed.arguments.connection !== "string" ||
      !exactObject(parsed.arguments.arguments, [])
    ) throw new Error("body denied");
    semantic = {
      tool: parsed.tool,
      arguments: {
        operation: OPERATION,
        connection: parsed.arguments.connection,
        arguments: {},
      },
    };
  } else {
    throw new Error("body denied");
  }

  if (text !== JSON.stringify(semantic)) throw new Error("body denied");
  return semantic;
}

class R1Store {
  constructor(private readonly backend = new R1MemoryAuthority()) {}

  createOwnerTenant(label: string, suffix: string): OwnerAuthorityContext {
    const tenantId = r1Ids.tenant(`tenant_${clean(suffix)}`);
    const userId = r1Ids.user(`owner_${clean(suffix)}`);
    const membershipId = r1Ids.membership(`membership_${clean(suffix)}`);
    this.backend.tenants.set(tenantId, { id: tenantId, name: label, status: "active" });
    this.backend.users.set(userId, {
      id: userId,
      immutableSubject: `fixture-subject-${suffix}`,
      status: "active",
    });
    this.backend.memberships.set(membershipId, {
      id: membershipId,
      tenantId,
      userId,
      role: "owner",
      status: "active",
    });
    return Object.freeze({ tenantId, userId, membershipId });
  }

  #owner(context: OwnerAuthorityContext): void {
    const membership = this.backend.memberships.get(context.membershipId);
    if (
      !membership || membership.tenantId !== context.tenantId ||
      membership.userId !== context.userId || membership.role !== "owner" ||
      membership.status !== "active" ||
      this.backend.tenants.get(context.tenantId)?.status !== "active" ||
      this.backend.users.get(context.userId)?.status !== "active"
    ) throw new Error("owner authority denied");
  }

  async putConnection(context: OwnerAuthorityContext, value: ProviderConnection): Promise<void> {
    this.#owner(context);
    if (value.tenantId !== context.tenantId || value.provider !== "github") {
      throw new Error("connection ownership denied");
    }
    const custodyHash = await sha256(value.custodyReference);
    await this.backend.exclusive(() => {
      const claim = connectionKey(context.tenantId, value.id);
      const existingClaim = this.backend.custodyClaims.get(custodyHash);
      if (existingClaim && existingClaim !== claim) throw new Error("custody ownership denied");
      const key = connectionKey(context.tenantId, value.id);
      if (this.backend.connections.has(key)) throw new Error("connection exists");
      this.backend.custodyClaims.set(custodyHash, claim);
      this.backend.connections.set(key, structuredClone(value));
    });
  }

  getConnection(tenantId: R1TenantId, id: ProviderConnectionId): ProviderConnection | undefined {
    return structuredClone(this.backend.connections.get(connectionKey(tenantId, id)));
  }

  listConnections(tenantId: R1TenantId): ProviderConnection[] {
    return [...this.backend.connections.values()].filter((item) => item.tenantId === tenantId).map(
      (item) => structuredClone(item),
    );
  }

  updateConnection(
    context: OwnerAuthorityContext,
    value: ProviderConnection,
  ): void {
    this.#owner(context);
    if (value.tenantId !== context.tenantId) throw new Error("connection ownership denied");
    const key = connectionKey(context.tenantId, value.id);
    const previous = this.backend.connections.get(key);
    if (!previous) throw new Error("connection missing");
    if (
      previous.custodyReference !== value.custodyReference ||
      value.authorityEpoch <= previous.authorityEpoch
    ) throw new Error("connection authority denied");
    this.backend.connections.set(key, structuredClone(value));
  }

  issueEnrollment(
    context: OwnerAuthorityContext,
    clientId: ClientPrincipalId,
    name: string,
    reference: string,
    now: number,
  ): Promise<void> {
    this.#owner(context);
    return sha256(reference).then((referenceHash) => {
      if (this.backend.clients.has(clientId)) throw new Error("client exists");
      const item: EnrollmentReference = {
        id: randomId("enrollment"),
        tenantId: context.tenantId,
        clientPrincipalId: clientId,
        referenceHash,
        expiresAt: now + 600,
        status: "issued",
      };
      this.backend.enrollmentReferences.set(referenceHash, item);
      this.backend.enrollmentDrafts.set(referenceHash, {
        tenantId: context.tenantId,
        clientPrincipalId: clientId,
        name,
      });
    });
  }

  async submitEnrollment(
    reference: string,
    publicJwk: JsonWebKey,
    proof: Awaited<ReturnType<typeof signRequestProof>>,
    body: Uint8Array,
    now: number,
  ): Promise<{ tenantId: R1TenantId; clientId: ClientPrincipalId; fingerprint: string }> {
    const referenceHash = await sha256(reference);
    return await this.backend.exclusive(async () => {
      const item = this.backend.enrollmentReferences.get(referenceHash);
      const draft = this.backend.enrollmentDrafts.get(referenceHash);
      if (!item || !draft || item.status !== "issued" || item.expiresAt <= now) {
        throw new Error("enrollment reference denied");
      }
      const valid = await verifyRequestProof(proof, publicJwk, {
        v: 1,
        method: "POST",
        authority: AUTHORITY,
        path: "/enrollment",
        query: "",
        audience: "urn:cairn:gateway",
        body_sha256: await bodyHash(body),
        device_id: draft.clientPrincipalId,
        agent_id: draft.clientPrincipalId,
      }, now);
      if (!valid) throw new Error("enrollment proof denied");
      const thumbprint = await jwkThumbprint(publicJwk);
      this.backend.clients.set(draft.clientPrincipalId, {
        id: draft.clientPrincipalId,
        tenantId: draft.tenantId,
        name: draft.name,
        publicJwk,
        thumbprint,
        status: "pending",
        keyEpoch: 1,
      });
      this.backend.enrollmentReferences.set(referenceHash, { ...item, status: "submitted" });
      return {
        tenantId: draft.tenantId,
        clientId: draft.clientPrincipalId,
        fingerprint: shortFingerprint(thumbprint),
      };
    });
  }

  approveEnrollment(context: OwnerAuthorityContext, clientId: ClientPrincipalId): void {
    this.#owner(context);
    const client = this.backend.clients.get(clientId);
    if (!client || client.tenantId !== context.tenantId || client.status !== "pending") {
      throw new Error("client approval denied");
    }
    this.backend.clients.set(clientId, { ...client, status: "active" });
    for (const [hash, reference] of this.backend.enrollmentReferences) {
      if (reference.clientPrincipalId === clientId && reference.status === "submitted") {
        this.backend.enrollmentReferences.set(hash, { ...reference, status: "approved" });
      }
    }
  }

  putGrant(context: OwnerAuthorityContext, grant: Grant): void {
    this.#owner(context);
    const client = this.backend.clients.get(grant.clientPrincipalId);
    const connection = this.getConnection(context.tenantId, grant.providerConnectionId);
    if (
      grant.tenantId !== context.tenantId || client?.tenantId !== context.tenantId ||
      connection?.tenantId !== context.tenantId || grant.operation !== OPERATION
    ) throw new Error("grant ownership denied");
    this.backend.grants.set(grantKey(context.tenantId, grant.id), structuredClone(grant));
  }

  getGrant(tenantId: R1TenantId, id: R1GrantId): Grant | undefined {
    return structuredClone(this.backend.grants.get(grantKey(tenantId, id)));
  }

  grantForClient(tenantId: R1TenantId, clientId: ClientPrincipalId): Grant | undefined {
    return structuredClone(
      [...this.backend.grants.values()].find((grant) =>
        grant.tenantId === tenantId && grant.clientPrincipalId === clientId &&
        grant.status === "active"
      ),
    );
  }

  listGrants(tenantId: R1TenantId): Grant[] {
    return [...this.backend.grants.values()].filter((grant) => grant.tenantId === tenantId).map(
      (grant) => structuredClone(grant),
    );
  }

  revokeClient(context: OwnerAuthorityContext, clientId: ClientPrincipalId): void {
    this.#owner(context);
    const client = this.backend.clients.get(clientId);
    if (!client || client.tenantId !== context.tenantId) throw new Error("client ownership denied");
    this.backend.clients.set(clientId, {
      ...client,
      status: "revoked",
      keyEpoch: client.keyEpoch + 1,
    });
  }

  resolveClient(clientId: ClientPrincipalId): ClientPrincipal | undefined {
    return structuredClone(this.backend.clients.get(clientId));
  }

  listClients(tenantId: R1TenantId): ClientPrincipal[] {
    return [...this.backend.clients.values()].filter((client) => client.tenantId === tenantId).map(
      (client) => structuredClone(client),
    );
  }

  async consumeReplay(
    tenantId: R1TenantId,
    clientId: ClientPrincipalId,
    nonce: string,
    now: number,
  ): Promise<boolean> {
    const key = `${tenantId}/client/${clientId}/nonce/${await sha256(nonce)}`;
    return await this.backend.exclusive(() => {
      for (const [used, expiry] of this.backend.replay) {
        if (expiry < now) this.backend.replay.delete(used);
      }
      if (this.backend.replay.has(key)) return false;
      this.backend.replay.set(key, now + 600);
      return true;
    });
  }

  recordAttempt(attempt: Attempt): void {
    this.backend.attempts.set(`${attempt.tenantId}/${attempt.id}`, structuredClone(attempt));
  }

  recordReceipt(receipt: Receipt): void {
    this.backend.receipts.set(`${receipt.tenantId}/${receipt.id}`, structuredClone(receipt));
  }

  snapshot(context: OwnerAuthorityContext): TenantSnapshot {
    this.#owner(context);
    const connections = this.listConnections(context.tenantId);
    const connection = connections.find((item) => item.lifecycle === "connected") ??
      connections.at(-1);
    if (!connection) throw new Error("connection missing");
    const { custodyReference: _custodyReference, ...safeConnection } = connection;
    return {
      tenant: structuredClone(this.backend.tenants.get(context.tenantId)!),
      connection: safeConnection,
      clients: this.listClients(context.tenantId).map((client) => ({
        id: client.id,
        name: client.name,
        thumbprint: client.thumbprint,
        status: client.status,
        keyEpoch: client.keyEpoch,
      })),
      grants: this.listGrants(context.tenantId),
      attempts: [...this.backend.attempts.values()].filter((item) =>
        item.tenantId === context.tenantId
      ).map((item) => structuredClone(item)),
      receipts: [...this.backend.receipts.values()].filter((item) =>
        item.tenantId === context.tenantId
      ).map((item) => structuredClone(item)),
    };
  }
}

class R1Gateway {
  constructor(private readonly store: R1Store, private readonly now: () => number) {}

  async dispatch(request: {
    clientPrincipalId: ClientPrincipalId;
    receivedBody: Uint8Array;
    proof: Awaited<ReturnType<typeof signRequestProof>>;
  }): Promise<Record<string, unknown>> {
    const client = this.store.resolveClient(request.clientPrincipalId);
    if (!client) throw new Error("proof denied");
    const at = this.now();
    const valid = await verifyRequestProof(request.proof, client.publicJwk, {
      v: 1,
      method: "POST",
      authority: AUTHORITY,
      path: "/mcp",
      query: "",
      audience: "urn:cairn:gateway",
      body_sha256: await bodyHash(request.receivedBody),
      device_id: client.id,
      agent_id: client.id,
    }, at);
    if (!valid) throw new Error("proof denied");
    if (
      !await this.store.consumeReplay(client.tenantId, client.id, request.proof.payload.nonce, at)
    ) {
      throw new Error("replay denied");
    }
    const semantic = parseDispatchBody(request.receivedBody);
    if (client.status !== "active") throw new Error("client denied");
    const grant = this.store.grantForClient(client.tenantId, client.id);
    if (!grant || grant.expiresAt <= at) throw new Error("grant denied");
    const connection = this.store.getConnection(client.tenantId, grant.providerConnectionId);
    if (!connection || connection.lifecycle !== "connected") throw new Error("connection denied");

    if (semantic.tool === "search_capabilities") {
      const query = semantic.arguments.query;
      const match = query.toLowerCase().includes("github") || query.toLowerCase().includes("user");
      return {
        operations: match ? [{ id: OPERATION, connection: connection.id }] : [],
        count: match ? 1 : 0,
      };
    }
    if (semantic.tool === "describe_operation") {
      return {
        id: OPERATION,
        provider: "github",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        requestUnits: 1,
      };
    }
    if (semantic.tool === "connection_status") {
      if (semantic.arguments.connection !== connection.id) throw new Error("connection denied");
      return {
        connection: connection.id,
        status: connection.lifecycle,
        configured: connection.configured,
        health: connection.health,
        operation: OPERATION,
      };
    }
    if (semantic.arguments.connection !== connection.id) throw new Error("operation denied");
    const attempt: Attempt = {
      id: randomId("attempt"),
      tenantId: client.tenantId,
      clientPrincipalId: client.id,
      grantId: grant.id,
      providerConnectionId: connection.id,
      operation: OPERATION,
      state: "reserved",
      startedAt: at,
    };
    this.store.recordAttempt(attempt);
    this.store.recordAttempt({ ...attempt, state: "completed", completedAt: at });
    const receipt: Receipt = {
      id: randomId("receipt"),
      tenantId: client.tenantId,
      attemptId: attempt.id,
      clientPrincipalId: client.id,
      providerConnectionId: connection.id,
      operation: OPERATION,
      decision: "allow",
      reason: "policy_allow",
      requestUnits: 1,
      at,
    };
    this.store.recordReceipt(receipt);
    return {
      outcome: "success",
      user: structuredClone(FIXTURE_USER),
      receipt: { decision: receipt.decision, reason: receipt.reason, requestUnits: 1 },
    };
  }
}

class R1FixtureClient {
  readonly #signer: DeviceSigner;
  readonly #gateway: R1Gateway;
  readonly #now: () => number;

  constructor(
    readonly id: ClientPrincipalId,
    signer: DeviceSigner,
    gateway: R1Gateway,
    now: () => number,
  ) {
    this.#signer = signer;
    this.#gateway = gateway;
    this.#now = now;
  }

  async call(tool: ToolName, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const receivedBody = encoder.encode(JSON.stringify({ tool, arguments: args }));
    const proof = await signRequestProof(this.#signer, {
      v: 1,
      method: "POST",
      authority: AUTHORITY,
      path: "/mcp",
      query: "",
      audience: "urn:cairn:gateway",
      body_sha256: await bodyHash(receivedBody),
      issued_at: this.#now(),
      nonce: randomId("client_request"),
      device_id: this.id,
      agent_id: this.id,
    });
    return await this.#gateway.dispatch({
      clientPrincipalId: this.id,
      receivedBody,
      proof,
    });
  }
}

export interface R1TenantFixture {
  readonly tenantId: R1TenantId;
  readonly clientA: R1FixtureClient;
  readonly clientB: R1FixtureClient;
  connectionId(): ProviderConnectionId;
  revokeClient(client: "A" | "B"): void;
  disconnect(): Promise<void>;
  reconnect(): Promise<ProviderConnectionId>;
  snapshot(): TenantSnapshot;
}

export interface R1FoundationFixture {
  tenantA: R1TenantFixture;
  tenantB: R1TenantFixture;
  dispatchAdversarialResults: R1DispatchAdversarialResults;
  assertCustodyReferenceUniqueAcrossTenants(): Promise<void>;
}

interface EnrolledFixtureClient {
  client: R1FixtureClient;
  runDispatchAdversarialProbe(): Promise<R1DispatchAdversarialResults>;
}

async function denial(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : "unknown denial";
  }
}

async function enrollClient(
  store: R1Store,
  gateway: R1Gateway,
  context: OwnerAuthorityContext,
  suffix: string,
  label: string,
  connectionId: ProviderConnectionId,
  now: () => number,
): Promise<EnrolledFixtureClient> {
  const clientId = r1Ids.client(`client_${clean(suffix)}`);
  const reference = randomId("one_use_enrollment");
  await store.issueEnrollment(context, clientId, label, reference, now());
  const signer = await generateP256Signer(clientId);
  const publicJwk = await signer.publicJwk();
  const receivedBody = encoder.encode(JSON.stringify({ reference, client: clientId }));
  const proof = await signRequestProof(signer, {
    v: 1,
    method: "POST",
    authority: AUTHORITY,
    path: "/enrollment",
    query: "",
    audience: "urn:cairn:gateway",
    body_sha256: await bodyHash(receivedBody),
    issued_at: now(),
    nonce: randomId("enrollment_proof"),
    device_id: clientId,
    agent_id: clientId,
  });
  await store.submitEnrollment(reference, publicJwk, proof, receivedBody, now());
  // The reference is one-use even with a fresh valid proof.
  try {
    await store.submitEnrollment(reference, publicJwk, proof, receivedBody, now());
    throw new Error("enrollment replay unexpectedly accepted");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("reference denied")) throw error;
  }
  store.approveEnrollment(context, clientId);
  store.putGrant(context, {
    id: r1Ids.grant(`grant_${clean(suffix)}`),
    tenantId: context.tenantId,
    clientPrincipalId: clientId,
    providerConnectionId: connectionId,
    operation: OPERATION,
    status: "active",
    version: 1,
    expiresAt: now() + 86_400,
    maxRequestUnits: 1,
  });
  const client = new R1FixtureClient(clientId, signer, gateway, now);
  Object.freeze(client);
  const signedRequest = async (body: Uint8Array) => ({
    clientPrincipalId: clientId,
    receivedBody: body,
    proof: await signRequestProof(signer, {
      v: 1,
      method: "POST" as const,
      authority: AUTHORITY,
      path: "/mcp" as const,
      query: "" as const,
      audience: "urn:cairn:gateway" as const,
      body_sha256: await bodyHash(body),
      issued_at: now(),
      nonce: randomId("adversarial_request"),
      device_id: clientId,
      agent_id: clientId,
    }),
  });
  return {
    client,
    runDispatchAdversarialProbe: async () => {
      const malformed = await signedRequest(encoder.encode("{"));
      const extraField = await signedRequest(encoder.encode(JSON.stringify({
        tool: "search_capabilities",
        arguments: { query: "github" },
        extra: true,
      })));
      const schemaMismatch = await signedRequest(encoder.encode(JSON.stringify({
        tool: "invoke_operation",
        arguments: { query: "github" },
      })));
      const nonCanonical = await signedRequest(encoder.encode(JSON.stringify({
        arguments: { query: "github" },
        tool: "search_capabilities",
      })));
      const replay = await signedRequest(encoder.encode(JSON.stringify({
        tool: "search_capabilities",
        arguments: { query: "github" },
      })));
      await gateway.dispatch(replay);
      return Object.freeze({
        malformed: await denial(() => gateway.dispatch(malformed)),
        extraField: await denial(() => gateway.dispatch(extraField)),
        schemaMismatch: await denial(() => gateway.dispatch(schemaMismatch)),
        nonCanonical: await denial(() => gateway.dispatch(nonCanonical)),
        replay: await denial(() => gateway.dispatch(replay)),
      });
    },
  };
}

async function createTenantFixture(
  store: R1Store,
  gateway: R1Gateway,
  suffix: string,
  now: () => number,
): Promise<{
  fixture: R1TenantFixture;
  context: OwnerAuthorityContext;
  custodyReference: string;
  runDispatchAdversarialProbe(): Promise<R1DispatchAdversarialResults>;
}> {
  const context = store.createOwnerTenant(`Tenant ${suffix.toUpperCase()}`, suffix);
  let connectionId = r1Ids.connection(`github_${clean(suffix)}_1`);
  const custodyReference = `opaque_custody_${suffix}_1`;
  await store.putConnection(context, {
    id: connectionId,
    tenantId: context.tenantId,
    provider: "github",
    custodyReference,
    lifecycle: "connected",
    configured: true,
    health: "unknown",
    authorityEpoch: 1,
  });
  const enrolledA = await enrollClient(
    store,
    gateway,
    context,
    `${suffix}_a`,
    "Client A",
    connectionId,
    now,
  );
  const enrolledB = await enrollClient(
    store,
    gateway,
    context,
    `${suffix}_b`,
    "Client B",
    connectionId,
    now,
  );
  const clientA = enrolledA.client;
  const clientB = enrolledB.client;
  let reconnectCount = 1;
  const fixture: R1TenantFixture = {
    tenantId: context.tenantId,
    clientA,
    clientB,
    connectionId: () => connectionId,
    revokeClient: (client) => store.revokeClient(context, client === "A" ? clientA.id : clientB.id),
    disconnect: async () => {
      const connection = store.getConnection(context.tenantId, connectionId)!;
      await store.updateConnection(context, {
        ...connection,
        lifecycle: "disconnected",
        health: "unknown",
        authorityEpoch: connection.authorityEpoch + 1,
      });
    },
    reconnect: async () => {
      reconnectCount++;
      const oldConnection = store.getConnection(context.tenantId, connectionId)!;
      if (oldConnection.lifecycle !== "disconnected") throw new Error("disconnect required");
      connectionId = r1Ids.connection(`github_${clean(suffix)}_${reconnectCount}`);
      await store.putConnection(context, {
        id: connectionId,
        tenantId: context.tenantId,
        provider: "github",
        custodyReference: `opaque_custody_${suffix}_${reconnectCount}`,
        lifecycle: "connected",
        configured: true,
        health: "unknown",
        authorityEpoch: 1,
      });
      for (const client of [clientA, clientB]) {
        const grant = store.grantForClient(context.tenantId, client.id);
        if (!grant) continue;
        store.putGrant(context, {
          ...grant,
          providerConnectionId: connectionId,
          version: grant.version + 1,
        });
      }
      return connectionId;
    },
    snapshot: () => store.snapshot(context),
  };
  return {
    fixture: Object.freeze(fixture),
    context,
    custodyReference,
    runDispatchAdversarialProbe: enrolledA.runDispatchAdversarialProbe,
  };
}

/**
 * Credential-free R1 executable slice. Tenant context is closed over by owner controls or derived
 * only after a named client's P-256 proof verifies. No API accepts tenant input.
 */
export async function createR1FoundationFixture(): Promise<R1FoundationFixture> {
  const store = new R1Store();
  const now = () => 2_000_000_000;
  const gateway = new R1Gateway(store, now);
  const a = await createTenantFixture(store, gateway, "a", now);
  const b = await createTenantFixture(store, gateway, "b", now);
  const dispatchAdversarialResults = await a.runDispatchAdversarialProbe();
  return Object.freeze({
    tenantA: a.fixture,
    tenantB: b.fixture,
    dispatchAdversarialResults,
    assertCustodyReferenceUniqueAcrossTenants: async () => {
      await store.putConnection(b.context, {
        id: r1Ids.connection("github_a_1"),
        tenantId: b.context.tenantId,
        provider: "github",
        custodyReference: a.custodyReference,
        lifecycle: "connected",
        configured: true,
        health: "unknown" as ConnectionHealth,
        authorityEpoch: 1,
      });
    },
  });
}
