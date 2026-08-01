import type { TenantContext } from "../../packages/core/src/domain/types.ts";
import type { MetadataStore } from "../../packages/core/src/store/store.ts";
import type { DualProof, InvocationService } from "../../packages/core/src/policy/invocation.ts";
import { GITHUB_USER_READ } from "../../packages/core/src/connectors/github_user.ts";
import type { McpCore, Structured } from "./mcp.ts";
export class PolicyMcpCore implements McpCore {
  constructor(
    private readonly store: MetadataStore,
    private readonly service: InvocationService,
    private readonly session: {
      context: TenantContext;
      grantId: string;
      capability: string;
      proofs: DualProof;
      now: number;
      correlationId: string;
    },
  ) {}
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
    const output = await this.service.invoke(
      this.session.context,
      this.session.capability,
      this.session.proofs,
      args,
      receivedBody,
      this.session.now,
      this.session.correlationId,
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
    const value = await this.store.getConnection(this.session.context, connection);
    if (!value || value.status !== "active") throw new Error("connection denied");
    return { connection, status: "active", operation: GITHUB_USER_READ.id };
  }
  async #activeGrant() {
    const grant = await this.store.getGrant(this.session.context, this.session.grantId),
      principal = await this.store.getPrincipal(this.session.context, this.session.context.userId);
    if (!grant || grant.status !== "active" || !principal || principal.status !== "active") {
      throw new Error("policy denied");
    }
    const agent = await this.store.getAgent(this.session.context, grant.agentId),
      device = await this.store.getDevice(this.session.context, grant.deviceId),
      connection = await this.store.getConnection(this.session.context, grant.connectionId);
    if (
      !agent || agent.status !== "active" || !device || device.status !== "active" ||
      device.agentId !== agent.id || !connection || connection.status !== "active"
    ) throw new Error("policy denied");
    return grant;
  }
}
