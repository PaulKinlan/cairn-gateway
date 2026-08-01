import type { TenantContext } from "../../core/src/domain/types.ts";
import type { MetadataStore } from "../../core/src/store/store.ts";
import type { DeviceSigner } from "../../core/src/crypto/device_signer.ts";
import {
  bodyHash,
  type RequestProofPayload,
  signRequestProof,
} from "../../core/src/crypto/request_proof.ts";
import { encoder, sha256 } from "../../core/src/crypto/encoding.ts";
import type { DualProof, InvocationService } from "../../core/src/policy/invocation.ts";
import { GITHUB_USER_READ } from "../../core/src/connectors/github_user.ts";
import { jwkThumbprint } from "../../core/src/crypto/thumbprint.ts";
import { type VerifiedMcpAuth, verifyMcpAuth } from "../../../apps/gateway/mcp_auth.ts";

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
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("policy denied");
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

/** Fixture-only executable bridge; private keys and capabilities never cross its boundary. */
export class FixtureLocalMcpBridge {
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
    authority = "fixture.cairn.invalid",
    clock: () => number = () => Math.floor(Date.now() / 1000),
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
    now: number,
    path: "/mcp" | "/mcp/legacy" = "/mcp",
  ): Promise<{ auth: VerifiedMcpAuth; core: object }> {
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
