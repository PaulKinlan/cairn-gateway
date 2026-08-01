import type { SafeOutcome } from "../custody/custody_adapter.ts";
export type ReceiptReason =
  | "policy_allow"
  | "invocation_disabled"
  | "capability_invalid"
  | "ownership_denied"
  | "binding_denied"
  | "arguments_denied"
  | "device_proof_denied"
  | "agent_proof_denied"
  | "principal_inactive"
  | "agent_inactive"
  | "device_inactive"
  | "grant_inactive"
  | "connection_inactive"
  | "nonce_replay"
  | "capability_replay"
  | "provider_failure";
export interface Receipt {
  correlationId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  deviceId: string;
  connectionId: string;
  operation: "github.user.read";
  decision: "allow" | "deny" | "error";
  reason: ReceiptReason;
  at: number;
  latency: "lt100ms" | "lt1s" | "gte1s";
  statusClass: SafeOutcome | "policy_denied";
  responseSize: "none" | "lt4k" | "lt64k";
  requestUnits: 0 | 1;
  retryCount: 0;
  redactionPolicyVersion: 1;
}
const reasons = new Set<ReceiptReason>([
  "policy_allow",
  "invocation_disabled",
  "capability_invalid",
  "ownership_denied",
  "binding_denied",
  "arguments_denied",
  "device_proof_denied",
  "agent_proof_denied",
  "principal_inactive",
  "agent_inactive",
  "device_inactive",
  "grant_inactive",
  "connection_inactive",
  "nonce_replay",
  "capability_replay",
  "provider_failure",
]);
const decisions = new Set(["allow", "deny", "error"]),
  operations = new Set(["github.user.read"]),
  latencies = new Set(["lt100ms", "lt1s", "gte1s"]),
  outcomes = new Set([
    "success",
    "auth_required",
    "rate_limited",
    "provider_denied",
    "provider_unavailable",
    "policy_denied",
  ]),
  sizes = new Set(["none", "lt4k", "lt64k"]);
const safeId = (value: string): string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : "invalid";
export function makeReceipt(input: Receipt): Receipt {
  if (
    !input || typeof input !== "object" || !reasons.has(input.reason) ||
    !decisions.has(input.decision) || !operations.has(input.operation) ||
    !latencies.has(input.latency) || !outcomes.has(input.statusClass) ||
    !sizes.has(input.responseSize) || !Number.isInteger(input.at) || input.at < 0 ||
    (input.requestUnits !== 0 && input.requestUnits !== 1) || input.retryCount !== 0 ||
    input.redactionPolicyVersion !== 1
  ) {
    throw new Error("invalid receipt metadata");
  }
  return Object.freeze({
    ...input,
    correlationId: safeId(input.correlationId),
    tenantId: safeId(input.tenantId),
    userId: safeId(input.userId),
    agentId: safeId(input.agentId),
    deviceId: safeId(input.deviceId),
    connectionId: safeId(input.connectionId),
    retryCount: 0,
    redactionPolicyVersion: 1,
  });
}
