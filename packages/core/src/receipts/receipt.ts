import type { SafeOutcome } from "../custody/custody_adapter.ts";
export interface Receipt {
  correlationId: string;
  tenantId: string;
  userId: string;
  agentId: string;
  deviceId: string;
  connectionId: string;
  operation: "github.user.read";
  decision: "allow" | "deny";
  reason: string;
  at: number;
  latency: "lt100ms" | "lt1s" | "gte1s";
  statusClass: SafeOutcome | "policy_denied";
  responseSize: "none" | "lt4k" | "lt64k";
  requestUnits: 0 | 1;
  retryCount: 0;
  redactionPolicyVersion: 1;
}
export function makeReceipt(input: Receipt): Receipt {
  return Object.freeze({ ...input, retryCount: 0, redactionPolicyVersion: 1 });
}
