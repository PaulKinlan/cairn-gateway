export const EXPECTED_REMOTE = Object.freeze({
  names: ["origin"],
  urls: ["https://github.com/PaulKinlan/cairn-gateway.git"],
  fetch: ["+refs/heads/*:refs/remotes/origin/*"],
  pushUrls: [],
  effectiveFetchUrls: ["https://github.com/PaulKinlan/cairn-gateway.git"],
  effectivePushUrls: ["https://github.com/PaulKinlan/cairn-gateway.git"],
});

export interface GitRemotePolicySnapshot {
  names: string[];
  urls: string[];
  fetch: string[];
  pushUrls: string[];
  effectiveFetchUrls: string[];
  effectivePushUrls: string[];
}

export function assertExpectedGitRemote(snapshot: GitRemotePolicySnapshot): void {
  const same = (left: readonly string[], right: readonly string[]) =>
    JSON.stringify(left) === JSON.stringify(right);
  if (
    !same(snapshot.names, EXPECTED_REMOTE.names) ||
    !same(snapshot.urls, EXPECTED_REMOTE.urls) ||
    !same(snapshot.fetch, EXPECTED_REMOTE.fetch) ||
    !same(snapshot.pushUrls, EXPECTED_REMOTE.pushUrls) ||
    !same(snapshot.effectiveFetchUrls, EXPECTED_REMOTE.effectiveFetchUrls) ||
    !same(snapshot.effectivePushUrls, EXPECTED_REMOTE.effectivePushUrls)
  ) throw new Error("Git remote publication policy denied");
}

async function git(args: string[], allowMissing = false): Promise<string[]> {
  const result = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    if (allowMissing && result.code === 1) return [];
    throw new Error("Git remote inspection denied");
  }
  return new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
}

export async function inspectGitRemotePolicy(): Promise<GitRemotePolicySnapshot> {
  return {
    names: await git(["remote"]),
    urls: await git(["config", "--get-all", "remote.origin.url"]),
    fetch: await git(["config", "--get-all", "remote.origin.fetch"]),
    pushUrls: await git(["config", "--get-all", "remote.origin.pushurl"], true),
    effectiveFetchUrls: await git(["remote", "get-url", "--all", "origin"]),
    effectivePushUrls: await git(["remote", "get-url", "--push", "--all", "origin"]),
  };
}

if (import.meta.main) {
  assertExpectedGitRemote(await inspectGitRemotePolicy());
  console.log(
    "git-remote-policy: exact public origin URL/refspec; no additional remote or push URL",
  );
}
