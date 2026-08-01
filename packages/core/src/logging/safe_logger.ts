import type { Receipt } from "../receipts/receipt.ts";
export type SafeEvent =
  | {
    type: "decision";
    correlationId: string;
    tenantId: string;
    operation: "github.user.read";
    decision: "allow" | "deny";
    reason: string;
  }
  | { type: "receipt"; receipt: Receipt };
export interface SafeLogger {
  emit(event: SafeEvent): void;
}
export class MemorySafeLogger implements SafeLogger {
  readonly events: SafeEvent[] = [];
  emit(event: SafeEvent): void {
    this.events.push(structuredClone(event));
  }
}
