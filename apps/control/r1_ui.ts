import type { R1TenantFixture } from "../../packages/core/src/r1/foundation.ts";

export type R1OwnerView = "connections" | "agents";

type OwnerAction =
  | "/owner/clients/a/revoke"
  | "/owner/clients/b/revoke"
  | "/owner/connections/github/disconnect"
  | "/owner/connections/github/reconnect";

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function csrfField(value: string): string {
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(value)}">`;
}

function actionForm(action: OwnerAction, token: string, label: string, impact: string): string {
  return `<form method="post" action="${action}">${csrfField(token)}<p>${
    escapeHtml(impact)
  }</p><button type="submit">${escapeHtml(label)}</button></form>`;
}

function shell(title: string, current: R1OwnerView, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Cairn</title>
<style>
:root{color-scheme:light dark;font:100%/1.5 system-ui,sans-serif}body{margin:0 auto;max-width:72rem;padding:1rem}nav ul{display:flex;gap:1rem;list-style:none;padding:0}main{display:grid;gap:1.5rem}section{border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:.5rem;padding:1rem;overflow:auto}.facts{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1rem}.facts dt{font-weight:700}.facts dd{margin:0}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid color-mix(in srgb,currentColor 20%,transparent);padding:.6rem;text-align:left;vertical-align:top}form{margin-block:1rem}button{font:inherit;padding:.55rem .8rem}button:focus-visible,a:focus-visible{outline:.2rem solid Highlight;outline-offset:.2rem}.status{font-weight:700}@media(max-width:42rem){table{display:block;overflow-x:auto}.facts{grid-template-columns:1fr}.facts dd{margin-bottom:.5rem}}
</style>
</head>
<body>
<header><p>Cairn credential-free R1 foundation</p><nav aria-label="Owner"><ul><li><a href="/owner/connections"${
    current === "connections" ? ' aria-current="page"' : ""
  }>Connections</a></li><li><a href="/owner/agents"${
    current === "agents" ? ' aria-current="page"' : ""
  }>Agents and grants</a></li></ul></nav></header>
<main><h1>${escapeHtml(title)}</h1>${body}</main>
</body>
</html>`;
}

function renderConnections(fixture: R1TenantFixture, token: string): string {
  const snapshot = fixture.snapshot();
  const connection = snapshot.connection;
  const connected = connection.lifecycle === "connected";
  const controls = connected
    ? actionForm(
      "/owner/connections/github/disconnect",
      token,
      "Disconnect GitHub",
      "Dispatch stops immediately for both clients. This fixture makes no upstream revoke claim.",
    )
    : actionForm(
      "/owner/connections/github/reconnect",
      token,
      "Create fresh GitHub connection authority",
      "Reconnect creates a new connection ID and rebinds eligible grants; it never reactivates the disconnected authority.",
    );
  return shell(
    "Connections",
    "connections",
    `<section aria-labelledby="github-title"><h2 id="github-title">GitHub</h2><dl class="facts"><dt>Lifecycle</dt><dd class="status">${
      escapeHtml(connection.lifecycle)
    }</dd><dt>Configured</dt><dd>${
      connection.configured ? "Yes — an opaque fixture custody binding exists" : "No"
    }</dd><dt>Health</dt><dd>${escapeHtml(connection.health)}${
      connection.healthCheckedAt === undefined
        ? " — no bounded check has run"
        : ` — checked ${escapeHtml(connection.healthCheckedAt)}`
    }</dd><dt>Connection authority</dt><dd><code>${
      escapeHtml(connection.id)
    }</code></dd><dt>Operation</dt><dd><code>github.user.read@v1</code></dd></dl>${controls}</section>
