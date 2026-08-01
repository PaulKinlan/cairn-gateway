import type { DetachedProof, RequestProofPayload } from "../../core/src/crypto/request_proof.ts";
export interface LocalSigningBridge {
  signUpstream(payload: RequestProofPayload): Promise<DetachedProof>;
  invokeWithInternalCapability(input: {
    operation: "github.user.read";
    connectionAlias: string;
    arguments: Record<string, never>;
  }): Promise<unknown>;
}
export interface BridgeKeyStore {
  sign(payload: Uint8Array): Promise<Uint8Array>;
  publicIdentity(): Promise<{ deviceId: string; publicJwk: JsonWebKey }>;
}
// Implementations must use OS/hardware custody. No extract/export or model-visible capability method exists.
