import { ids, type TenantContext } from "../../core/src/domain/types.ts";
import type { MetadataStore } from "../../core/src/store/store.ts";
import type { DeviceSigner } from "../../core/src/crypto/device_signer.ts";
import { MemoryStore } from "../../core/src/store/memory_store.ts";
import {
  fixtureAgentSigner,
  fixtureCapabilityKeyring,
  fixtureDeviceSigner,
} from "../../core/src/crypto/fixture_keys.ts";
import { MemoryCustodyFixture } from "../../core/src/custody/memory_fixture.ts";
import { MemorySafeLogger } from "../../core/src/logging/safe_logger.ts";
import {
  bodyHash,
  type RequestProofPayload,
  signRequestProof,
} from "../../core/src/crypto/request_proof.ts";
import { encoder, sha256 } from "../../core/src/crypto/encoding.ts";
import { type DualProof, InvocationService } from "../../core/src/policy/invocation.ts";
import { GITHUB_USER_READ } from "../../core/src/connectors/github_user.ts";
import { jwkThumbprint } from "../../core/src/crypto/thumbprint.ts";
import { type VerifiedMcpAuth, verifyMcpAuth } from "../../../apps/gateway/mcp_auth.ts";
import type { LegacyMcpSession } from "../../../apps/gateway/mcp.ts";

const capturedDateNow = Date.now.bind(Date);
const capturedMathFloor = Math.floor.bind(Math);
const capturedNumberIsSafeInteger = Number.isSafeInteger.bind(Number);
const systemClock = () => capturedMathFloor(capturedDateNow() / 1000);

interface PolicySession {
  capability: string;
  proofs: DualProof;
  correlationId: string;
  path: "/mcp" | "/mcp/legacy";
  clock: () => number;
}
interface StructuredCore {
  search(query: string): Promise<Record<string, unknown>>;
  describe(operation: string): Promise<Record<string, unknown>>;
  invoke(
    operation: string,
    connection: string,
    args: unknown,
    receivedBody: Uint8Array,
  ): Promise<Record<string, unknown>>;
  status(connection: string): Promise<Record<string, unknown>>;
}

// The only brand mint and PolicyMcpCore constructor are private to this executable
// bridge module. Callers can inspect the predicate but cannot bind an auth object
// to caller-selected stores, clocks, or invocation services.
const trusted = new WeakMap<object, VerifiedMcpAuth>();
export function isTrustedPolicyMcpCore(
  value: unknown,
  auth: VerifiedMcpAuth,
): value is StructuredCore {
  return !!value && typeof value === "object" && trusted.get(value as object) === auth;
}

