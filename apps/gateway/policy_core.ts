import type { MetadataStore } from "../../packages/core/src/store/store.ts";
import type { DualProof, InvocationService } from "../../packages/core/src/policy/invocation.ts";
import { GITHUB_USER_READ } from "../../packages/core/src/connectors/github_user.ts";
import type { McpCore, Structured } from "./mcp.ts";
import type { VerifiedMcpAuth } from "./mcp_auth.ts";

interface PolicySession {
  capability: string;
  proofs: DualProof;
  now: number;
  correlationId: string;
}

export class PolicyMcpCore implements McpCore {
  #store: MetadataStore;
  #service: InvocationService;
  #auth: VerifiedMcpAuth;
  #session: PolicySession;
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
  accepts(auth: VerifiedMcpAuth): boolean {
    return auth === this.#auth && auth.sessionId === this.#auth.sessionId &&
      auth.grantId === this.#auth.grantId &&
      auth.context.tenantId === this.#auth.context.tenantId &&
      auth.context.userId === this.#auth.context.userId;
  }
  async search(query: string): Promise<Structured> {
    const grant = await this.#activeGrant();
    return {
      operations: query.toLowerCase().includes("github") || query.toLowerCase().includes("user")
        ? [{ id: GITHUB_USER_READ.id, connection: grant.connectionId }]
        : [],
      count: query.toLowerCase().includes("github") || query.toLowerCase().includes("user") ? 1 : 0,
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
    const output = await this.#service.invoke(
      this.#auth.context,
      this.#session.capability,
      this.#session.proofs,
      args,
      receivedBody,
      this.#session.now,
      this.#session.correlationId,
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
    const value = await this.#store.getConnection(this.#auth.context, connection);
    if (!value || value.status !== "active") throw new Error("connection denied");
    return { connection, status: "active", operation: GITHUB_USER_READ.id };
  }
  async #activeGrant() {
    const grant = await this.#store.getGrant(this.#auth.context, this.#auth.grantId),
      principal = await this.#store.getPrincipal(this.#auth.context, this.#auth.context.userId);
    if (!grant || grant.status !== "active" || !principal || principal.status !== "active") {
      throw new Error("policy denied");
    }
    const agent = await this.#store.getAgent(this.#auth.context, grant.agentId),
      device = await this.#store.getDevice(this.#auth.context, grant.deviceId),
      connection = await this.#store.getConnection(this.#auth.context, grant.connectionId);
    if (
      grant.expiresAt < this.#session.now || !agent || agent.status !== "active" ||
      !device || device.status !== "active" ||
      device.agentId !== agent.id || !connection || connection.status !== "active"
    ) throw new Error("policy denied");
    return grant;
  }
}
