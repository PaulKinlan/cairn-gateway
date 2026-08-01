import { assert, equals } from "../assert.ts";
import { TOOL_NAMES } from "../../apps/gateway/mcp.ts";
async function runtimeFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(path: string) {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) await walk(child);
      else if (entry.isFile && child.endsWith(".ts")) out.push(child);
    }
  }
  await walk("apps");
  await walk("packages");
  return out;
}
Deno.test("runtime exports contain no credential or generic transport surface", async () => {
  for (const file of await runtimeFiles()) {
    const source = await Deno.readTextFile(file);
    assert(
      !/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(?:get_?secret|get_?token|credentials?|genericRequest)\b/i
        .test(source),
      file,
    );
    assert(!/\bbaseUrlOverride\b/.test(source), file);
  }
});
Deno.test("runtime has no network, environment, live KV, or remote dependency activation", async () => {
  for (const file of await runtimeFiles()) {
    const source = await Deno.readTextFile(file);
    assert(!/\bfetch\s*\(|\bnew\s+WebSocket|\bDeno\.env\.get|\bDeno\.openKv/.test(source), file);
    assert(!/from\s+["'](?:https?:|npm:|jsr:)/.test(source), file);
  }
});
Deno.test("public core excludes raw store and fixture mutation surfaces", async () => {
  const source = await Deno.readTextFile("packages/core/mod.ts");
  assert(!source.includes("store/store.ts"));
  assert(!source.includes("store/memory_store.ts"));
  assert(!source.includes("custody/memory_fixture.ts"));
});
Deno.test("MCP surface remains exact and fixture-only", () => {
  equals([...TOOL_NAMES], [
    "search_capabilities",
    "describe_operation",
    "invoke_operation",
    "connection_status",
  ]);
});
Deno.test("repository has no Git remote", async () => {
  const output = await new Deno.Command("git", { args: ["remote"], stdout: "piped" }).output();
  assert(!new TextDecoder().decode(output.stdout).trim());
});
Deno.test("secret-like local files are ignored", async () => {
  const ignore = await Deno.readTextFile(".gitignore");
  for (
    const pattern of [
      ".env",
      "*.pem",
      "*.key",
      "*.jwk",
      "secrets/",
      "local-state/",
      "deploy-state/",
    ]
  ) assert(ignore.includes(pattern), pattern);
});
