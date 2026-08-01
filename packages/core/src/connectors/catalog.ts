import { GITHUB_USER_READ } from "./github_user.ts";
export function searchCatalog(
  query: string,
): readonly { id: string; risk: "low"; connected: boolean }[] {
  const normalized = query.toLowerCase();
  if (normalized && !"github user identity profile read".includes(normalized)) return [];
  return [{ id: GITHUB_USER_READ.id, risk: "low", connected: true }];
}
export function describeCatalog(id: string): Record<string, unknown> {
  if (id !== GITHUB_USER_READ.id) throw new Error("operation not found");
  return {
    id: GITHUB_USER_READ.id,
    inputSchema: GITHUB_USER_READ.argumentsSchema,
    outputFields: ["id", "login", "name", "html_url", "avatar_url"],
    risk: "low",
    provider: "github",
  };
}
