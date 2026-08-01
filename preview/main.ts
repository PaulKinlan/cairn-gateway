const ACCEPTED_REVISION = "08dc01a03ef229e40ff356da2eb03c3f01cf7a96";
const REPOSITORY_URL = "https://github.com/PaulKinlan/cairn-gateway";

const SECURITY_HEADERS = Object.freeze(
  [
    ["Cache-Control", "no-store, max-age=0"],
    [
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; child-src 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'none'; manifest-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; worker-src 'none'",
    ],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    [
      "Permissions-Policy",
      "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), identity-credentials-get=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), otp-credentials=(), payment=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), storage-access=(), usb=(), web-share=(), window-management=(), xr-spatial-tracking=()",
    ],
    ["Referrer-Policy", "no-referrer"],
    ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["X-Permitted-Cross-Domain-Policies", "none"],
  ] as const,
);

const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>Cairn Gateway — credential-free public preview</title>
  <style>
    :root {
      color-scheme: light dark;
      --background: #f4f1e8;
      --surface: #fffdf7;
      --text: #17211c;
      --muted: #4f5c55;
      --line: #c9d0c8;
      --accent: #17633c;
      --accent-soft: #dcecdf;
      --warning: #7a4912;
      --warning-soft: #f5e6cc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--background);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
    }
    a { color: var(--accent); text-underline-offset: 0.18em; }
    a:focus-visible { outline: 0.2rem solid var(--accent); outline-offset: 0.2rem; }
    code {
      overflow-wrap: anywhere;
      font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
      font-size: 0.9em;
    }
    header, main, footer { width: min(68rem, calc(100% - 2rem)); margin-inline: auto; }
    header { padding-block: clamp(3rem, 9vw, 7rem) 2rem; }
    .eyebrow {
      margin: 0 0 0.7rem;
      color: var(--accent);
      font-size: 0.82rem;
      font-weight: 750;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h1 { max-width: 15ch; margin: 0; font-size: clamp(2.4rem, 7vw, 5.5rem); line-height: 0.98; }
    .lede { max-width: 57ch; margin: 1.5rem 0 0; color: var(--muted); font-size: clamp(1.05rem, 2vw, 1.3rem); }
    main { display: grid; gap: 1rem; padding-block: 1rem 4rem; }
    section, aside {
      border: 1px solid var(--line);
      border-radius: 1rem;
      background: var(--surface);
      padding: clamp(1.25rem, 4vw, 2rem);
    }
    h2 { margin: 0 0 1rem; font-size: clamp(1.25rem, 3vw, 1.65rem); line-height: 1.2; }
    p:last-child, ul:last-child { margin-bottom: 0; }
    dl { display: grid; grid-template-columns: minmax(10rem, 0.7fr) 1fr; gap: 0; margin: 0; }
    dt, dd { margin: 0; padding-block: 0.75rem; border-top: 1px solid var(--line); }
    dt { color: var(--muted); padding-right: 1rem; }
    dd { font-weight: 650; }
    dt:first-of-type, dd:first-of-type { border-top: 0; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      padding: 0.28rem 0.7rem;
      font-size: 0.9rem;
      font-weight: 750;
    }
    .status::before { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: currentColor; content: ""; }
    aside { border-color: color-mix(in srgb, var(--warning) 35%, var(--line)); background: var(--warning-soft); }
    aside h2 { color: var(--warning); }
    ul { padding-left: 1.3rem; }
    footer { border-top: 1px solid var(--line); padding-block: 1.5rem 3rem; color: var(--muted); }
    @media (min-width: 48rem) {
      main { grid-template-columns: minmax(0, 1.35fr) minmax(18rem, 0.65fr); }
      main section:first-child { grid-column: 1 / -1; }
    }
    @media (max-width: 34rem) {
      dl { grid-template-columns: 1fr; }
      dt { border-top: 0; padding-bottom: 0.1rem; }
      dt:not(:first-of-type) { border-top: 1px solid var(--line); }
      dd { border-top: 0; padding-top: 0.1rem; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #101612;
        --surface: #18211b;
        --text: #edf4ee;
        --muted: #b3c0b6;
        --line: #3b4940;
        --accent: #83d7a2;
        --accent-soft: #203d2b;
        --warning: #f2bd76;
        --warning-soft: #382817;
      }
    }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">Public engineering preview · Credential-free</p>
    <h1>Delegate access. Keep the credentials.</h1>
    <p class="lede">Cairn Gateway is an authority boundary for agents: narrowly scoped capabilities, explicit policy, revocable identity, and no caller access to underlying credentials. This deployment exposes project evidence only. Invocation is disabled.</p>
  </header>
  <main>
    <section aria-labelledby="preview-status">
      <h2 id="preview-status">Preview status</h2>
      <dl>
        <dt>Preview process</dt>
        <dd><span class="status">Healthy</span></dd>
        <dt>Invocation</dt>
        <dd>Disabled</dd>
        <dt>Credential access</dt>
        <dd>False</dd>
        <dt>Storage mode</dt>
        <dd>None</dd>
        <dt>Vendor mode</dt>
        <dd>None</dd>
      </dl>
    </section>
    <section aria-labelledby="project-purpose">
      <h2 id="project-purpose">What exists today</h2>
      <ul>
        <li>A capability and policy core with exact route allowlisting and tenant isolation.</li>
        <li>An adapter-neutral durability contract covering ambiguous commits without unsafe retries.</li>
        <li>Separate owner, device, agent, workload, and credential-custody authority boundaries.</li>
        <li>Fail-closed request proofs, revocation, replay protection, and exact operation projection.</li>
      </ul>
    </section>
    <section aria-labelledby="accepted-evidence">
      <h2 id="accepted-evidence">Evidence, not promises</h2>
      <p>Accepted foundation: <strong>114 cases</strong> — 90 Stage 0 plus 24 Stage 1A, zero skips.</p>
      <p>Accepted foundation revision:</p>
      <p><code>${ACCEPTED_REVISION}</code></p>
    </section>
    <aside aria-labelledby="activation-boundary">
      <h2 id="activation-boundary">Activation remains blocked</h2>
      <p>This preview makes no production-readiness, production key custody, storage, vendor integration, or MCP transport/protocol conformance claim.</p>
      <p>It cannot invoke an integration, read a credential, mutate state, or proxy to a caller-selected destination.</p>
    </aside>
  </main>
  <footer>
    <p>Source: <a href="${REPOSITORY_URL}">Cairn Gateway on GitHub</a></p>
  </footer>
</body>
</html>
`;

const HEALTH_JSON = `${
  JSON.stringify({
    schema: "cairn.preview.health.v1",
    status: "healthy",
    previewProcess: "healthy",
    preview: true,
    invocationEnabled: false,
    credentialAccess: false,
    storageMode: "none",
    vendorMode: "none",
    acceptedRevision: ACCEPTED_REVISION,
    acceptedGate: {
      cases: 114,
      stage0Cases: 90,
      stage1Cases: 24,
      skips: 0,
    },
  })
}\n`;

const MCP_DISABLED_JSON = `${
  JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32003,
      message: "Cairn preview invocation is permanently disabled.",
    },
    id: null,
  })
}\n`;

const NOT_FOUND_JSON = `${
  JSON.stringify({
    error: "not_found",
    message: "Preview route not found.",
  })
}\n`;

const METHOD_NOT_ALLOWED_JSON = `${
  JSON.stringify({
    error: "method_not_allowed",
    message: "Only GET is available on this preview route.",
  })
}\n`;

function response(body: string, status: number, contentType: string, allow?: string): Response {
  const headers = new Headers();
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  headers.set("Content-Type", contentType);
  if (allow !== undefined) headers.set("Allow", allow);
  return new Response(body, { status, headers });
}

function json(body: string, status: number, allow?: string): Response {
  return response(body, status, "application/json; charset=utf-8", allow);
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    const route = url.search === "" ? url.pathname : "";

    if (route === "/mcp" || route === "/mcp/legacy") {
      return json(MCP_DISABLED_JSON, 403);
    }

    if (route !== "/" && route !== "/healthz") {
      return json(NOT_FOUND_JSON, 404);
    }

    if (request.method !== "GET") {
      return json(METHOD_NOT_ALLOWED_JSON, 405, "GET");
    }

    if (route === "/healthz") return json(HEALTH_JSON, 200);
    return response(HOME_HTML, 200, "text/html; charset=utf-8");
  },
};
