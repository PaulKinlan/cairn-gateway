export type SafeOutcome =
  | "success"
  | "auth_required"
  | "rate_limited"
  | "provider_denied"
  | "provider_unavailable";
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
    input: { flowId: string; connectionRef: string; now: number },
  ): Promise<AuthorizationStart>;
  completeAuthorization(
    input: { flowId: string; state: string; code: string; verifier: string; now: number },
  ): Promise<AuthorizationCompletion>;
  connectionStatus(connectionRef: string): Promise<ConnectionHealth>;
  proxyOperation(connectionRef: string, input: FixedOperationInput): Promise<CustodyResponse>;
  revokeConnection(connectionRef: string): Promise<{ status: "revoked" }>;
}
