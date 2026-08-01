import type { MetadataStore } from "../../packages/core/src/store/store.ts";
import type { DualProof, InvocationService } from "../../packages/core/src/policy/invocation.ts";
import { GITHUB_USER_READ } from "../../packages/core/src/connectors/github_user.ts";
import type { Structured } from "./mcp.ts";
import type { VerifiedMcpAuth } from "./mcp_auth.ts";

interface PolicySession {
  capability: string;
  proofs: DualProof;
  correlationId: string;
  path: "/mcp" | "/mcp/legacy";
  clock: () => number;
}
const trusted = new WeakMap<object, VerifiedMcpAuth>();

export function isTrustedPolicyMcpCore(
  value: unknown,
  auth: VerifiedMcpAuth,
): value is PolicyMcpCore {
  return !!value && typeof value === "object" && trusted.get(value as object) === auth;
}

/** Application composition factory. The runtime brand cannot be self-asserted by an injected core. */
export function createPolicyMcpCore(
  store: MetadataStore,
  service: InvocationService,
  auth: VerifiedMcpAuth,
  session: PolicySession,
): PolicyMcpCore {
  const core = new PolicyMcpCore(store, service, auth, session);
  trusted.set(core, auth);
  return core;
}

export class PolicyMcpCore {
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
  async search(query: string): Promise<Structured> {
    const grant = await this.#activeGrant();
    const match = query.toLowerCase().includes("github") || query.toLowerCase().includes("user");
    return {
      operations: match ? [{ id: GITHUB_USER_READ.id, connection: grant.connectionId }] : [],
      count: match ? 1 : 0,
    };
  }
  async describe(operation: string): Promise<Structured> {
    await this.#activeGrant();
    if (operation !== GITHUB_USER_READ.id) throw new Error("operation denied");
    return {
      id: GITHUB_USER_READ.id,
      provider: "github",
      inputSchema: GITHUB_USER_READ.argumentsSchema,
      requestUnits: 1,
    } as Structured;
  }
  async invoke(
    operation: string,
    connection: string,
    args: unknown,
    receivedBody: Uint8Array,
  ): Promise<Structured> {
    const grant = await this.#activeGrant();
    if (operation !== GITHUB_USER_READ.id || connection !== grant.connectionId) {
      throw new Error("operation denied");
    }
    const operationNow = this.#now();
    const output = await this.#service.invoke(
      this.#auth.context,
      this.#session.capability,
      this.#session.proofs,
      args,
      receivedBody,
      operationNow,
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
  async status(connection: string): Promise<Structured> {
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
    if (
      !grant || grant.status !== "active" || grant.expiresAt <= operationNow ||
      grant.expiresAt !== this.#auth.expiresAt || grant.version !== this.#auth.grantVersion ||
      grant.agentId !== this.#auth.agentId || grant.deviceId !== this.#auth.deviceId ||
      grant.connectionId !== this.#auth.connectionId || !principal ||
      principal.status !== "active" ||
      principal.epoch !== this.#auth.principalEpoch || !agent || agent.status !== "active" ||
      agent.epoch !== this.#auth.agentEpoch || !device || device.status !== "active" ||
      device.epoch !== this.#auth.deviceEpoch || device.agentId !== agent.id || !connection ||
      connection.status !== "active" || connection.epoch !== this.#auth.connectionEpoch
    ) throw new Error("policy denied");
    return grant;
  }
}
