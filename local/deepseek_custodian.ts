import { BodyTooLargeError, readBoundedBody } from "./bounded_body.ts";
import { atomicWriteJson, readJsonFile } from "./atomic_json.ts";

export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL = "deepseek-v4-flash";
const MAX_FORM_BYTES = 12 * 1024;
const MAX_PROVIDER_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_USAGE_BYTES = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SecretStore {
  put(secret: string): Promise<void>;
  get(): Promise<string | undefined>;
  delete(): Promise<void>;
}
export interface CommandResult {
  success: boolean;
  stdout: Uint8Array;
}
export interface SecretCommandRunner {
  run(args: string[], stdin?: Uint8Array): Promise<CommandResult>;
}
class DenoSecretCommandRunner implements SecretCommandRunner {
  constructor(private readonly path = "/usr/bin/secret-tool") {}
  async run(args: string[], stdin?: Uint8Array): Promise<CommandResult> {
    const child = new Deno.Command(this.path, {
      args,
      stdin: stdin ? "piped" : "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    if (stdin) {
      const writer = child.stdin.getWriter();
      await writer.write(stdin);
      await writer.close();
    }
    const output = await child.output();
    return { success: output.success, stdout: output.stdout };
  }
}
export class SecretToolStore implements SecretStore {
  private readonly runner: SecretCommandRunner;
  constructor(runner?: SecretCommandRunner, path = "/usr/bin/secret-tool") {
    this.runner = runner ?? new DenoSecretCommandRunner(path);
  }
  async put(secret: string): Promise<void> {
    const result = await this.runner.run(
      ["store", "--label=Cairn DeepSeek API key", "cairn", "deepseek", "owner", "local"],
      encoder.encode(secret),
    );
    if (!result.success) throw new Error("secret storage unavailable");
  }
  async get(): Promise<string | undefined> {
    const output = await this.runner.run(["lookup", "cairn", "deepseek", "owner", "local"]);
    if (!output.success) return undefined;
    const secret = new TextDecoder().decode(output.stdout).trimEnd();
    return secret || undefined;
  }
  async delete(): Promise<void> {
    const cleared = await this.runner.run(["clear", "cairn", "deepseek", "owner", "local"]);
    if (!cleared.success) throw new Error("secret deletion unavailable");
    if (await this.get() !== undefined) throw new Error("secret deletion not confirmed");
  }
}

interface Usage {
  version: 1;
  day: string;
  requests: number;
  reservedTokens: number;
}
export interface UsageStore {
  load(): Promise<Usage | undefined>;
  save(value: Usage): Promise<void>;
}
function validUsage(value: unknown): value is Usage {
  return exactObject(value, ["version", "day", "requests", "reservedTokens"]) &&
    value.version === 1 && typeof value.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.day) &&
    Number.isSafeInteger(value.requests) && (value.requests as number) >= 0 &&
    (value.requests as number) <= 100_000 && Number.isSafeInteger(value.reservedTokens) &&
    (value.reservedTokens as number) >= 0 && (value.reservedTokens as number) <= 100_000_000;
}
export class FileUsageStore implements UsageStore {
  constructor(readonly path: string) {}
  async load(): Promise<Usage | undefined> {
    const value = await readJsonFile(this.path, MAX_USAGE_BYTES);
    if (value === undefined) return undefined;
    if (!validUsage(value)) throw new Error("usage metadata invalid");
    return value;
  }
  save(value: Usage) {
    return atomicWriteJson(this.path, value);
  }
}
export class MemoryUsageStore implements UsageStore {
  value?: Usage;
  load() {
    return Promise.resolve(this.value ? structuredClone(this.value) : undefined);
  }
  save(value: Usage) {
    this.value = structuredClone(value);
    return Promise.resolve();
  }
}

export interface ProviderCall {
  (request: Request): Promise<Response>;
}
export interface CustodianOptions {
  dispatchCredential: string;
  gatewayOrigin: string;
  store: SecretStore;
  usageStore?: UsageStore;
  providerFetch?: ProviderCall;
  now?: () => number;
  requestLimitPerDay?: number;
  tokenLimitPerDay?: number;
  timeoutMs?: number;
  concurrency?: number;
}
interface Session {
  csrf: string;
  expiresAt: number;
  createdAt: number;
}
type ChatInput = {
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_output_tokens?: number;
};

function htmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function cookie(request: Request): string | undefined {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)cairn_custodian=([a-f0-9]{32})/)?.[1];
}
function exactObject(
  value: unknown,
  keys: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    keys.every((key) => key in value) &&
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
}
export function validateChatInput(value: unknown): value is ChatInput {
  if (!exactObject(value, ["messages"], ["max_output_tokens"]) || !Array.isArray(value.messages)) {
    return false;
  }
  if (value.messages.length < 1 || value.messages.length > 8) return false;
  let total = 0;
  for (const message of value.messages) {
    if (
      !exactObject(message, ["role", "content"]) ||
      (message.role !== "system" && message.role !== "user") || typeof message.content !== "string"
    ) return false;
    const bytes = encoder.encode(message.content).byteLength;
    if (bytes > 8192) return false;
    total += bytes;
  }
  if (total > 32768) return false;
  return value.max_output_tokens === undefined ||
    (Number.isInteger(value.max_output_tokens) && (value.max_output_tokens as number) >= 1 &&
      (value.max_output_tokens as number) <= 1024);
}
function inputReservation(input: ChatInput): number {
  return input.messages.reduce(
    (sum, message) => sum + encoder.encode(message.content).byteLength,
    0,
  ) +
    (input.max_output_tokens ?? 256);
}
function securityHeaders(contentType: string): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": contentType,
    "Content-Security-Policy":
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}
function safeJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: securityHeaders("application/json; charset=utf-8"),
  });
}

