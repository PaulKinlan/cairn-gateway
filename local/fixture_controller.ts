import {
  createFixtureGatewayHarness,
  type FixtureGatewayHarness,
} from "../packages/mcp-bridge/mod.ts";

const MAX_RECEIPTS = 8;
const MAX_USAGE_EVENTS = 8;
const MAX_AUDIT_EVENTS = 8;
const GRANT_LIFETIME_SECONDS = 24 * 60 * 60;
const GRANT_USAGE_LIMIT = 5;

export type InvocationSource = "local_admin" | "mcp";
export interface LocalReceipt {
  id: string;
  at: number;
  source: InvocationSource;
  operation: "github.user.read@v1";
  decision: "allow" | "deny" | "error";
  reason: "policy_allow" | "grant_inactive" | "grant_expired" | "usage_limit" | "policy_denied";
  requestUnits: 0 | 1;
  grantVersion: number;
}
export interface LocalUsageEvent {
  at: number;
  source: InvocationSource;
  decision: "allow" | "deny" | "error";
  requestUnits: 0 | 1;
  grantVersion: number;
}
export interface LocalAuditEvent {
  at: number;
  event: "grant_revoked" | "grant_replaced";
  grantVersion: number;
}
export interface LocalFixtureView {
  owner: "missing" | "active";
  connection: "missing" | "active";
  agent?: { label: string; status: "mapped" };
  identity?: { deviceLabel: string; workloadLabel: string; status: "mapped" };
  grant?: {
    operation: "github.user.read@v1";
    status: "active" | "revoked" | "expired" | "exhausted";
    version: number;
    expiresAt: number;
    usageLimit: number;
    used: number;
  };
  receipts: readonly LocalReceipt[];
  usage: readonly LocalUsageEvent[];
  audit: readonly LocalAuditEvent[];
}

export interface LocalFixtureController {
  view(): LocalFixtureView;
  createOwner(): Promise<void>;
  resetOwner(): Promise<void>;
  createAgent(name: string): Promise<void>;
  enrollIdentity(deviceName: string, workloadName: string): Promise<void>;
  createGrant(): Promise<void>;
  revokeGrant(): Promise<void>;
  reactivateGrant(): Promise<void>;
  dispatch(
    receivedBody: Uint8Array,
    path?: "/mcp" | "/mcp/legacy",
    source?: InvocationSource,
  ): Promise<Record<string, unknown> | undefined>;
}

interface MutableState {
  owner: boolean;
  agentLabel?: string;
  deviceLabel?: string;
  workloadLabel?: string;
  harness?: FixtureGatewayHarness;
  grant?: {
    status: "active" | "revoked";
    version: number;
    expiresAt: number;
    usageLimit: number;
    used: number;
  };
  receipts: LocalReceipt[];
  usage: LocalUsageEvent[];
  audit: LocalAuditEvent[];
  generation: number;
}

function nowSeconds(): number {
  const value = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("fixture clock denied");
  return value;
}

function displayLabel(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(normalized)) {
    throw new Error("label denied");
  }
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isInvocation(receivedBody: Uint8Array): boolean {
  if (receivedBody.byteLength > 64 * 1024) return false;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receivedBody));
    return isObject(value) && value.method === "tools/call" && isObject(value.params) &&
      value.params.name === "invoke_operation";
  } catch {
    return false;
  }
}

function resultReceipt(value: unknown): { decision: "allow" | "error"; requestUnits: 0 | 1 } {
  if (!isObject(value) || !isObject(value.result) || !isObject(value.result.structuredContent)) {
    return { decision: "error", requestUnits: 0 };
  }
  const receipt = value.result.structuredContent.receipt;
  if (!isObject(receipt) || (receipt.decision !== "allow" && receipt.decision !== "error")) {
    return { decision: "error", requestUnits: 0 };
  }
  return {
    decision: receipt.decision,
    requestUnits: receipt.requestUnits === 1 ? 1 : 0,
  };
}

