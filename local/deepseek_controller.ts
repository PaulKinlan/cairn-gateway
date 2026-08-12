import { atomicWriteJson, readJsonFile } from "./atomic_json.ts";

import {
  CHAT_ARGUMENTS_SCHEMA,
  CHAT_OPERATION_OUTPUT_SCHEMA,
  DEEPSEEK_CONNECTION,
  DEEPSEEK_OPERATION,
} from "./deepseek_contract.ts";

export { DEEPSEEK_CONNECTION, DEEPSEEK_OPERATION } from "./deepseek_contract.ts";
const MAX_METADATA_BYTES = 16 * 1024;

export interface DeepSeekReceipt {
  id: string;
  at: number;
  decision: "allow" | "deny" | "error";
  reason: "policy_allow" | "not_configured" | "disconnected" | "custodian_denied";
  requestUnits: 0 | 1;
  inputTokens?: number;
  outputTokens?: number;
}
export interface DeepSeekView {
  configured: boolean;
  connected: boolean;
  healthy: boolean | null;
  grant: {
    operation: typeof DEEPSEEK_OPERATION;
    status: "active" | "disconnected";
    version: number;
  };
  receipts: readonly DeepSeekReceipt[];
}
export interface LocalMetadata {
  schemaVersion: 1;
  configured: boolean;
  connected: boolean;
  grantVersion: number;
  receipts: DeepSeekReceipt[];
}
export interface MetadataStore {
  load(): Promise<LocalMetadata | undefined>;
  save(value: LocalMetadata): Promise<void>;
  reset(): Promise<void>;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => key in value) && Object.keys(value).every((key) => keys.includes(key));
}
function validReceipt(value: unknown): value is DeepSeekReceipt {
  if (
    !record(value) ||
    !exact(value, [
      "id",
      "at",
      "decision",
      "reason",
      "requestUnits",
      ...(value.inputTokens === undefined ? [] : ["inputTokens"]),
      ...(value.outputTokens === undefined ? [] : ["outputTokens"]),
    ])
  ) return false;
  return typeof value.id === "string" && /^[a-f0-9]{16}$/.test(value.id) &&
    Number.isSafeInteger(value.at) &&
    ["allow", "deny", "error"].includes(value.decision as string) &&
    ["policy_allow", "not_configured", "disconnected", "custodian_denied"].includes(
      value.reason as string,
    ) &&
    (value.requestUnits === 0 || value.requestUnits === 1) &&
    (value.inputTokens === undefined ||
      Number.isSafeInteger(value.inputTokens) && (value.inputTokens as number) >= 0) &&
    (value.outputTokens === undefined ||
      Number.isSafeInteger(value.outputTokens) && (value.outputTokens as number) >= 0);
}
function validMetadata(value: unknown): value is LocalMetadata {
  return record(value) &&
    exact(value, ["schemaVersion", "configured", "connected", "grantVersion", "receipts"]) &&
    value.schemaVersion === 1 && typeof value.configured === "boolean" &&
    typeof value.connected === "boolean" &&
    Number.isSafeInteger(value.grantVersion) && (value.grantVersion as number) >= 1 &&
    (value.grantVersion as number) <= 1_000_000 && Array.isArray(value.receipts) &&
    value.receipts.length <= 8 &&
    value.receipts.every(validReceipt);
}
export class FileMetadataStore implements MetadataStore {
  constructor(readonly path: string) {}
  async load() {
    const value = await readJsonFile(this.path, MAX_METADATA_BYTES);
    if (value === undefined) return undefined;
    if (!validMetadata(value)) throw new Error("metadata invalid");
    return value;
  }
  save(value: LocalMetadata) {
    return atomicWriteJson(this.path, value);
  }
  async reset() {
    try {
      await Deno.remove(this.path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}
export class MemoryMetadataStore implements MetadataStore {
  value?: LocalMetadata;
  load() {
    return Promise.resolve(this.value ? structuredClone(this.value) : undefined);
  }
  save(value: LocalMetadata) {
    this.value = structuredClone(value);
    return Promise.resolve();
  }
  reset() {
    this.value = undefined;
    return Promise.resolve();
  }
}
export interface CustodianSuccess {
  outcome: "success";
  assistant_text: string;
  finish_category: "complete" | "length";
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}
export type CustodianOutput = CustodianSuccess | {
  outcome:
    | "invalid_input"
    | "rate_limited"
    | "auth_required"
    | "provider_unavailable"
    | "authority_changed";
};
export interface CustodianClient {
  status(): Promise<{ configured: boolean; healthy: boolean | null }>;
  invoke(input: unknown): Promise<CustodianOutput>;
  delete(): Promise<void>;
}
async function boundedJsonResponse(
  response: Response,
  allowedStatuses: readonly number[],
): Promise<unknown> {
  if (!allowedStatuses.includes(response.status)) throw new Error("custodian request denied");
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 64 * 1024) throw new Error("custodian response too large");
  if (!response.body) throw new Error("custodian response denied");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      throw new Error("custodian response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function validStatus(value: unknown): value is { configured: boolean; healthy: boolean | null } {
  return record(value) && exact(value, ["configured", "healthy"]) &&
    typeof value.configured === "boolean" &&
    (value.healthy === null || typeof value.healthy === "boolean");
}
function validOutput(value: unknown): value is CustodianOutput {
  if (!record(value) || typeof value.outcome !== "string") return false;
  if (value.outcome !== "success") {
    return exact(value, ["outcome"]) &&
      [
        "invalid_input",
        "rate_limited",
        "auth_required",
        "provider_unavailable",
        "authority_changed",
      ].includes(value.outcome);
  }
  return exact(value, ["outcome", "assistant_text", "finish_category", "usage"]) &&
    typeof value.assistant_text === "string" &&
    ["complete", "length"].includes(value.finish_category as string) && record(value.usage) &&
    exact(value.usage, ["input_tokens", "output_tokens", "total_tokens"]) &&
    [value.usage.input_tokens, value.usage.output_tokens, value.usage.total_tokens].every((n) =>
      Number.isSafeInteger(n) && (n as number) >= 0
    ) &&
    (value.usage.input_tokens as number) + (value.usage.output_tokens as number) ===
      value.usage.total_tokens;
}
export function httpCustodianClient(origin: string, credential: string): CustodianClient {
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    allowedStatuses: readonly number[] = [200],
  ) =>
    boundedJsonResponse(
      await fetch(`${origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      allowedStatuses,
    );
  return {
    status: async () => {
      const value = await request("/internal/status");
      if (!validStatus(value)) throw new Error("custodian status denied");
      return value;
    },
    invoke: async (input) => {
      const value = await request(
        "/internal/invoke",
        "POST",
        input,
        [200, 400, 401, 409, 429, 503],
      );
      if (!validOutput(value)) throw new Error("custodian output denied");
      return value;
    },
    delete: async () => {
      const value = await request("/internal/delete", "POST");
      if (!record(value) || !exact(value, ["deleted"]) || value.deleted !== true) {
        throw new Error("custodian deletion denied");
      }
    },
  };
}

export async function createDeepSeekController(
  custodian: CustodianClient,
  metadata: MetadataStore,
) {
  let state: LocalMetadata;
  const saved = await metadata.load();
  if (saved) state = saved;
  else {
    state = {
      schemaVersion: 1,
      configured: false,
      connected: false,
      grantVersion: 1,
      receipts: [],
    };
    try {
      await metadata.save(state);
    } catch {
      throw new Error("metadata unavailable");
    }
  }
  let health: boolean | null = null;
  let generation = 0;
  let refreshSequence = 0;
  let deletionInProgress = false;
  let serializedTail = Promise.resolve();
  const serialized = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const previous = serializedTail;
    serializedTail = previous.then(() => gate, () => gate);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const commit = async (next: LocalMetadata) => {
    await metadata.save(next);
    state = next;
  };
  const beginRefresh = () => serialized(() => ({ generation, sequence: ++refreshSequence }));
  const applyRefresh = async (
    snapshot: { generation: number; sequence: number },
    status?: { configured: boolean; healthy: boolean | null },
  ): Promise<boolean> =>
    await serialized(async () => {
      if (snapshot.generation !== generation || snapshot.sequence !== refreshSequence) return false;
      const configured = status?.configured ?? false;
      // A status refresh owns only configured/health. Lifecycle state and grant version belong
      // exclusively to connect/disconnect/delete and are preserved even on a negative refresh.
      const next = { ...structuredClone(state), configured };
      if (next.configured !== state.configured) {
        await commit(next);
        generation++;
      }
      health = status?.healthy ?? null;
      return true;
    });
  const refresh = async (): Promise<boolean> => {
    const snapshot = await beginRefresh();
    try {
      return await applyRefresh(snapshot, await custodian.status());
    } catch {
      await applyRefresh(snapshot);
      return false;
    }
  };
  await refresh();

  const addReceipt = async (
    decision: DeepSeekReceipt["decision"],
    reason: DeepSeekReceipt["reason"],
    units: 0 | 1,
    tokens?: { input: number; output: number },
  ) => {
    const next = structuredClone(state);
    next.receipts.unshift({
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      at: Math.floor(Date.now() / 1000),
      decision,
      reason,
      requestUnits: units,
      ...(tokens ? { inputTokens: tokens.input, outputTokens: tokens.output } : {}),
    });
    next.receipts.length = Math.min(8, next.receipts.length);
    await commit(next);
  };
  const result = (id: string | number, structuredContent: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  });
  const authorityAvailable = () => state.configured && state.connected;
  const persistedAuthorityMatches = async (expectedGeneration: number) => {
    if (generation !== expectedGeneration || !authorityAvailable()) return false;
    let persisted: LocalMetadata | undefined;
    try {
      persisted = await metadata.load();
    } catch {
      return false;
    }
    return !!persisted && persisted.configured && persisted.connected &&
      persisted.grantVersion === state.grantVersion;
  };

  return Object.freeze({
    async view(): Promise<DeepSeekView> {
      await refresh();
      return await serialized(() => ({
        configured: state.configured,
        connected: state.connected,
        healthy: health,
        grant: {
          operation: DEEPSEEK_OPERATION,
          status: state.connected ? "active" : "disconnected",
          version: state.grantVersion,
        },
        receipts: structuredClone(state.receipts),
      }));
    },
    connect: async () => {
      const snapshot = await serialized(() => {
        if (deletionInProgress) throw new Error("deletion in progress");
        return { generation, sequence: ++refreshSequence };
      });
      let status: { configured: boolean; healthy: boolean | null };
      try {
        status = await custodian.status();
      } catch {
        await applyRefresh(snapshot);
        throw new Error("not configured");
      }
      await serialized(async () => {
        if (
          deletionInProgress || snapshot.generation !== generation ||
          snapshot.sequence !== refreshSequence
        ) {
          throw new Error("authority changed");
        }
        if (!status.configured) {
          const next = { ...structuredClone(state), configured: false };
          if (next.configured !== state.configured) {
            await commit(next);
            generation++;
          }
          health = status.healthy;
          throw new Error("not configured");
        }
        const next = {
          ...structuredClone(state),
          configured: true,
          connected: true,
          grantVersion: state.grantVersion + 1,
        };
        await commit(next);
        health = status.healthy;
        generation++;
      });
    },
    disconnect: () =>
      serialized(async () => {
        refreshSequence++;
        const next = {
          ...structuredClone(state),
          connected: false,
          grantVersion: state.grantVersion + 1,
        };
        await commit(next);
        generation++;
      }),
    delete: async () => {
      await serialized(async () => {
        if (deletionInProgress) throw new Error("deletion in progress");
        deletionInProgress = true;
        refreshSequence++;
        const disabled = {
          ...structuredClone(state),
          connected: false,
          grantVersion: state.grantVersion + 1,
        };
        try {
          await commit(disabled);
          generation++;
        } catch (error) {
          deletionInProgress = false;
          throw error;
        }
      });
      // Do not hold the authority lock across Secret Service deletion. Disconnect remains
      // immediately effective, while connect is denied until deletion has a definitive outcome.
      try {
        await custodian.delete();
      } catch (error) {
        await serialized(() => deletionInProgress = false);
        throw error;
      }
      await serialized(async () => {
        if (!deletionInProgress || state.connected) {
          throw new Error("authority changed during deletion");
        }
        const deleted = {
          ...structuredClone(state),
          configured: false,
          connected: false,
          receipts: [],
        };
        try {
          await commit(deleted);
          generation++;
          health = null;
        } finally {
          deletionInProgress = false;
        }
      });
    },
    async dispatch(receivedBody: Uint8Array): Promise<Record<string, unknown>> {
      let rpc: unknown;
      try {
        rpc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receivedBody));
      } catch {
        throw new Error("request denied");
      }
      if (
        !record(rpc) || rpc.jsonrpc !== "2.0" || rpc.method !== "tools/call" ||
        !record(rpc.params) || typeof rpc.params.name !== "string" ||
        !record(rpc.params.arguments) || !(typeof rpc.id === "string" || typeof rpc.id === "number")
      ) throw new Error("request denied");
      const id = rpc.id;
      const name = rpc.params.name;
      const args = rpc.params.arguments;
      await refresh();

      if (name === "search_capabilities") {
        if (
          !exact(args, ["query"]) || typeof args.query !== "string" || args.query.length < 1 ||
          args.query.length > 200
        ) throw new Error("invalid input");
        return await serialized(() => {
          if (!authorityAvailable()) throw new Error("authority unavailable");
          return result(id, {
            operations: [{ id: DEEPSEEK_OPERATION, connection: DEEPSEEK_CONNECTION }],
            count: 1,
          });
        });
      }
      if (name === "describe_operation") {
        if (!exact(args, ["operation"]) || args.operation !== DEEPSEEK_OPERATION) {
          throw new Error("invalid input");
        }
        return await serialized(() => {
          if (!authorityAvailable()) throw new Error("authority unavailable");
          return result(id, {
            id: DEEPSEEK_OPERATION,
            provider: "deepseek",
            inputSchema: CHAT_ARGUMENTS_SCHEMA,
            outputSchema: CHAT_OPERATION_OUTPUT_SCHEMA,
            requestUnits: 1,
          });
        });
      }
      if (name === "connection_status") {
        if (!exact(args, ["connection"]) || args.connection !== DEEPSEEK_CONNECTION) {
          throw new Error("invalid input");
        }
        return await serialized(() => {
          if (!authorityAvailable()) throw new Error("authority unavailable");
          return result(id, {
            connection: DEEPSEEK_CONNECTION,
            status: "active",
            configured: true,
            healthy: health,
            operation: DEEPSEEK_OPERATION,
          });
        });
      }
      if (
        name !== "invoke_operation" || !exact(args, ["operation", "connection", "arguments"]) ||
        args.operation !== DEEPSEEK_OPERATION || args.connection !== DEEPSEEK_CONNECTION
      ) throw new Error("invalid input");

      const dispatchGeneration = await serialized(() => {
        if (!authorityAvailable()) throw new Error("authority unavailable");
        return generation;
      });
      // Provider I/O is deliberately outside the serialized authority section. A disconnect or
      // delete can commit immediately; the generation and persisted authority are rechecked below.
      const output = await custodian.invoke(args.arguments);
      return await serialized(async () => {
        if (!await persistedAuthorityMatches(dispatchGeneration)) {
          throw new Error("authority changed during dispatch");
        }
        if (output.outcome === "success") {
          await addReceipt("allow", "policy_allow", 1, {
            input: output.usage.input_tokens,
            output: output.usage.output_tokens,
          });
          return result(id, {
            outcome: "success",
            assistant_text: output.assistant_text,
            finish_category: output.finish_category,
            usage: {
              input_tokens: output.usage.input_tokens,
              output_tokens: output.usage.output_tokens,
              total_tokens: output.usage.total_tokens,
            },
            receipt: { decision: "allow", reason: "policy_allow", requestUnits: 1 },
          });
        }
        await addReceipt("error", "custodian_denied", 0);
        return result(id, {
          outcome: output.outcome,
          receipt: { decision: "error", reason: "custodian_denied", requestUnits: 0 },
        });
      });
    },
  });
}
