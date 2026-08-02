import type { LocalFixtureView } from "./fixture_controller.ts";

export interface AdminPageState {
  origin: string;
  csrfToken: string;
  fixture: LocalFixtureView;
  notice?: string;
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
  --warning: #7a4b00;
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
header, main, footer { width: min(72rem, calc(100% - 2rem)); margin-inline: auto; }
header { padding-block: clamp(2.5rem, 8vw, 5.5rem) 1.5rem; }
main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; padding-block-end: 3rem; }
section { min-width: 0; border: 1px solid var(--line); border-radius: 0.8rem; background: var(--paper); padding: clamp(1.2rem, 3vw, 2rem); }
h1 { max-width: 18ch; margin: 0; font-size: clamp(2.2rem, 6vw, 4.6rem); line-height: 1; letter-spacing: -0.04em; }
h2 { margin-block: 0 0.8rem; font-size: 1.35rem; }
h3 { margin-block: 0 0.35rem; font-size: 1.05rem; }
p { max-width: 70ch; }
.eyebrow { color: var(--action); font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
.lede { color: var(--muted); font-size: 1.15rem; }
code, pre, input { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
li code { overflow-wrap: anywhere; }
.command { display: block; width: fit-content; margin-block: 1.25rem; border-radius: 0.45rem; background: var(--ink); color: var(--paper); padding: 0.8rem 1rem; }
.endpoint, .text-input { width: 100%; min-height: 3rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--bg); color: var(--ink); padding: 0.65rem; font-size: 1rem; }
pre { overflow-x: auto; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--bg); padding: 1rem; }
label { display: block; margin-block-end: 0.35rem; font-weight: 700; }
.field { max-width: 28rem; margin-block-end: 1rem; }
.status { display: inline-flex; gap: 0.45rem; align-items: center; font-weight: 750; }
.status::before { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: currentColor; content: ""; }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; }
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
button.quiet-danger { border-color: var(--danger); background: transparent; color: var(--danger); }
a { color: var(--action); text-underline-offset: 0.18em; }
:where(a, button, input):focus-visible { outline: 3px solid #e29622; outline-offset: 3px; }
.notice { border-inline-start: 0.35rem solid var(--action); }
.result { border-inline-start: 0.35rem solid var(--action); }
.result pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.copy-status, .muted { color: var(--muted); }
.copy-status { min-height: 1.5rem; }
.steps, .graph { display: grid; gap: 0.75rem; padding: 0; list-style: none; }
.step, .node { border: 1px solid var(--line); border-radius: 0.55rem; padding: 1rem; }
.step[aria-current="step"] { border-width: 2px; border-color: var(--action); }
.step.complete { background: var(--soft); }
.step p, .node p { margin-block: 0.25rem 0; }
.policy { display: grid; gap: 0.5rem; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); }
.policy div { border-inline-start: 2px solid var(--line); padding-inline-start: 0.75rem; }
.policy dt { color: var(--muted); }
.policy dd { margin: 0; font-weight: 750; overflow-wrap: anywhere; }
.table-wrap { width: 100%; max-width: 100%; min-width: 0; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.94rem; }
th, td { border-block-end: 1px solid var(--line); padding: 0.7rem 0.6rem; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 700; }
footer { border-top: 1px solid var(--line); padding-block: 1.5rem 3rem; color: var(--muted); }
@media (min-width: 48rem) {
  main { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wide { grid-column: 1 / -1; }
  .graph { grid-template-columns: repeat(4, 1fr); }
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
    --warning: #efbd71;
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
    status.textContent = "VS Code candidate configuration copied.";
  } catch {
    status.textContent = "Copy was blocked. Select the configuration and copy it manually.";
  }
});
`;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function isoTime(seconds: number): string {
  try {
    return new Date(seconds * 1_000).toISOString().replace(".000Z", "Z");
  } catch {
    return "Invalid time";
  }
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

function hidden(token: string): string {
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(token)}">`;
}