function closedFacade(state: MutableState): LocalFixtureController {
  let lifecycleTail: Promise<void> = Promise.resolve();

  const serialized = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const prior = lifecycleTail;
    lifecycleTail = prior.then(() => gate);
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const grantStatus = (): "active" | "revoked" | "expired" | "exhausted" | undefined => {
    if (!state.grant) return undefined;
    if (state.grant.status === "revoked") return "revoked";
    if (state.grant.expiresAt <= nowSeconds()) return "expired";
    if (state.grant.used >= state.grant.usageLimit) return "exhausted";
    return "active";
  };

  const record = (
    source: InvocationSource,
    decision: "allow" | "deny" | "error",
    reason: LocalReceipt["reason"],
    requestUnits: 0 | 1,
  ): void => {
    const grant = state.grant;
    if (!state.owner || !grant) return;
    const at = nowSeconds();
    state.receipts.unshift(Object.freeze({
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      at,
      source,
      operation: "github.user.read@v1",
      decision,
      reason,
      requestUnits,
      grantVersion: grant.version,
    }));
    state.receipts.length = Math.min(state.receipts.length, MAX_RECEIPTS);
    state.usage.unshift(Object.freeze({
      at,
      source,
      decision,
      requestUnits,
      grantVersion: grant.version,
    }));
    state.usage.length = Math.min(state.usage.length, MAX_USAGE_EVENTS);
  };

  const audit = (event: LocalAuditEvent["event"]): void => {
    const grant = state.grant;
    if (!grant) return;
    state.audit.unshift(Object.freeze({ at: nowSeconds(), event, grantVersion: grant.version }));
    state.audit.length = Math.min(state.audit.length, MAX_AUDIT_EVENTS);
  };

  const view = (): LocalFixtureView => {
    const status = grantStatus();
    const snapshot: LocalFixtureView = {
      owner: state.owner ? "active" : "missing",
      connection: state.owner ? "active" : "missing",
      ...(state.agentLabel
        ? { agent: { label: state.agentLabel, status: "mapped" as const } }
        : {}),
      ...(state.deviceLabel && state.workloadLabel
        ? {
          identity: {
            deviceLabel: state.deviceLabel,
            workloadLabel: state.workloadLabel,
            status: "mapped" as const,
          },
        }
        : {}),
      ...(state.grant && status
        ? {
          grant: {
            operation: "github.user.read@v1" as const,
            status,
            version: state.grant.version,
            expiresAt: state.grant.expiresAt,
            usageLimit: state.grant.usageLimit,
            used: state.grant.used,
          },
        }
        : {}),
      receipts: state.receipts.map((receipt) => ({ ...receipt })),
      usage: state.usage.map((event) => ({ ...event })),
      audit: state.audit.map((event) => ({ ...event })),
    };
    return structuredClone(snapshot);
  };

  const createOwner = (): Promise<void> =>
    serialized(() => {
      if (state.owner) throw new Error("owner already exists");
      state.owner = true;
      state.generation += 1;
    });

  const resetOwner = (): Promise<void> =>
    serialized(() => {
      state.generation += 1;
      state.owner = false;
      delete state.agentLabel;
      delete state.deviceLabel;
      delete state.workloadLabel;
      delete state.harness;
      delete state.grant;
      state.receipts.length = 0;
      state.usage.length = 0;
      state.audit.length = 0;
    });

  const createAgent = (name: string): Promise<void> =>
    serialized(() => {
      if (!state.owner || state.agentLabel) throw new Error("agent lifecycle denied");
      state.agentLabel = displayLabel(name);
      state.generation += 1;
    });

  const enrollIdentity = (deviceName: string, workloadName: string): Promise<void> =>
    serialized(() => {
      if (!state.owner || !state.agentLabel || state.deviceLabel || state.workloadLabel) {
        throw new Error("identity lifecycle denied");
      }
      const device = displayLabel(deviceName);
      const workload = displayLabel(workloadName);
      const distinct = new Set(
        [state.agentLabel, device, workload].map((value) => value.toLowerCase()),
      );
      if (distinct.size !== 3) throw new Error("identity labels must be distinct");
      state.deviceLabel = device;
      state.workloadLabel = workload;
      state.generation += 1;
    });

  const createGrant = (): Promise<void> =>
    serialized(async () => {
      if (
        !state.owner || !state.agentLabel || !state.deviceLabel || !state.workloadLabel ||
        state.grant
      ) throw new Error("grant lifecycle denied");
      const generation = state.generation;
      const harness = await createFixtureGatewayHarness();
      if (
        generation !== state.generation || !state.owner || !state.agentLabel ||
        !state.deviceLabel || !state.workloadLabel || state.grant
      ) throw new Error("grant lifecycle denied");
      state.harness = harness;
      state.grant = {
        status: "active",
        version: 1,
        expiresAt: nowSeconds() + GRANT_LIFETIME_SECONDS,
        usageLimit: GRANT_USAGE_LIMIT,
        used: 0,
      };
      state.generation += 1;
    });

  const revokeGrant = (): Promise<void> =>
    serialized(async () => {
      if (!state.grant || !state.harness || state.grant.status !== "active") {
        throw new Error("grant lifecycle denied");
      }
      await state.harness.revoke("grant");
      state.grant.status = "revoked";
      state.grant.version += 1;
      state.generation += 1;
      audit("grant_revoked");
    });

  const reactivateGrant = (): Promise<void> =>
    serialized(async () => {
      if (!state.grant || !state.harness || grantStatus() === "active") {
        throw new Error("grant lifecycle denied");
      }
      await state.harness.revokeAndReactivate("grant");
      state.grant.status = "active";
      state.grant.version += 2;
      const nextExpiry = nowSeconds() + GRANT_LIFETIME_SECONDS;
      state.grant.expiresAt = nextExpiry > state.grant.expiresAt
        ? nextExpiry
        : state.grant.expiresAt + 1;
      state.grant.used = 0;
      state.generation += 1;
      audit("grant_replaced");
    });

  const dispatchInvocation = async (
    receivedBody: Uint8Array,
    path: "/mcp" | "/mcp/legacy",
    source: InvocationSource,
  ): Promise<Record<string, unknown> | undefined> => {
    const status = grantStatus();
    if (!state.harness || !state.grant || !state.owner) {
      throw new Error("fixture authority denied");
    }
    if (status !== "active") {
      const reason = status === "expired"
        ? "grant_expired"
        : status === "exhausted"
        ? "usage_limit"
        : "grant_inactive";
      record(source, "deny", reason, 0);
      throw new Error("fixture authority denied");
    }
    const generation = state.generation;
    try {
      const response = await state.harness.dispatch(receivedBody, path);
      if (generation !== state.generation || !state.owner || !state.grant) {
        throw new Error("fixture generation denied");
      }
      const safe = resultReceipt(response);
      if (safe.decision === "allow" && safe.requestUnits === 1) state.grant.used += 1;
      record(
        source,
        safe.decision,
        safe.decision === "allow" ? "policy_allow" : "policy_denied",
        safe.requestUnits,
      );
      return response;
    } catch {
      if (generation === state.generation && state.owner && state.grant) {
        record(source, "deny", "policy_denied", 0);
      }
      throw new Error("fixture authority denied");
    }
  };

  const dispatch = (
    receivedBody: Uint8Array,
    path: "/mcp" | "/mcp/legacy" = "/mcp",
    source: InvocationSource = "mcp",
  ): Promise<Record<string, unknown> | undefined> =>
    serialized(async () => {
      if (path !== "/mcp" && path !== "/mcp/legacy") throw new Error("route denied");
      if (source !== "local_admin" && source !== "mcp") throw new Error("source denied");
      if (isInvocation(receivedBody)) {
        return await dispatchInvocation(receivedBody, path, source);
      }
      if (!state.owner || !state.harness || !state.grant || grantStatus() !== "active") {
        throw new Error("fixture authority denied");
      }
      return await state.harness.dispatch(receivedBody, path);
    });

  const capabilities = {
    view,
    createOwner,
    resetOwner,
    createAgent,
    enrollIdentity,
    createGrant,
    revokeGrant,
    reactivateGrant,
    dispatch,
  };
  for (const capability of Object.values(capabilities)) {
    Object.setPrototypeOf(capability, null);
    Object.freeze(capability);
  }
  return Object.freeze(Object.assign(Object.create(null), capabilities));
}

/**
 * Fixture-only local controller. Display labels map to the fixed, non-exported cryptographic test
 * authority; they are not caller-selected authorization identifiers.
 */
export function createLocalFixtureController(): LocalFixtureController {
  return closedFacade({
    owner: false,
    receipts: [],
    usage: [],
    audit: [],
    generation: 0,
  });
}
