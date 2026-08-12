import { BodyTooLargeError, readBoundedBody } from "./bounded_body.ts";

export const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL = "deepseek-v4-flash";
const MAX_FORM_BYTES = 12 * 1024;
const MAX_PROVIDER_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const encoder = new TextEncoder();

export interface SecretStore {
  put(secret: string): Promise<void>;
  get(): Promise<string | undefined>;
  delete(): Promise<void>;
}

export class SecretToolStore implements SecretStore {
  async put(secret: string): Promise<void> {
    const command = new Deno.Command("/usr/bin/secret-tool", {
      args: ["store", "--label=Cairn DeepSeek API key", "cairn", "deepseek", "owner", "local"],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const writer = command.stdin.getWriter();
    await writer.write(encoder.encode(secret));
    await writer.close();
    if (!(await command.status).success) throw new Error("secret storage unavailable");
  }
  async get(): Promise<string | undefined> {
    const output = await new Deno.Command("/usr/bin/secret-tool", {
      args: ["lookup", "cairn", "deepseek", "owner", "local"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return undefined;
    const secret = new TextDecoder().decode(output.stdout).trimEnd();
    return secret || undefined;
  }
  async delete(): Promise<void> {
    await new Deno.Command("/usr/bin/secret-tool", {
      args: ["clear", "cairn", "deepseek", "owner", "local"],
      stdout: "null",
      stderr: "null",
    }).output();
  }
}

export interface ProviderCall {
  (request: Request): Promise<Response>;
}
export interface CustodianOptions {
  dispatchCredential: string;
  gatewayOrigin: string;
  store: SecretStore;
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
}
interface Usage {
  day: string;
  requests: number;
  tokens: number;
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

export function createCustodianApp(options: CustodianOptions) {
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
  let active = 0;
  let usage: Usage = { day: "", requests: 0, tokens: 0 };
  let healthy: boolean | null = null;

  const authorized = (request: Request) =>
    request.headers.get("authorization") === `Bearer ${options.dispatchCredential}`;
  const configured = async () => {
    const found = await options.store.get();
    return found !== undefined;
  };
  const intakePage = (csrf: string, notice = "") =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Add DeepSeek key — Cairn custodian</title><style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:1rem}input,button{font:inherit;padding:.75rem;width:100%;margin:.5rem 0}p{line-height:1.5}.notice{border-left:4px solid #176b42;padding-left:1rem}</style></head><body><h1>Add DeepSeek key</h1>${
      notice ? `<p class="notice">${htmlEscape(notice)}</p>` : ""
    }<p>This masked field is served only by the separate loopback custodian. The key is stored by Secret Service and is never sent to the Cairn gateway or MCP.</p><form method="post" action="/intake"><input type="hidden" name="csrf_token" value="${csrf}"><label for="api-key">DeepSeek API key</label><input id="api-key" name="api_key" type="password" autocomplete="off" minlength="8" maxlength="8192" required><button type="submit">Store key and return to Cairn</button></form></body></html>`;

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        return safeJson({ error: "host_denied" }, 403);
      }
      if (url.search) return safeJson({ error: "not_found" }, 404);
      if (url.pathname === "/intake" && request.method === "GET") {
        const id = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
        const csrf = crypto.randomUUID().replaceAll("-", "");
        sessions.set(id, { csrf, expiresAt: now() + 10 * 60_000 });
        const headers = securityHeaders("text/html; charset=utf-8");
        headers.set("Set-Cookie", `cairn_custodian=${id}; HttpOnly; SameSite=Strict; Path=/intake`);
        return new Response(intakePage(csrf), { headers });
      }
      if (url.pathname === "/intake" && request.method === "POST") {
        if (
          request.headers.get("origin") !== url.origin ||
          request.headers.get("content-type")?.split(";", 1)[0] !==
            "application/x-www-form-urlencoded"
        ) return safeJson({ error: "intake_denied" }, 403);
        const session = sessions.get(cookie(request) ?? "");
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
        const values = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(body));
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
        await options.store.put(secret);
        sessions.delete(cookie(request) ?? "");
        healthy = null;
        return new Response(null, {
          status: 303,
          headers: {
            "Location": `${options.gatewayOrigin}/?connected=1`,
            "Cache-Control": "no-store",
            "Clear-Site-Data": '"cache"',
          },
        });
      }
      if (!url.pathname.startsWith("/internal/") || !authorized(request)) {
        return safeJson({ error: "not_found" }, 404);
      }
      if (url.pathname === "/internal/status" && request.method === "GET") {
        return safeJson({ configured: await configured(), healthy });
      }
      if (url.pathname === "/internal/delete" && request.method === "POST") {
        await options.store.delete();
        healthy = null;
        return safeJson({ deleted: true });
      }
      if (url.pathname !== "/internal/invoke" || request.method !== "POST") {
        return safeJson({ error: "not_found" }, 404);
      }
      if (active >= concurrency) return safeJson({ outcome: "provider_unavailable" }, 429);
      let input: unknown;
      try {
        input = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readBoundedBody(request, 48 * 1024),
          ),
        );
      } catch {
        return safeJson({ outcome: "invalid_input" }, 400);
      }
      if (!validateChatInput(input)) return safeJson({ outcome: "invalid_input" }, 400);
      const day = new Date(now()).toISOString().slice(0, 10);
      if (usage.day !== day) usage = { day, requests: 0, tokens: 0 };
      const maxTokens = input.max_output_tokens ?? 256;
      if (usage.requests >= requestLimit || usage.tokens + maxTokens > tokenLimit) {
        return safeJson({ outcome: "rate_limited" }, 429);
      }
      const secret = await options.store.get();
      if (!secret) return safeJson({ outcome: "auth_required" }, 401);
      active++;
      usage.requests++;
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
        if (!provider.ok) {
          healthy = false;
          return safeJson({
            outcome: provider.status === 401 || provider.status === 403
              ? "auth_required"
              : provider.status === 429
              ? "rate_limited"
              : "provider_unavailable",
          });
        }
        const reader = provider.body?.getReader();
        if (!reader) throw new Error("provider body unavailable");
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_PROVIDER_BYTES) {
            await reader.cancel();
            throw new Error("provider response too large");
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const text = raw?.choices?.[0]?.message?.content;
        const finish = raw?.choices?.[0]?.finish_reason;
        const promptTokens = raw?.usage?.prompt_tokens;
        const completionTokens = raw?.usage?.completion_tokens;
        const totalTokens = raw?.usage?.total_tokens;
        if (
          typeof text !== "string" || encoder.encode(text).byteLength > MAX_OUTPUT_BYTES ||
          !["stop", "length"].includes(finish) ||
          ![promptTokens, completionTokens, totalTokens].every((n) =>
            Number.isInteger(n) && n >= 0
          ) || promptTokens + completionTokens !== totalTokens
        ) {
          healthy = false;
          return safeJson({ outcome: "provider_unavailable" });
        }
        usage.tokens += totalTokens;
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
        healthy = false;
        return safeJson({ outcome: "provider_unavailable" });
      } finally {
        clearTimeout(timer);
        active--;
      }
    },
  });
}