function onboarding(state: AdminPageState): string {
  const fixture = state.fixture;
  const csrf = hidden(state.csrfToken);
  if (fixture.owner === "missing") {
    return `<div class="step" aria-current="step"><h3>1. Create the fixture owner</h3><p>This starts an empty in-memory owner context and its fixed GitHub connection.</p><form action="/admin/owner/create" method="post">${csrf}<button type="submit">Create fixture owner</button></form></div>`;
  }
  if (!fixture.agent) {
    return `<div class="step complete"><h3>1. Owner ready</h3></div><div class="step" aria-current="step"><h3>2. Label the fixture agent</h3><p>This display label maps to Cairn’s fixed, non-exported cryptographic test authority.</p><form action="/admin/agent/create" method="post">${csrf}<div class="field"><label for="agent-name">Agent label</label><input class="text-input" id="agent-name" name="agent_name" autocomplete="off" maxlength="40" required value="Research agent"></div><button type="submit">Save agent label</button></form></div>`;
  }
  if (!fixture.identity) {
    return `<div class="step complete"><h3>1–2. Owner and agent label ready</h3><p>${
      escapeHtml(fixture.agent.label)
    }</p></div><div class="step" aria-current="step"><h3>3. Label the fixture device and workload</h3><p>Use distinct display labels. They map to the closed test authority and are not cryptographic enrollment.</p><form action="/admin/identity/enroll" method="post">${csrf}<div class="field"><label for="device-name">Device label</label><input class="text-input" id="device-name" name="device_name" autocomplete="off" maxlength="40" required value="Local laptop"></div><div class="field"><label for="workload-name">Workload label</label><input class="text-input" id="workload-name" name="workload_name" autocomplete="off" maxlength="40" required value="Local MCP worker"></div><button type="submit">Save identity labels</button></form></div>`;
  }
  if (!fixture.grant) {
    return `<div class="step complete"><h3>1–3. Fixture labels ready</h3><p>${
      escapeHtml(fixture.agent.label)
    } · ${escapeHtml(fixture.identity.deviceLabel)} · ${
      escapeHtml(fixture.identity.workloadLabel)
    }</p></div><div class="step" aria-current="step"><h3>4. Create the grant</h3><p>The fixture policy is fixed: <code>github.user.read@v1</code>, 24-hour expiry, and 5 calls.</p><form action="/admin/grant/create" method="post">${csrf}<button type="submit">Create grant</button></form></div>`;
  }
  return `<div class="step complete"><h3>Onboarding complete</h3><p>The authority graph is ready. Invoke locally or connect over MCP.</p></div>`;
}

function authorityGraph(state: LocalFixtureView): string {
  const owner =
    `<li class="node"><h3>Owner</h3><p><span class="status">${state.owner}</span></p><p class="muted">Local fixture context</p></li>`;
  const agent = `<li class="node"><h3>Agent label</h3><p>${
    state.agent ? escapeHtml(state.agent.label) : "Not set"
  }</p><p class="muted">${state.agent?.status ?? "missing"}</p></li>`;
  const identity = `<li class="node"><h3>Device + workload labels</h3><p>${
    state.identity
      ? `${escapeHtml(state.identity.deviceLabel)}<br>${escapeHtml(state.identity.workloadLabel)}`
      : "Not set"
  }</p><p class="muted">${state.identity?.status ?? "missing"}</p></li>`;
  const grant =
    `<li class="node"><h3>Grant</h3><p><code>github.user.read@v1</code></p><p class="muted">${
      state.grant?.status ?? "missing"
    }</p></li>`;
  return `<ul class="graph">${owner}${agent}${identity}${grant}</ul>`;
}

