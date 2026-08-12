export const DEEPSEEK_OPERATION = "deepseek.chat.complete@v1" as const;
export const DEEPSEEK_CONNECTION = "deepseek_local" as const;

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
export class FileMetadataStore implements MetadataStore {
  constructor(readonly path: string) {}
  async load() {
    try {
      return JSON.parse(await Deno.readTextFile(this.path)) as LocalMetadata;
    } catch {
      return undefined;
    }
  }
  async save(value: LocalMetadata) {
    await Deno.mkdir(this.path.slice(0, this.path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(this.path, JSON.stringify(value));
  }
  async reset() {
    try {
      await Deno.remove(this.path);
    } catch { /* absent */ }
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
export interface CustodianClient {
  status(): Promise<{ configured: boolean; healthy: boolean | null }>;
  invoke(input: unknown): Promise<Record<string, unknown>>;
  delete(): Promise<void>;
}
export function httpCustodianClient(origin: string, credential: string): CustodianClient {
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return await response.json();
  };
  return {
    status: () => request("/internal/status"),
    invoke: (input) => request("/internal/invoke", "POST", input),
    delete: async () => {
      await request("/internal/delete", "POST");
    },
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => key in value) && Object.keys(value).every((key) => keys.includes(key));
}
export async function createDeepSeekController(
  custodian: CustodianClient,
  metadata: MetadataStore,
) {
  const saved = await metadata.load();
  const state: LocalMetadata =
    saved && typeof saved.configured === "boolean" && typeof saved.connected === "boolean" &&
      Number.isInteger(saved.grantVersion) && Array.isArray(saved.receipts)
      ? saved
      : { configured: false, connected: true, grantVersion: 1, receipts: [] };
  let health: boolean | null = null;
  const persist = () => metadata.save(state);
  const refresh = async () => {
    const status = await custodian.status();
    state.configured = status.configured;
    health = status.healthy;
    await persist();
  };
  await refresh();
  const receipt = async (
    decision: DeepSeekReceipt["decision"],
    reason: DeepSeekReceipt["reason"],
    units: 0 | 1,
    tokens?: { input: number; output: number },
  ) => {
    state.receipts.unshift({
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      at: Math.floor(Date.now() / 1000),
      decision,
      reason,
      requestUnits: units,
      ...(tokens ? { inputTokens: tokens.input, outputTokens: tokens.output } : {}),
    });
    state.receipts.length = Math.min(8, state.receipts.length);
    await persist();
  };
  return Object.freeze({
    async view(): Promise<DeepSeekView> {
      await refresh();
      return {
        configured: state.configured,
        connected: state.connected,
        healthy: health,
        grant: {
          operation: DEEPSEEK_OPERATION,
          status: state.connected ? "active" : "disconnected",
          version: state.grantVersion,
        },
        receipts: structuredClone(state.receipts),
      };
    },
    async connect() {
      await refresh();
      if (!state.configured) throw new Error("not configured");
      state.connected = true;
      state.grantVersion++;
      await persist();
    },
    async disconnect() {
      state.connected = false;
      state.grantVersion++;
      await persist();
    },
    async delete() {
      state.connected = false;
      state.configured = false;
      state.grantVersion++;
      state.receipts = [];
      await custodian.delete();
      await persist();
    },
    async dispatch(receivedBody: Uint8Array): Promise<Record<string, unknown>> {
      let rpc: unknown;
      try {
        rpc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receivedBody));
      } catch {
        throw new Error("request denied");
      }
      if (
        !object(rpc) || rpc.jsonrpc !== "2.0" || rpc.method !== "tools/call" ||
        !object(rpc.params) || typeof rpc.params.name !== "string" || !object(rpc.params.arguments)
      ) throw new Error("request denied");
      const id = rpc.id as string | number;
      const name = rpc.params.name;
      const args = rpc.params.arguments;
      const result = (structuredContent: Record<string, unknown>) => ({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        },
      });
      await refresh();
      if (!state.configured || !state.connected) throw new Error("authority unavailable");
      if (name === "search_capabilities") {
        if (
          !exact(args, ["query"]) || typeof args.query !== "string" || args.query.length < 1 ||
          args.query.length > 200
        ) throw new Error("invalid input");
        return result({
          operations: [{ id: DEEPSEEK_OPERATION, connection: DEEPSEEK_CONNECTION }],
          count: 1,
        });
      }
      if (name === "describe_operation") {
        if (!exact(args, ["operation"]) || args.operation !== DEEPSEEK_OPERATION) {
          throw new Error("invalid input");
        }
        return result({
          id: DEEPSEEK_OPERATION,
          provider: "deepseek",
          inputSchema: { type: "object", required: ["messages"], additionalProperties: false },
          requestUnits: 1,
        });
      }
      if (name === "connection_status") {
        if (!exact(args, ["connection"]) || args.connection !== DEEPSEEK_CONNECTION) {
          throw new Error("invalid input");
        }
        return result({
          connection: DEEPSEEK_CONNECTION,
          status: "active",
          configured: true,
          healthy: health,
          operation: DEEPSEEK_OPERATION,
        });
      }
      if (
        name !== "invoke_operation" || !exact(args, ["operation", "connection", "arguments"]) ||
        args.operation !== DEEPSEEK_OPERATION || args.connection !== DEEPSEEK_CONNECTION
      ) throw new Error("invalid input");
      const output = await custodian.invoke(args.arguments);
      if (
        output.outcome === "success" && object(output.usage) &&
        typeof output.assistant_text === "string"
      ) {
        await receipt("allow", "policy_allow", 1, {
          input: Number(output.usage.input_tokens),
          output: Number(output.usage.output_tokens),
        });
        return result({
          ...output,
          receipt: { decision: "allow", reason: "policy_allow", requestUnits: 1 },
        });
      }
      await receipt("error", "custodian_denied", 0);
      return result({
        outcome: typeof output.outcome === "string" ? output.outcome : "provider_unavailable",
        receipt: { decision: "error", reason: "custodian_denied", requestUnits: 0 },
      });
    },
  });
}