class PolicyMcpCore implements StructuredCore {
  #store: MetadataStore;
  #service: InvocationService;
  #auth: VerifiedMcpAuth;
  #session: Readonly<PolicySession>;
  constructor(
    store: MetadataStore,
    service: InvocationService,
    auth: VerifiedMcpAuth,
    session: PolicySession,
  ) {
    this.#store = store;
    this.#service = service;
    this.#auth = auth;
    this.#session = Object.freeze({ ...session });
  }
  async search(query: string): Promise<Record<string, unknown>> {
    const grant = await this.#activeGrant();
    const match = query.toLowerCase().includes("github") || query.toLowerCase().includes("user");
    return {
      operations: match ? [{ id: GITHUB_USER_READ.id, connection: grant.connectionId }] : [],
      count: match ? 1 : 0,
    };
  }
  async describe(operation: string): Promise<Record<string, unknown>> {
    await this.#activeGrant();
    if (operation !== GITHUB_USER_READ.id) throw new Error("operation denied");
    return {
      id: GITHUB_USER_READ.id,
      provider: "github",
      inputSchema: GITHUB_USER_READ.argumentsSchema,
      requestUnits: 1,
    };
  }
  async invoke(
    operation: string,
    connection: string,
    args: unknown,
    receivedBody: Uint8Array,
  ): Promise<Record<string, unknown>> {
    const grant = await this.#activeGrant();
    if (operation !== GITHUB_USER_READ.id || connection !== grant.connectionId) {
      throw new Error("operation denied");
    }
    const output = await this.#service.invoke(
      this.#auth.context,
      this.#session.capability,
      this.#session.proofs,
      args,
      receivedBody,
      this.#now(),
      this.#session.correlationId,
      this.#session.path,
    );
    return {
      outcome: output.result.outcome,
      ...(output.result.outcome === "success" ? { user: output.result.user } : {}),
      receipt: {
        decision: output.receipt.decision,
        reason: output.receipt.reason,
        requestUnits: output.receipt.requestUnits,
      },
    };
  }
  async status(connection: string): Promise<Record<string, unknown>> {
    const grant = await this.#activeGrant();
    if (connection !== grant.connectionId) throw new Error("connection denied");
    return { connection, status: "active", operation: GITHUB_USER_READ.id };
  }
  #now(): number {
    const value = this.#session.clock();
    if (!capturedNumberIsSafeInteger(value) || value < 0) throw new Error("policy denied");
    return value;
  }
  async #activeGrant() {
    const operationNow = this.#now();
    const grant = await this.#store.getGrant(this.#auth.context, this.#auth.grantId),
      principal = await this.#store.getPrincipal(this.#auth.context, this.#auth.context.userId),
      agent = await this.#store.getAgent(this.#auth.context, this.#auth.agentId),
      device = await this.#store.getDevice(this.#auth.context, this.#auth.deviceId),
      connection = await this.#store.getConnection(this.#auth.context, this.#auth.connectionId);
    const agentThumbprint = agent ? await jwkThumbprint(agent.publicJwk) : undefined;
    const deviceThumbprint = device ? await jwkThumbprint(device.publicJwk) : undefined;
    if (
      !grant || grant.status !== "active" || grant.expiresAt <= operationNow ||
      grant.expiresAt !== this.#auth.expiresAt || grant.version !== this.#auth.grantVersion ||
      grant.agentId !== this.#auth.agentId || grant.deviceId !== this.#auth.deviceId ||
      grant.connectionId !== this.#auth.connectionId || !principal ||
      principal.status !== "active" || principal.epoch !== this.#auth.principalEpoch || !agent ||
      agent.status !== "active" || agent.epoch !== this.#auth.agentEpoch || !device ||
      device.status !== "active" || device.epoch !== this.#auth.deviceEpoch ||
      agentThumbprint !== agent.thumbprint || deviceThumbprint !== device.thumbprint ||
      agentThumbprint === deviceThumbprint || device.agentId !== agent.id || !connection ||
      connection.status !== "active" ||
      connection.epoch !== this.#auth.connectionEpoch
    ) throw new Error("policy denied");
    return grant;
  }
}

function createPolicyMcpCore(
  store: MetadataStore,
  service: InvocationService,
  auth: VerifiedMcpAuth,
  session: PolicySession,
): PolicyMcpCore {
  const core = new PolicyMcpCore(store, service, auth, session);
  trusted.set(core, auth);
  return core;
}

/** Internal bridge; only the zero-argument composition root below can construct it. */
class BoundFixtureBridge {
  #store: MetadataStore;
  #service: InvocationService;
  #context: TenantContext;
  #grantId: string;
  #deviceSigner: DeviceSigner;
  #agentSigner: DeviceSigner;
  #authority: string;
  #clock: () => number;
  constructor(
    store: MetadataStore,
    service: InvocationService,
    context: TenantContext,
    grantId: string,
    deviceSigner: DeviceSigner,
    agentSigner: DeviceSigner,
    authority: string,
    clock: () => number,
  ) {
    this.#store = store;
    this.#service = service;
    this.#context = Object.freeze({ ...context });
    this.#grantId = grantId;
    this.#deviceSigner = deviceSigner;
    this.#agentSigner = agentSigner;
    this.#authority = authority;
    this.#clock = clock;
  }
  async authorize(
    receivedBody: Uint8Array,
    path: "/mcp" | "/mcp/legacy" = "/mcp",
  ): Promise<{ auth: VerifiedMcpAuth; core: object }> {
    const now = this.#clock();
    const grant = await this.#store.getGrant(this.#context, this.#grantId);
    if (!grant) throw new Error("bridge denied");
    const issueBody = encoder.encode(JSON.stringify({ grant_id: this.#grantId }));
    const issuePayload: RequestProofPayload = {
      v: 1,
      method: "POST",
      authority: this.#authority,
      path: "/internal/capabilities",
      query: "",
      audience: "urn:cairn:gateway",
      body_sha256: await bodyHash(issueBody),
      issued_at: now,
      nonce: `bridge_issue_${crypto.randomUUID().replaceAll("-", "")}`,
      device_id: grant.deviceId,
      agent_id: grant.agentId,
      grant_id: grant.id,
    };
    const issueProofs = await this.#dual(issuePayload);
    const capability = await this.#service.issue(
      this.#context,
      this.#grantId,
      issueProofs,
      issueBody,
      now,
    );
    const requestPayload: RequestProofPayload = {
      ...issuePayload,
      path,
      body_sha256: await bodyHash(receivedBody),
      nonce: `bridge_request_${crypto.randomUUID().replaceAll("-", "")}`,
      capability_sha256: await sha256(capability),
    };
    const proofs = await this.#dual(requestPayload);
    const auth = await verifyMcpAuth(this.#store, {
      context: this.#context,
      grantId: this.#grantId,
      proofs,
      receivedBody,
      now,
      authority: this.#authority,
      path,
      capability,
    });
    return {
      auth,
      core: createPolicyMcpCore(this.#store, this.#service, auth, {
        capability,
        proofs,
        correlationId: `bridge_${crypto.randomUUID().replaceAll("-", "")}`,
        path,
        clock: this.#clock,
      }),
    };
  }
  async #dual(payload: RequestProofPayload) {
    return {
      device: await signRequestProof(this.#deviceSigner, {
        ...payload,
        nonce: `${payload.nonce}_device`,
      }),
      agent: await signRequestProof(this.#agentSigner, {
        ...payload,
        nonce: `${payload.nonce}_agent00`,
      }),
    };
  }
}

