import type { CustodyAdapter, CustodyBinding, SafeOutcome } from "../custody/custody_adapter.ts";
export const GITHUB_USER_READ = Object.freeze({
  id: "github.user.read@v1",
  operation: "github.user.read" as const,
  provider: "github" as const,
  destination: "https://api.github.com/user" as const,
  integration: "github-cairn-v1" as const,
  path: "/user" as const,
  method: "GET" as const,
  headers: Object.freeze({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cairn-gateway-stage0",
  }),
  maxResponseBytes: 65_536,
  argumentsSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});
export interface GithubUserProjection {
  id: number;
  login: string;
  name: string | null;
  html_url: string;
  avatar_url: string;
}
export type GithubResult = { outcome: "success"; user: GithubUserProjection } | {
  outcome: Exclude<SafeOutcome, "success">;
};
export async function invokeGithubUserRead(
  adapter: CustodyAdapter,
  binding: CustodyBinding,
  args: unknown,
): Promise<GithubResult> {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0) {
    throw new Error("arguments denied");
  }
  try {
    // The adapter is an untrusted boundary. Awaiting, property access, typed
    // array checks, decoding, projection, and URL parsing all stay inside one
    // catch-all so hostile getters and malformed resolved values cannot escape.
    const raw: unknown = await adapter.proxyOperation(binding, {
      operation: "github.user.read",
      integration: "github-cairn-v1",
      path: "/user",
      method: "GET",
    });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { outcome: "provider_unavailable" };
    }
    const response = raw as Record<string, unknown>;
    const outcome = response.outcome;
    if (
      outcome !== "success" && outcome !== "auth_required" && outcome !== "rate_limited" &&
      outcome !== "provider_denied" && outcome !== "provider_unavailable"
    ) return { outcome: "provider_unavailable" };
    if (outcome !== "success") return { outcome };
    const body = response.body;
    const contentType = response.contentType;
    const status = response.status;
    if (
      !(body instanceof Uint8Array) || typeof contentType !== "string" ||
      typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599 ||
      body.byteLength > GITHUB_USER_READ.maxResponseBytes ||
      contentType.split(";")[0]?.trim() !== "application/json"
    ) return { outcome: "provider_unavailable" };
    const input: unknown = JSON.parse(new TextDecoder().decode(body));
    if (
      !input || typeof input !== "object" || Array.isArray(input) ||
      !Number.isSafeInteger((input as Record<string, unknown>).id) ||
      typeof (input as Record<string, unknown>).login !== "string" ||
      ((input as Record<string, unknown>).login as string).length > 100 ||
      !((input as Record<string, unknown>).name === null ||
        typeof (input as Record<string, unknown>).name === "string") ||
      typeof (input as Record<string, unknown>).html_url !== "string" ||
      typeof (input as Record<string, unknown>).avatar_url !== "string"
    ) return { outcome: "provider_unavailable" };
    const projected = input as Record<string, unknown>;
    if (
      !safeGithubUrl(projected.html_url as string) ||
      !safeAvatarUrl(projected.avatar_url as string)
    ) return { outcome: "provider_unavailable" };
    return {
      outcome: "success",
      user: {
        id: projected.id as number,
        login: projected.login as string,
        name: projected.name as string | null,
        html_url: projected.html_url as string,
        avatar_url: stripQuery(projected.avatar_url as string),
      },
    };
  } catch {
    return { outcome: "provider_unavailable" };
  }
}
function safeGithubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username &&
      !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
function safeAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "avatars.githubusercontent.com" &&
      !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
function stripQuery(value: string): string {
  const url = new URL(value);
  url.search = "";
  return url.toString();
}
