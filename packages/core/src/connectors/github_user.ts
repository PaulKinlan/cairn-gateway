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
  let response;
  try {
    response = await adapter.proxyOperation(binding, {
      operation: "github.user.read",
      integration: "github-cairn-v1",
      path: "/user",
      method: "GET",
    });
  } catch {
    return { outcome: "provider_unavailable" };
  }
  if (response.outcome !== "success") return { outcome: response.outcome };
  if (
    response.body.byteLength > GITHUB_USER_READ.maxResponseBytes ||
    response.contentType.split(";")[0]?.trim() !== "application/json"
  ) return { outcome: "provider_unavailable" };
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return { outcome: "provider_unavailable" };
  }
  if (
    !input || typeof input !== "object" || Array.isArray(input) ||
    !Number.isSafeInteger(input.id) || typeof input.login !== "string" ||
    input.login.length > 100 || !(input.name === null || typeof input.name === "string") ||
    typeof input.html_url !== "string" || typeof input.avatar_url !== "string" ||
    !safeGithubUrl(input.html_url) || !safeAvatarUrl(input.avatar_url)
  ) return { outcome: "provider_unavailable" };
  return {
    outcome: "success",
    user: {
      id: input.id as number,
      login: input.login,
      name: input.name as string | null,
      html_url: input.html_url,
      avatar_url: stripQuery(input.avatar_url),
    },
  };
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