export type FixtureSubject = "principal" | "agent" | "device" | "grant" | "connection";
export interface FixtureGatewayHarness {
  dispatch(
    receivedBody: Uint8Array,
    path?: "/mcp" | "/mcp/legacy",
  ): Promise<Record<string, unknown> | undefined>;
  revoke(subject: FixtureSubject): Promise<void>;
  revokeAndReactivate(subject: FixtureSubject): Promise<void>;
  setGrantLifetime(seconds: number): Promise<void>;
  status(subject: FixtureSubject): Promise<string>;
}

function closedFixtureFacade(
  store: MemoryStore,
  bridge: BoundFixtureBridge,
  context: TenantContext,
  clock: () => number,
): FixtureGatewayHarness {
  let legacySession: LegacyMcpSession | undefined;
  const dispatch = async (
    receivedBody: Uint8Array,
    path: unknown = "/mcp",
  ) => {
    if (path !== "/mcp" && path !== "/mcp/legacy") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "route denied" },
      };
    }
    const mcp = await import("../../../apps/gateway/mcp.ts");
    const { auth, core } = await bridge.authorize(receivedBody, path);
    const session = path === "/mcp/legacy"
      ? (legacySession ??= new mcp.LegacyMcpSession())
      : undefined;
    return await mcp.handleFixtureMcp(
      receivedBody,
      path === "/mcp" ? mcp.MCP_CURRENT : mcp.MCP_LEGACY,
      path,
      auth,
      core,
      session,
    );
  };
  const transition = async (subject: FixtureSubject, active: boolean): Promise<void> => {
    const at = clock();
    switch (subject) {
      case "principal": {
        const value = (await store.getPrincipal(context, context.userId))!;
        await store.updatePrincipal(
          context,
          { ...value, status: active ? "active" : "revoked", epoch: value.epoch + 1 },
          "operator",
          at,
        );
        break;
      }
      case "agent": {
        const value = (await store.getAgent(context, "agent_a"))!;
        await store.updateAgent(
          context,
          { ...value, status: active ? "active" : "revoked", epoch: value.epoch + 1 },
          "operator",
          at,
        );
        break;
      }
      case "device": {
        const value = (await store.getDevice(context, "device_a"))!;
        await store.updateDevice(
          context,
          { ...value, status: active ? "active" : "revoked", epoch: value.epoch + 1 },
          "operator",
          at,
        );
        break;
      }
      case "grant": {
        const value = (await store.getGrant(context, "grant_a"))!;
        await store.updateGrant(
          context,
          { ...value, status: active ? "active" : "revoked", version: value.version + 1 },
          "operator",
          at,
        );
        break;
      }
      case "connection": {
        const value = (await store.getConnection(context, "connection_a"))!;
        await store.updateConnection(
          context,
          { ...value, status: active ? "active" : "revoked", epoch: value.epoch + 1 },
          "operator",
          at,
        );
      }
    }
  };
  const revoke = async (subject: FixtureSubject) => await transition(subject, false);
  const revokeAndReactivate = async (subject: FixtureSubject) => {
    await transition(subject, false);
    await transition(subject, true);
  };
  const setGrantLifetime = async (seconds: number) => {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) {
      throw new Error("fixture lifetime denied");
    }
    const grant = (await store.getGrant(context, "grant_a"))!;
    await store.updateGrant(context, {
      ...grant,
      status: "active",
      version: grant.version + 1,
      expiresAt: clock() + seconds,
    });
  };
  const status = async (subject: FixtureSubject): Promise<string> => {
    switch (subject) {
      case "principal":
        return (await store.getPrincipal(context, context.userId))?.status ?? "missing";
      case "agent":
        return (await store.getAgent(context, "agent_a"))?.status ?? "missing";
      case "device":
        return (await store.getDevice(context, "device_a"))?.status ?? "missing";
      case "grant":
        return (await store.getGrant(context, "grant_a"))?.status ?? "missing";
      case "connection":
        return (await store.getConnection(context, "connection_a"))?.status ?? "missing";
    }
  };
  const capabilities = { dispatch, revoke, revokeAndReactivate, setGrantLifetime, status };
  for (const capability of Object.values(capabilities)) {
    Object.setPrototypeOf(capability, null);
    Object.freeze(capability);
  }
  return Object.freeze(Object.assign(Object.create(null), capabilities));
}