<section aria-labelledby="impact-title"><h2 id="impact-title">Grant impact</h2><p>${
      connected
        ? "Two named clients currently have grants to this one tenant-owned connection."
        : "The disconnected authority denies every stale grant, regardless of client status."
    }</p></section>`,
  );
}

function renderAgents(fixture: R1TenantFixture, token: string): string {
  const snapshot = fixture.snapshot();
  const grantByClient = new Map(snapshot.grants.map((grant) => [grant.clientPrincipalId, grant]));
  const rows = snapshot.clients.map((client) => {
    const grant = grantByClient.get(client.id);
    const action = client.status === "active"
      ? actionForm(
        client.name === "Client A" ? "/owner/clients/a/revoke" : "/owner/clients/b/revoke",
        token,
        `Revoke ${client.name}`,
        `Discovery, status, and invocation stop for ${client.name}; the shared connection and other client remain unchanged.`,
      )
      : "Revoked at the named-client boundary.";
    return `<tr><th scope="row">${escapeHtml(client.name)}</th><td><code>${
      escapeHtml(client.thumbprint)
    }</code></td><td class="status">${escapeHtml(client.status)}</td><td>${
      grant
        ? `<code>${escapeHtml(grant.operation)}</code><br>${escapeHtml(grant.status)} · version ${
          escapeHtml(grant.version)
        }<br>Connection <code>${escapeHtml(grant.providerConnectionId)}</code>`
        : "No grant"
    }</td><td>${action}</td></tr>`;
  }).join("");
  const receipts = snapshot.receipts.length === 0
    ? `<p>No invocation receipts yet.</p>`
    : `<table><caption>Secret-free invocation activity</caption><thead><tr><th scope="col">Client</th><th scope="col">Decision</th><th scope="col">Reason</th><th scope="col">Operation</th><th scope="col">Units</th></tr></thead><tbody>${
      snapshot.receipts.map((receipt) =>
        `<tr><th scope="row"><code>${escapeHtml(receipt.clientPrincipalId)}</code></th><td>${
          escapeHtml(receipt.decision)
        }</td><td>${escapeHtml(receipt.reason)}</td><td><code>${
          escapeHtml(receipt.operation)
        }</code></td><td>${escapeHtml(receipt.requestUnits)}</td></tr>`
      ).join("")
    }</tbody></table>`;
  return shell(
    "Agents and grants",
    "agents",
    `<section aria-labelledby="clients-title"><h2 id="clients-title">Named client principals</h2><p>The named client is the R1 revocation unit. Separate workload identity is not active in this slice.</p><table><caption>Two separately revocable clients sharing one tenant-owned GitHub connection</caption><thead><tr><th scope="col">Client</th><th scope="col">P-256 fingerprint</th><th scope="col">Status</th><th scope="col">Grant</th><th scope="col">Impact and action</th></tr></thead><tbody>${rows}</tbody></table></section><section aria-labelledby="activity-title"><h2 id="activity-title">Activity</h2>${receipts}</section>`,
  );
}

function freshCsrf(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Server-rendered owner seam. The authenticated tenant fixture is captured, never parsed from input. */
export class R1OwnerUiSession {
  #csrf = freshCsrf();
  constructor(private readonly fixture: R1TenantFixture, private readonly origin: string) {
    if (!/^https?:\/\/[A-Za-z0-9.:-]+$/.test(origin)) throw new Error("owner origin denied");
  }

  render(view: R1OwnerView): string {
    return view === "connections"
      ? renderConnections(this.fixture, this.#csrf)
      : renderAgents(this.fixture, this.#csrf);
  }

  async post(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method denied", { status: 405 });
    const url = new URL(request.url);
    if (url.origin !== this.origin || request.headers.get("Origin") !== this.origin) {
      return new Response("origin denied", { status: 403 });
    }
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      return new Response("form denied", { status: 415 });
    }
    const form = await request.formData();
    if ([...form.keys()].join("\0") !== "csrf_token" || form.get("csrf_token") !== this.#csrf) {
      return new Response("csrf denied", { status: 403 });
    }
    this.#csrf = freshCsrf();
    const path = url.pathname as OwnerAction;
    try {
      if (path === "/owner/clients/a/revoke") this.fixture.revokeClient("A");
      else if (path === "/owner/clients/b/revoke") this.fixture.revokeClient("B");
      else if (path === "/owner/connections/github/disconnect") await this.fixture.disconnect();
      else if (path === "/owner/connections/github/reconnect") await this.fixture.reconnect();
      else return new Response("action denied", { status: 404 });
    } catch {
      return new Response("action denied", { status: 409 });
    }
    const view: R1OwnerView = path.includes("connections") ? "connections" : "agents";
    return new Response(this.render(view), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