function grantPanel(state: AdminPageState): string {
  const grant = state.fixture.grant;
  if (!grant) return `<p>Create the grant after saving the fixture identity labels.</p>`;
  const csrf = hidden(state.csrfToken);
  const active = grant.status === "active";
  const controls = active
    ? `<form action="/admin/invoke" method="post">${csrf}<button type="submit">Invoke fixture operation</button></form><form action="/admin/grant/revoke" method="post">${csrf}<button class="danger" type="submit">Revoke grant</button></form>`
    : `<form action="/admin/invoke" method="post">${csrf}<button type="submit">Test denied call</button></form><form action="/admin/grant/reactivate" method="post">${csrf}<button class="secondary" type="submit">Create replacement grant</button></form>`;
  return `<p><span class="status">${
    escapeHtml(grant.status)
  }</span></p><dl class="policy"><div><dt>Operation</dt><dd><code>${grant.operation}</code></dd></div><div><dt>Version</dt><dd>${grant.version}</dd></div><div><dt>Expires</dt><dd><time datetime="${
    isoTime(grant.expiresAt)
  }">${
    isoTime(grant.expiresAt)
  }</time></dd></div><div><dt>Usage</dt><dd>${grant.used} of ${grant.usageLimit}</dd></div></dl><div class="actions">${controls}</div><p class="muted">Test a denied call before replacement. Replacement creates a new version, expiry, and usage window.</p>`;
}

function receiptRows(state: LocalFixtureView): string {
  if (state.receipts.length === 0) {
    return `<tr><td colspan="7">No invocation receipts yet.</td></tr>`;
  }
  return state.receipts.map((receipt) =>
    `<tr><td><time datetime="${isoTime(receipt.at)}">${isoTime(receipt.at)}</time></td><td>${
      escapeHtml(receipt.source === "mcp" ? "MCP" : "Local admin")
    }</td><td>${escapeHtml(receipt.decision)}</td><td>${
      escapeHtml(receipt.reason)
    }</td><td>${receipt.requestUnits}</td><td>${receipt.grantVersion}</td><td><code>${
      escapeHtml(receipt.id)
    }</code></td></tr>`
  ).join("");
}

function auditRows(state: LocalFixtureView): string {
  if (state.audit.length === 0) {
    return `<tr><td colspan="3">No grant lifecycle events yet.</td></tr>`;
  }
  return state.audit.map((event) =>
    `<tr><td><time datetime="${isoTime(event.at)}">${isoTime(event.at)}</time></td><td>${
      event.event === "grant_revoked" ? "Grant revoked" : "Replacement grant created"
    }</td><td>${event.grantVersion}</td></tr>`
  ).join("");
}

function usageRows(state: LocalFixtureView): string {
  if (state.usage.length === 0) return `<tr><td colspan="5">No usage yet.</td></tr>`;
  return state.usage.map((event) =>
    `<tr><td><time datetime="${isoTime(event.at)}">${isoTime(event.at)}</time></td><td>${
      event.source === "mcp" ? "MCP" : "Local admin"
    }</td><td>${event.decision}</td><td>${event.requestUnits}</td><td>${event.grantVersion}</td></tr>`
  ).join("");
}

