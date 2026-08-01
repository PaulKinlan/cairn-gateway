import type { TenantContext } from "../domain/types.ts";
export type SafeOutcome =
  | "success"
  | "auth_required"
  | "rate_limited"
  | "provider_denied"
  | "provider_unavailable";
export interface CustodyBinding {
  context: TenantContext;
  connectionId: string;
  connectionRef: string;
  integration: "github-cairn-v1";
  redirectUri: "https://fixture.cairn.invalid/oauth/github/callback";
}
export interface AuthorizationStart {
  handle: string;
  callbackOwnership: "gateway" | "custodian";
  expiresAt: number;
}
export interface AuthorizationCompletion {
  status: "active" | "pending" | "failed";
}
export interface ConnectionHealth {
  status: "active" | "pending" | "revoked" | "error";
}
export interface FixedOperationInput {
  operation: "github.user.read";
  integration: "github-cairn-v1";
  path: "/user";
  method: "GET";
}
export interface CustodyResponse {
  outcome: SafeOutcome;
  status: number;
  contentType: string;
  body: Uint8Array;
}
export interface CustodyAdapter {
  beginAuthorization(
    input: { flowId: string; binding: CustodyBinding; now: number },
  ): Promise<AuthorizationStart>;
  completeAuthorization(
    input: {
      flowId: string;
      binding: CustodyBinding;
      state: string;
      code: string;
      verifier: string;
      now: number;
    },
  ): Promise<AuthorizationCompletion>;
  connectionStatus(binding: CustodyBinding): Promise<ConnectionHealth>;
  proxyOperation(binding: CustodyBinding, input: FixedOperationInput): Promise<CustodyResponse>;
  revokeConnection(binding: CustodyBinding): Promise<{ status: "revoked" }>;
}
