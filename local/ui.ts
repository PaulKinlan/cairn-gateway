export interface AdminPageState {
  origin: string;
  csrfToken: string;
  connectionStatus: string;
  grantStatus: string;
  result?: string;
}

const styles = `
:root {
  color-scheme: light dark;
  --bg: #f3efe5;
  --paper: #fffdf7;
  --ink: #17211c;
  --muted: #536159;
  --line: #aeb8b0;
  --action: #145d38;
  --action-ink: #fff;
  --soft: #dcecdf;
  --danger: #862d24;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 1rem;
  line-height: 1.55;
}
header, main, footer { width: min(68rem, calc(100% - 2rem)); margin-inline: auto; }
header { padding-block: clamp(2.5rem, 8vw, 5.5rem) 1.5rem; }
main { display: grid; gap: 1rem; padding-block-end: 3rem; }
section { border: 1px solid var(--line); border-radius: 0.8rem; background: var(--paper); padding: clamp(1.2rem, 3vw, 2rem); }
h1 { max-width: 17ch; margin: 0; font-size: clamp(2.2rem, 6vw, 4.6rem); line-height: 1; letter-spacing: -0.04em; }
h2 { margin-block: 0 0.8rem; font-size: 1.35rem; }
p { max-width: 70ch; }
.eyebrow { color: var(--action); font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
.lede { color: var(--muted); font-size: 1.15rem; }
code, pre, textarea, input { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
.command { display: block; width: fit-content; margin-block: 1.25rem; border-radius: 0.45rem; background: var(--ink); color: var(--paper); padding: 0.8rem 1rem; }
.endpoint { width: 100%; min-height: 3rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--bg); color: var(--ink); padding: 0.65rem; font-size: 1rem; }
pre { overflow-x: auto; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--bg); padding: 1rem; }
dt { color: var(--muted); }
dd { margin: 0 0 0.8rem; font-weight: 700; }
.status { display: inline-flex; gap: 0.45rem; align-items: center; }
.status::before { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: currentColor; content: ""; }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
form { margin: 0; }
button {
  min-height: 3rem;
  border: 2px solid var(--action);
  border-radius: 0.4rem;
  background: var(--action);
  color: var(--action-ink);
  padding: 0.65rem 1rem;
  font: inherit;
  font-weight: 750;
  cursor: pointer;
}
button.secondary { background: transparent; color: var(--action); }
button.danger { border-color: var(--danger); background: var(--danger); }
a { color: var(--action); text-underline-offset: 0.18em; }
:where(a, button, input):focus-visible { outline: 3px solid #e29622; outline-offset: 3px; }
.result { border-inline-start: 0.35rem solid var(--action); }
.result pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.copy-status { min-height: 1.5rem; color: var(--muted); }
footer { border-top: 1px solid var(--line); padding-block: 1.5rem 3rem; color: var(--muted); }
@media (min-width: 48rem) {
  main { grid-template-columns: 1fr 1fr; }
  .wide { grid-column: 1 / -1; }
  dl { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1rem; }
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101612;
    --paper: #19221c;
    --ink: #eef4ef;
    --muted: #b7c2ba;
    --line: #69776d;
    --action: #82d4a0;
    --action-ink: #102117;
    --soft: #203d2b;
    --danger: #d98479;
  }
}
`;

const adminScript = `
const button = document.querySelector("[data-copy]");
const status = document.querySelector("#copy-status");
button?.addEventListener("click", async () => {
  const config = document.querySelector("#client-config")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(config);
    status.textContent = "VS Code configuration copied.";
  } catch {
    status.textContent = "Copy was blocked. Select the configuration and copy it manually.";
  }
});
`;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function clientConfiguration(origin: string): string {
  return JSON.stringify(
    {
      servers: {
        "cairn-local": { type: "http", url: `${origin}/mcp` },
      },
    },
    null,
    2,
  );
}

export function renderAdminPage(state: AdminPageState): string {
  const endpoint = `${state.origin}/mcp`;
  const config = clientConfiguration(state.origin);
  const result = state.result === undefined
    ? ""
    : `<section class="wide result" aria-labelledby="test-result"><h2 id="test-result">Test result</h2><pre>${
      escapeHtml(state.result)
    }</pre></section>`;
  const hidden = `<input type="hidden" name="csrf_token" value="${escapeHtml(state.csrfToken)}">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>Connect Cairn locally</title>
  <style>${styles}</style>
  <script src="/admin.js" defer></script>
</head>
<body>
  <header>
    <p class="eyebrow">Local fixture</p>
    <h1>Run Cairn, then connect VS Code.</h1>
    <p class="lede">Start this page with:</p>
    <code class="command">deno task local:run</code>
    <p>Put the configuration below in <code>.vscode/mcp.json</code>. VS Code connects to the Streamable HTTP endpoint at <code>${
    escapeHtml(endpoint)
  }</code>.</p>
  </header>
  <main id="content">
    <section class="wide" aria-labelledby="connect-title">
      <h2 id="connect-title">Connect VS Code</h2>
      <label for="endpoint">MCP endpoint</label>
      <input class="endpoint" id="endpoint" value="${escapeHtml(endpoint)}" readonly>
      <pre id="client-config">${escapeHtml(config)}</pre>
      <button type="button" class="secondary" data-copy>Copy VS Code configuration</button>
      <p id="copy-status" class="copy-status" aria-live="polite"></p>
    </section>
    <section aria-labelledby="fixture-state">
      <h2 id="fixture-state">Fixture state</h2>
      <dl>
        <div><dt>Connection</dt><dd><span class="status">${
    escapeHtml(state.connectionStatus)
  }</span> · <code>connection_a</code></dd></div>
        <div><dt>Grant</dt><dd><span class="status">${
    escapeHtml(state.grantStatus)
  }</span> · <code>grant_a</code></dd></div>
      </dl>
      <p>These values live in memory and reset when the process stops.</p>
    </section>
    <section aria-labelledby="operation-title">
      <h2 id="operation-title">Available operation</h2>
      <p><code>github.user.read@v1</code></p>
      <p>It returns a fixed GitHub user fixture. No GitHub credential or provider request is used.</p>
    </section>
    <section class="wide" aria-labelledby="controls-title">
      <h2 id="controls-title">Try the fixture</h2>
      <div class="actions">
        <form action="/admin/test" method="post">${hidden}<button type="submit">Test operation</button></form>
        <form action="/admin/grant/revoke" method="post">${hidden}<button class="danger" type="submit">Revoke fixture grant</button></form>
        <form action="/admin/grant/reactivate" method="post">${hidden}<button class="secondary" type="submit">Reactivate fixture grant</button></form>
      </div>
    </section>
    ${result}
  </main>
  <footer><p>Setup details are in <code>docs/local-setup.md</code>.</p></footer>
</body>
</html>`;
}

export function adminClientScript(): string {
  return adminScript;
}