export async function createCustodianApp(options: CustodianOptions) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.dispatchCredential)) {
    throw new Error("dispatch credential denied");
  }
  const sessions = new Map<string, Session>();
  const providerFetch = options.providerFetch ?? fetch;
  const now = options.now ?? Date.now;
  const requestLimit = options.requestLimitPerDay ?? 100;
  const tokenLimit = options.tokenLimitPerDay ?? 50_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const concurrency = options.concurrency ?? 1;
  const usageStore = options.usageStore ?? new MemoryUsageStore();
  let active = 0;
  let generation = 0;
  let reservationQueue = Promise.resolve();
  let usage: Usage;
  try {
    usage = await usageStore.load() ??
      {
        version: 1,
        day: new Date(now()).toISOString().slice(0, 10),
        requests: 0,
        reservedTokens: 0,
      };
  } catch {
    throw new Error("usage metadata unavailable");
  }
  let healthy: boolean | null = null;
  const reserve = async (reservation: number): Promise<"reserved" | "limited" | "busy"> => {
    let decision: "reserved" | "limited" | "busy" = "busy";
    const operation = reservationQueue.then(async () => {
      if (active >= concurrency) return;
      const day = new Date(now()).toISOString().slice(0, 10);
      const current = usage.day === day
        ? usage
        : { version: 1 as const, day, requests: 0, reservedTokens: 0 };
      if (
        current.requests + 1 > requestLimit ||
        current.reservedTokens + reservation > tokenLimit
      ) {
        decision = "limited";
        return;
      }
      const nextUsage = {
        ...current,
        requests: current.requests + 1,
        reservedTokens: current.reservedTokens + reservation,
      };
      await usageStore.save(nextUsage);
      usage = nextUsage;
      active++;
      decision = "reserved";
    });
    reservationQueue = operation.catch(() => {});
    await operation;
    return decision;
  };

  const authorized = (request: Request) =>
    request.headers.get("authorization") === `Bearer ${options.dispatchCredential}`;
  const configured = async () => await options.store.get() !== undefined;
  const purgeSessions = () => {
    const time = now();
    for (const [id, session] of sessions) if (session.expiresAt <= time) sessions.delete(id);
    while (sessions.size >= 16) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
    }
  };
  const intakePage = (csrf: string, notice = "") =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Add DeepSeek key — Cairn custodian</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem}input,button{font:inherit;padding:.75rem;width:100%;margin:.5rem 0}p{line-height:1.5}.notice{border-left:4px solid #176b42;padding-left:1rem}</style></head><body><h1>Add or replace DeepSeek key</h1>${
      notice ? `<p class="notice">${htmlEscape(notice)}</p>` : ""
    }<p>This masked field is served only by the separate loopback custodian. The key is stored by Secret Service and is never sent to the Cairn gateway or MCP.</p><form method="post" action="/intake"><input type="hidden" name="csrf_token" value="${csrf}"><label for="api-key">DeepSeek API key</label><input id="api-key" name="api_key" type="password" autocomplete="off" minlength="8" maxlength="8192" required><button type="submit">Store key and return to Cairn</button></form></body></html>`;

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        return safeJson({ error: "host_denied" }, 403);
      }
      if (url.search) return safeJson({ error: "not_found" }, 404);
      purgeSessions();
      if (url.pathname === "/intake" && request.method === "GET") {
        const id = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
        const csrf = crypto.randomUUID().replaceAll("-", "");
        const createdAt = now();
        sessions.set(id, { csrf, createdAt, expiresAt: createdAt + 10 * 60_000 });
        const headers = securityHeaders("text/html; charset=utf-8");
        headers.set(
          "Set-Cookie",
          `cairn_custodian=${id}; HttpOnly; SameSite=Strict; Path=/intake; Max-Age=600`,
        );
        return new Response(intakePage(csrf), { headers });
      }
      if (url.pathname === "/intake" && request.method === "POST") {
        if (
          request.headers.get("origin") !== url.origin ||
          request.headers.get("content-type")?.split(";", 1)[0] !==
            "application/x-www-form-urlencoded"
        ) return safeJson({ error: "intake_denied" }, 403);
        const sessionId = cookie(request) ?? "";
        const session = sessions.get(sessionId);
        if (!session || session.expiresAt <= now()) {
          return safeJson({ error: "session_denied" }, 403);
        }
        let body: Uint8Array;
        try {
          body = await readBoundedBody(request, MAX_FORM_BYTES);
        } catch (error) {
          return safeJson(
            { error: error instanceof BodyTooLargeError ? "too_large" : "invalid" },
            400,
          );
        }
        let values: URLSearchParams;
        try {
          values = new URLSearchParams(decoder.decode(body));
        } catch {
          return safeJson({ error: "invalid" }, 400);
        }
        if (
          [...values.keys()].sort().join(",") !== "api_key,csrf_token" ||
          values.getAll("api_key").length !== 1 || values.getAll("csrf_token").length !== 1 ||
          values.get("csrf_token") !== session.csrf
        ) return safeJson({ error: "csrf_denied" }, 403);
        const secret = values.get("api_key") ?? "";
        if (
          secret.length < 8 || encoder.encode(secret).byteLength > 8192 || /[\r\n\0]/.test(secret)
        ) {
          return new Response(intakePage(session.csrf, "The key format was rejected."), {
            status: 400,
            headers: securityHeaders("text/html; charset=utf-8"),
          });
        }
        try {
          await options.store.put(secret);
        } catch {
          return new Response(
            intakePage(
              session.csrf,
              "Secret Service is locked or unavailable. Unlock it and retry.",
            ),
            { status: 503, headers: securityHeaders("text/html; charset=utf-8") },
          );
        }
        sessions.delete(sessionId);
        generation++;
        healthy = null;
        return new Response(null, {
          status: 303,
          headers: {
            "Location": `${options.gatewayOrigin}/?connected=1`,
            "Cache-Control": "no-store",
            "Clear-Site-Data": '"cache"',
            "Set-Cookie": "cairn_custodian=; HttpOnly; SameSite=Strict; Path=/intake; Max-Age=0",
          },
        });
      }
      if (!url.pathname.startsWith("/internal/") || !authorized(request)) {
        return safeJson({ error: "not_found" }, 404);
      }
      if (url.pathname === "/internal/status" && request.method === "GET") {
        try {
          return safeJson({ configured: await configured(), healthy });
        } catch {
          return safeJson({ error: "custody_unavailable" }, 503);
        }
      }
      if (url.pathname === "/internal/delete" && request.method === "POST") {
        await options.store.delete();
        generation++;
        healthy = null;
        return safeJson({ deleted: true });
      }
      if (url.pathname !== "/internal/invoke" || request.method !== "POST") {
        return safeJson({ error: "not_found" }, 404);
      }
      let input: unknown;
      try {
        input = JSON.parse(decoder.decode(await readBoundedBody(request, 48 * 1024)));
      } catch {
        return safeJson({ outcome: "invalid_input" }, 400);
      }
      if (!validateChatInput(input)) return safeJson({ outcome: "invalid_input" }, 400);
      const reservation = inputReservation(input);
      let reservationDecision: "reserved" | "limited" | "busy";
      try {
        reservationDecision = await reserve(reservation);
      } catch {
        return safeJson({ outcome: "provider_unavailable" }, 503);
      }
      if (reservationDecision === "limited") return safeJson({ outcome: "rate_limited" }, 429);
      if (reservationDecision === "busy") {
        return safeJson({ outcome: "provider_unavailable" }, 429);
      }
      let secret: string | undefined;
      try {
        secret = await options.store.get();
      } catch {
        active--;
        return safeJson({ outcome: "provider_unavailable" }, 503);
      }
      if (!secret) {
        active--;
        return safeJson({ outcome: "auth_required" }, 401);
      }
      const dispatchGeneration = generation;
      const maxTokens = input.max_output_tokens ?? 256;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const provider = await providerFetch(
          new Request(DEEPSEEK_ENDPOINT, {
            method: "POST",
            headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: DEEPSEEK_MODEL,
              messages: input.messages,
              max_tokens: maxTokens,
              stream: false,
              thinking: { type: "disabled" },
            }),
            signal: abort.signal,
          }),
        );
        if (provider.status < 200 || provider.status > 299) {
          if (dispatchGeneration !== generation) {
            return safeJson({ outcome: "authority_changed" }, 409);
          }
          healthy = false;
          return safeJson({
            outcome: provider.status === 401 || provider.status === 403
              ? "auth_required"
              : provider.status === 429
              ? "rate_limited"
              : "provider_unavailable",
          });
        }
        const bytes = await readBoundedBody(
          new Request("http://provider.invalid", { method: "POST", body: provider.body }),
          MAX_PROVIDER_BYTES,
        );
        const raw = JSON.parse(decoder.decode(bytes));
        if (
          !exactObject(raw, ["choices", "usage"]) || !Array.isArray(raw.choices) ||
          raw.choices.length !== 1 || !exactObject(raw.choices[0], ["message", "finish_reason"]) ||
          !exactObject(raw.choices[0].message, ["content"]) ||
          !exactObject(raw.usage, ["prompt_tokens", "completion_tokens", "total_tokens"])
        ) throw new Error("provider response invalid");
        const text = raw.choices[0].message.content;
        const finish = raw.choices[0].finish_reason;
        const promptTokens = raw.usage.prompt_tokens;
        const completionTokens = raw.usage.completion_tokens;
        const totalTokens = raw.usage.total_tokens;
        if (
          typeof text !== "string" || encoder.encode(text).byteLength > MAX_OUTPUT_BYTES ||
          !["stop", "length"].includes(finish as string) ||
          ![promptTokens, completionTokens, totalTokens].every((n) =>
            Number.isSafeInteger(n) && (n as number) >= 0
          ) || (promptTokens as number) + (completionTokens as number) !== totalTokens ||
          (completionTokens as number) > maxTokens || (totalTokens as number) > reservation
        ) throw new Error("provider response invalid");
        if (dispatchGeneration !== generation || !await configured()) {
          return safeJson({ outcome: "authority_changed" }, 409);
        }
        healthy = true;
        return safeJson({
          outcome: "success",
          assistant_text: text,
          finish_category: finish === "stop" ? "complete" : "length",
          usage: {
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            total_tokens: totalTokens,
          },
        });
      } catch {
        if (dispatchGeneration !== generation) {
          return safeJson({ outcome: "authority_changed" }, 409);
        }
        healthy = false;
        return safeJson({ outcome: "provider_unavailable" });
      } finally {
        clearTimeout(timer);
        active--;
      }
    },
  });
}
