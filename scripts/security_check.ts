const runtimeRoots = ["apps", "packages"], runtimeFiles: string[] = [];
async function walk(path: string): Promise<void> {
  for await (const entry of Deno.readDir(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory) await walk(child);
    else if (entry.isFile && child.endsWith(".ts")) runtimeFiles.push(child);
  }
}
for (const root of runtimeRoots) await walk(root);
const forbiddenRuntime = [
  /export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(?:get_?secret|get_?token|credentials?|genericRequest)\b/i,
  /\bbaseUrlOverride\b/,
  /\bDeno\.openKv\b/,
  /\bDeno\.env\.get\b/,
  /\bDeno\.(?:listen|listenTls|serve|serveHttp)\b/,
  /\bBun\.serve\b/,
  /\b(?:serve|serveTls|listen|listenTls|createServer|createSecureServer)\s*\(/,
  /\bnew\s+(?:Server|WebSocket|WebSocketServer)\b/,
  /\bfetch\s*\(/,
  /https?:\/\/(?!api\.github\.com\/user\b|fixture\.cairn\.invalid\/oauth\/github\/callback\b)/,
];
for (const file of runtimeFiles) {
  const text = await Deno.readTextFile(file);
  for (const pattern of forbiddenRuntime) {
    if (pattern.test(text)) throw new Error(`forbidden runtime surface in ${file}`);
  }
  if (/from\s+["'](?:https?:|npm:|jsr:)/.test(text)) {
    throw new Error(`unpinned remote import in ${file}`);
  }
}
const git = async (args: string[]) => {
  const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error("git inspection failed");
  return new TextDecoder().decode(out.stdout);
};
const tracked = (await git(["ls-files", "-z"])).split("\0").filter(Boolean);
const secretName = /(?:^|\/)(?:\.env(?:\..*)?|secrets?)(?:$|\/)|\.(?:pem|key|p12|pfx|jwk)$/i;
for (const file of tracked) {
  if (secretName.test(file)) throw new Error(`secret-like tracked path: ${file}`);
}
const contentPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /(?:^|\n)\s*(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|REFRESH_TOKEN|PASSWORD)\s*=\s*(?!fixture|example|sentinel|\$\{)[^\s#]{12,}/i,
];
for (const file of tracked) {
  if (file === "packages/core/src/crypto/fixture_keys.ts") continue;
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    continue;
  }
  for (const pattern of contentPatterns) {
    if (pattern.test(text)) throw new Error(`credential-shaped tracked content: ${file}`);
  }
}
if ((await git(["remote"])).trim()) throw new Error("repository remote is forbidden at Stage 0");
console.log(
  `security-check: ${runtimeFiles.length} runtime TypeScript files and ${tracked.length} tracked paths recursively checked; no forbidden network/listener, credential-shaped, remote-import, or Git-remote surface`,
);
