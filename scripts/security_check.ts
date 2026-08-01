const roots = ["apps", "packages"];
const files: string[] = [];
async function walk(path: string): Promise<void> {
  for await (const entry of Deno.readDir(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory) await walk(child);
    else if (entry.isFile && child.endsWith(".ts")) files.push(child);
  }
}
for (const root of roots) await walk(root);
const forbiddenRuntime = [
  /export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(?:get_?secret|get_?token|credentials?|genericRequest)\b/i,
  /\bbaseUrlOverride\b/,
  /\bDeno\.openKv\b/,
  /\bDeno\.env\.get\b/,
  /\bnew\s+WebSocket\b/,
  /\bfetch\s*\(/,
  /https?:\/\/(?!api\.github\.com\/user\b)/,
];
for (const file of files) {
  const text = await Deno.readTextFile(file);
  for (const pattern of forbiddenRuntime) {
    if (pattern.test(text)) throw new Error(`forbidden runtime surface in ${file}: ${pattern}`);
  }
  if (/from\s+["'](?:https?:|npm:|jsr:)/.test(text)) {
    throw new Error(`unpinned remote import in ${file}`);
  }
}
for await (const entry of Deno.readDir(".")) {
  if (/^(?:\.env|secrets?)$/i.test(entry.name) || /\.(?:pem|key|p12|pfx|jwk)$/i.test(entry.name)) {
    throw new Error(`secret-like root file: ${entry.name}`);
  }
}
const command = new Deno.Command("git", { args: ["remote"], stdout: "piped" });
const result = await command.output();
if (new TextDecoder().decode(result.stdout).trim()) {
  throw new Error("repository remote is forbidden at Stage 0");
}
console.log(
  `security-check: ${files.length} runtime TypeScript files; no forbidden exports, network calls, env access, KV activation, remote imports, or Git remote`,
);
