// Compatibility import for the gateway handler. The trust predicate is public,
// but its WeakMap and sole mint remain private inside the executable bridge.
export { isTrustedPolicyMcpCore } from "../../packages/mcp-bridge/src/local_bridge.ts";