/**
 * Zero-argument Stage 0 composition root. It owns one immutable authority graph;
 * callers cannot provide or replace stores, services, signers, clocks, or trust mints.
 */
export async function createFixtureGatewayHarness(): Promise<FixtureGatewayHarness> {
  const context: TenantContext = {
    tenantId: ids.tenant("tenant_a"),
    userId: ids.user("user_a"),
  };
  const store = new MemoryStore();
  const deviceSigner = await fixtureDeviceSigner(0);
  const agentSigner = await fixtureAgentSigner();
  const deviceJwk = await deviceSigner.publicJwk();
  const agentJwk = await agentSigner.publicJwk();
  await store.putPrincipal(context, {
    id: context.userId,
    tenantId: context.tenantId,
    kind: "cryptographic",
    status: "active",
    emailRequired: false,
    epoch: 1,
  });
  await store.putAgent(context, {
    id: ids.agent("agent_a"),
    tenantId: context.tenantId,
    userId: context.userId,
    publicJwk: agentJwk,
    thumbprint: await jwkThumbprint(agentJwk),
    status: "active",
    epoch: 1,
  });
  await store.putDevice(context, {
    id: ids.device("device_a"),
    tenantId: context.tenantId,
    userId: context.userId,
    agentId: ids.agent("agent_a"),
    publicJwk: deviceJwk,
    thumbprint: await jwkThumbprint(deviceJwk),
    role: "admin",
    status: "active",
    epoch: 1,
  });
  await store.putConnection(context, {
    id: ids.connection("connection_a"),
    tenantId: context.tenantId,
    userId: context.userId,
    provider: "github",
    adapter: "fixture",
    custodyRef: "ref_a",
    status: "active",
    epoch: 1,
  });
  const clock = systemClock;
  await store.putGrant(context, {
    id: "grant_a",
    tenantId: context.tenantId,
    userId: context.userId,
    agentId: ids.agent("agent_a"),
    deviceId: ids.device("device_a"),
    connectionId: ids.connection("connection_a"),
    operation: "github.user.read",
    status: "active",
    version: 1,
    expiresAt: clock() + 600,
  });
  const custody = new MemoryCustodyFixture(encoder.encode(JSON.stringify({
    id: 1,
    login: "fixture",
    name: null,
    html_url: "https:" + "//github.com/fixture",
    avatar_url: "https:" + "//avatars.githubusercontent.com/u/1",
  })));
  const binding = {
    context,
    connectionId: "connection_a",
    connectionRef: "ref_a",
    integration: "github-cairn-v1" as const,
    redirectUri: "https://fixture.cairn.invalid/oauth/github/callback" as const,
  };
  const startedAt = clock();
  await custody.beginAuthorization({ flowId: "flow_a", binding, now: startedAt });
  await custody.completeAuthorization({
    flowId: "flow_a",
    binding,
    ...custody.fixtureCallbackMaterial(binding, "flow_a"),
    code: "fixture_authorization_code",
    now: startedAt,
  });
  const service = new InvocationService(
    store,
    await fixtureCapabilityKeyring(),
    custody,
    new MemorySafeLogger(),
  );
  const bridge = new BoundFixtureBridge(
    store,
    service,
    context,
    "grant_a",
    deviceSigner,
    agentSigner,
    "fixture.cairn.invalid",
    clock,
  );
  return closedFixtureFacade(store, bridge, context, clock);
}
