import type {
  AuthorizationCompletion,
  AuthorizationStart,
  ConnectionHealth,
  CustodyAdapter,
  CustodyResponse,
  FixedOperationInput,
} from "./custody_adapter.ts";
import { base64url, encoder, sha256 } from "../crypto/encoding.ts";

interface FixtureFlow {
  stateHash: string;
  challenge: string;
  expiresAt: number;
  used: boolean;
  connectionRef: string;
}
const EXPECTED_STATE = "fixture_state_012345678901234567890123";
const EXPECTED_VERIFIER = "fixture-verifier-012345678901234567890123456789012345678901234567";
export class MemoryCustodyFixture implements CustodyAdapter {
  #flows = new Map<string, FixtureFlow>();
  #connections = new Map<string, ConnectionHealth>();
  constructor(private readonly githubBody: Uint8Array) {}
  async beginAuthorization(
    input: { flowId: string; connectionRef: string; now: number },
  ): Promise<AuthorizationStart> {
    if (this.#flows.has(input.flowId)) throw new Error("flow exists");
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(EXPECTED_VERIFIER))),
    );
    this.#flows.set(input.flowId, {
      stateHash: await sha256(EXPECTED_STATE),
      challenge,
      expiresAt: input.now + 600,
      used: false,
      connectionRef: input.connectionRef,
    });
    this.#connections.set(input.connectionRef, { status: "pending" });
    return { handle: input.flowId, callbackOwnership: "gateway", expiresAt: input.now + 600 };
  }
  async completeAuthorization(
    input: { flowId: string; state: string; code: string; verifier: string; now: number },
  ): Promise<AuthorizationCompletion> {
    const flow = this.#flows.get(input.flowId);
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input.verifier))),
    );
    if (
      !flow || flow.used || flow.expiresAt < input.now ||
      await sha256(input.state) !== flow.stateHash ||
      challenge !== flow.challenge || input.code !== "fixture_authorization_code"
    ) throw new Error("authorization completion denied");
    flow.used = true;
    this.#connections.set(flow.connectionRef, { status: "active" });
    return { status: "active" };
  }
  connectionStatus(connectionRef: string): Promise<ConnectionHealth> {
    return Promise.resolve(this.#connections.get(connectionRef) ?? { status: "error" });
  }
  proxyOperation(connectionRef: string, input: FixedOperationInput): Promise<CustodyResponse> {
    if (this.#connections.get(connectionRef)?.status !== "active") {
      return Promise.resolve({
        outcome: "auth_required",
        status: 401,
        contentType: "application/json",
        body: new Uint8Array(),
      });
    }
    if (
      input.operation !== "github.user.read" || input.integration !== "github-cairn-v1" ||
      input.path !== "/user" || input.method !== "GET"
    ) throw new Error("operation denied");
    return Promise.resolve({
      outcome: "success",
      status: 200,
      contentType: "application/json",
      body: this.githubBody.slice(),
    });
  }
  revokeConnection(connectionRef: string): Promise<{ status: "revoked" }> {
    this.#connections.set(connectionRef, { status: "revoked" });
    return Promise.resolve({ status: "revoked" });
  }
}
