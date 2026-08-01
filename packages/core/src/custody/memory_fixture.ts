import type {
  AuthorizationCompletion,
  AuthorizationStart,
  ConnectionHealth,
  CustodyAdapter,
  CustodyBinding,
  CustodyResponse,
  FixedOperationInput,
} from "./custody_adapter.ts";
import { base64url, encoder, sha256 } from "../crypto/encoding.ts";
interface FixtureFlow {
  bindingHash: string;
  stateHash: string;
  challenge: string;
  expiresAt: number;
  used: boolean;
  connectionRef: string;
}
interface CallbackMaterial {
  state: string;
  verifier: string;
}
export class MemoryCustodyFixture implements CustodyAdapter {
  #flows = new Map<string, FixtureFlow>();
  #materials = new Map<string, CallbackMaterial>();
  #connections = new Map<string, ConnectionHealth>();
  #tail: Promise<void> = Promise.resolve();
  constructor(private readonly githubBody: Uint8Array) {}
  async #exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => release = r);
    const prior = this.#tail;
    this.#tail = prior.then(() => gate);
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async #bindingHash(binding: CustodyBinding): Promise<string> {
    return await sha256(
      JSON.stringify([
        binding.context.tenantId,
        binding.context.userId,
        binding.connectionId,
        binding.connectionRef,
        binding.integration,
        binding.redirectUri,
      ]),
    );
  }
  #key(binding: CustodyBinding): string {
    return `${binding.context.tenantId}/${binding.context.userId}/${binding.connectionId}/${binding.connectionRef}`;
  }
  async beginAuthorization(
    input: { flowId: string; binding: CustodyBinding; now: number },
  ): Promise<AuthorizationStart> {
    return await this.#exclusive(async () => {
      if (this.#flows.has(input.flowId) || this.#connections.has(this.#key(input.binding))) {
        throw new Error("authorization start denied");
      }
      const state = base64url(crypto.getRandomValues(new Uint8Array(32))),
        verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
      const challenge = base64url(
        new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))),
      );
      this.#flows.set(input.flowId, {
        bindingHash: await this.#bindingHash(input.binding),
        stateHash: await sha256(state),
        challenge,
        expiresAt: input.now + 600,
        used: false,
        connectionRef: this.#key(input.binding),
      });
      this.#materials.set(input.flowId, { state, verifier });
      this.#connections.set(this.#key(input.binding), { status: "pending" });
      return { handle: input.flowId, callbackOwnership: "gateway", expiresAt: input.now + 600 };
    });
  }
  /** Fixture harness only; never part of CustodyAdapter or a runtime export surface. */
  fixtureCallbackMaterial(flowId: string): Readonly<CallbackMaterial> {
    const value = this.#materials.get(flowId);
    if (!value) throw new Error("fixture flow absent");
    return { ...value };
  }
  async completeAuthorization(
    input: {
      flowId: string;
      binding: CustodyBinding;
      state: string;
      code: string;
      verifier: string;
      now: number;
    },
  ): Promise<AuthorizationCompletion> {
    return await this.#exclusive(async () => {
      const flow = this.#flows.get(input.flowId),
        challenge = base64url(
          new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(input.verifier))),
        );
      if (
        !flow || flow.used || flow.expiresAt < input.now ||
        flow.bindingHash !== await this.#bindingHash(input.binding) ||
        await sha256(input.state) !== flow.stateHash || challenge !== flow.challenge ||
        input.code !== "fixture_authorization_code"
      ) throw new Error("authorization completion denied");
      flow.used = true;
      this.#flows.set(input.flowId, flow);
      this.#materials.delete(input.flowId);
      this.#connections.set(flow.connectionRef, { status: "active" });
      return { status: "active" };
    });
  }
  connectionStatus(binding: CustodyBinding): Promise<ConnectionHealth> {
    return Promise.resolve(this.#connections.get(this.#key(binding)) ?? { status: "error" });
  }
  proxyOperation(binding: CustodyBinding, input: FixedOperationInput): Promise<CustodyResponse> {
    if (this.#connections.get(this.#key(binding))?.status !== "active") {
      return Promise.resolve({
        outcome: "auth_required",
        status: 401,
        contentType: "application/json",
        body: new Uint8Array(),
      });
    }
    if (
      input.operation !== "github.user.read" || input.integration !== binding.integration ||
      input.path !== "/user" || input.method !== "GET"
    ) throw new Error("operation denied");
    return Promise.resolve({
      outcome: "success",
      status: 200,
      contentType: "application/json",
      body: this.githubBody.slice(),
    });
  }
  revokeConnection(binding: CustodyBinding): Promise<{ status: "revoked" }> {
    this.#connections.set(this.#key(binding), { status: "revoked" });
    return Promise.resolve({ status: "revoked" });
  }
}