export function renderAdminPage(state: AdminPageState): string {
  const endpoint = `${state.origin}/mcp`;
  const config = clientConfiguration(state.origin);
  const notice = state.notice === undefined
    ? ""
    : `<section class="wide notice" aria-live="polite"><p>${
      escapeHtml(state.notice)
    }</p></section>`;
  const result = state.result === undefined
    ? ""
    : `<section class="wide result" aria-labelledby="invoke-result"><h2 id="invoke-result">Invocation result</h2><pre>${
      escapeHtml(state.result)
    }</pre></section>`;
  const reset = state.fixture.owner === "active"
    ? `<section class="wide" aria-labelledby="reset-title"><h2 id="reset-title">Reset fixture</h2><p>Remove all local labels, authority, receipts, usage, and audit events.</p><form action="/admin/owner/reset" method="post">${
      hidden(state.csrfToken)
    }<button class="quiet-danger" type="submit">Reset fixture owner</button></form></section>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="description" content="Create and test a local Cairn fixture authority over MCP.">
  <title>Cairn local admin</title>
  <style>${styles}</style>
  <script src="/admin.js" defer></script>
</head>
<body>
  <header>
    <p class="eyebrow">Local fixture</p>
    <h1>Create authority. Test it. Revoke it.</h1>
    <p class="lede">Run the complete Cairn fixture journey on this machine. Nothing connects to GitHub.</p>
    <code class="command">deno task local:run</code>
  </header>
  <main id="content">
    ${notice}
    <section class="wide" aria-labelledby="onboarding-title"><h2 id="onboarding-title">Fixture onboarding</h2><div class="steps">${
    onboarding(state)
  }</div></section>
    <section class="wide" aria-labelledby="graph-title"><h2 id="graph-title">Authority graph</h2>${
    authorityGraph(state.fixture)
  }</section>
    <section class="wide" aria-labelledby="grant-title"><h2 id="grant-title">Grant</h2>${
    grantPanel(state)
  }</section>
    ${result}
    <section class="wide" aria-labelledby="receipts-title"><h2 id="receipts-title">Invocation receipts</h2><p>Receipts contain bounded decision metadata only. Refresh this page after an MCP call to see it here.</p><div class="table-wrap"><table><thead><tr><th>Time</th><th>Source</th><th>Decision</th><th>Reason</th><th>Units</th><th>Grant version</th><th>Receipt</th></tr></thead><tbody>${
    receiptRows(state.fixture)
  }</tbody></table></div></section>
    <section class="wide" aria-labelledby="usage-title"><h2 id="usage-title">Recent usage</h2><p>Up to 8 recent invocation attempts are kept in memory.</p><div class="table-wrap"><table><thead><tr><th>Time</th><th>Source</th><th>Decision</th><th>Units</th><th>Grant version</th></tr></thead><tbody>${
    usageRows(state.fixture)
  }</tbody></table></div></section>
    <section class="wide" aria-labelledby="audit-title"><h2 id="audit-title">Grant audit</h2><p>Sanitized revoke and replacement events are kept in memory.</p><div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Grant version</th></tr></thead><tbody>${
    auditRows(state.fixture)
  }</tbody></table></div></section>
    <section class="wide" aria-labelledby="connect-title">
      <h2 id="connect-title">Connect over MCP</h2>
      <p>The endpoint is <code>${escapeHtml(endpoint)}</code>. Complete onboarding first.</p>
      <label for="endpoint">MCP endpoint</label>
      <input class="endpoint" id="endpoint" value="${escapeHtml(endpoint)}" readonly>
      <pre id="client-config">${escapeHtml(config)}</pre>
      <button type="button" class="secondary" data-copy>Copy VS Code candidate configuration</button>
      <p id="copy-status" class="copy-status" aria-live="polite"></p>
      <p><strong>VS Code candidate, not yet tested.</strong></p>
      <h3>Wire sequence</h3>
      <ol>
        <li>Send <code>initialize</code>, retain <code>Mcp-Session-Id</code>, then send <code>notifications/initialized</code>.</li>
        <li>Call <code>search_capabilities</code> with <code>{&quot;query&quot;:&quot;github user&quot;}</code>.</li>
        <li>Call <code>describe_operation</code> with <code>{&quot;operation&quot;:&quot;github.user.read@v1&quot;}</code>.</li>
        <li>Call <code>connection_status</code> with <code>{&quot;connection&quot;:&quot;connection_a&quot;}</code>.</li>
        <li>Call <code>invoke_operation</code> with the operation, connection, and empty arguments.</li>
        <li>Reconnect by initializing a new session and repeat the invoke call without rebuilding authority.</li>
      </ol>
    </section>
    ${reset}
  </main>
  <footer><p>Setup and the exact wire journey are in <code>docs/local-setup.md</code>.</p></footer>
</body>
</html>`;
}

export function adminClientScript(): string {
  return adminScript;
}
