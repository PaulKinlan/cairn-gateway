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
  <title>Run Cairn locally</title>
  <style>
    :root {
      color-scheme: light dark;
      --background: #f4f1e8;
      --surface: #fffdf7;
      --text: #17211c;
      --muted: #4f5c55;
      --line: #aeb8b0;
      --accent: #17633c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--background);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
    }
    header, main, footer { width: min(64rem, calc(100% - 2rem)); margin-inline: auto; }
    header { padding-block: clamp(3rem, 9vw, 7rem) 2rem; }
    main { display: grid; gap: 1rem; padding-block: 1rem 4rem; }
    section { border: 1px solid var(--line); border-radius: 0.8rem; background: var(--surface); padding: clamp(1.25rem, 4vw, 2rem); }
    h1 { max-width: 14ch; margin: 0; font-size: clamp(2.6rem, 7vw, 5.5rem); line-height: 0.98; letter-spacing: -0.04em; }
    h2 { margin-block: 0 0.8rem; font-size: 1.4rem; }
    p { max-width: 67ch; }
    .eyebrow { color: var(--accent); font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; }
    .lede { color: var(--muted); font-size: clamp(1.05rem, 2vw, 1.25rem); }
    code, pre { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
    .command { display: block; width: fit-content; border-radius: 0.45rem; background: var(--text); color: var(--surface); padding: 0.8rem 1rem; }
    pre { overflow-x: auto; border: 1px solid var(--line); border-radius: 0.45rem; background: var(--background); padding: 1rem; }
    a { color: var(--accent); text-underline-offset: 0.18em; }
    a:focus-visible { outline: 0.2rem solid var(--accent); outline-offset: 0.2rem; }
    footer { border-top: 1px solid var(--line); padding-block: 1.5rem 3rem; color: var(--muted); }
    @media (min-width: 48rem) { main { grid-template-columns: 1fr 1fr; } main section:first-child { grid-column: 1 / -1; } }
    @media (prefers-color-scheme: dark) {
      :root { --background: #101612; --surface: #18211b; --text: #edf4ee; --muted: #b3c0b6; --line: #69776d; --accent: #83d7a2; }
    }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">Cairn local fixture</p>
    <h1>Run Cairn on your machine.</h1>
    <p class="lede">Clone the repository, install Deno 2.9.0, then start the loopback-only MCP server and setup page.</p>
    <code class="command">deno task local:run</code>
    <p>Open <code>http://127.0.0.1:8787/</code>. The local page shows the endpoint, fixture grant state, test controls, and a candidate VS Code configuration pending named-client validation.</p>
  </header>
  <main>
    <section aria-labelledby="connect-vscode">
      <h2 id="connect-vscode">Candidate VS Code configuration</h2>
      <p>This matches the local endpoint but is not an accepted compatibility claim. Milestone 5 owns the named-client run.</p>
      <p>If you want to try the candidate, create <code>.vscode/mcp.json</code> in a disposable project:</p>
      <pre>{
  "servers": {
    "cairn-local": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}</pre>
    </section>
    <section aria-labelledby="try-operation">
      <h2 id="try-operation">Try one operation</h2>
      <p>Call <code>invoke_operation</code> with <code>github.user.read@v1</code> and <code>connection_a</code>. Cairn returns the fixed GitHub user fixture.</p>
    </section>
    <section aria-labelledby="current-boundary">
      <h2 id="current-boundary">Current boundary</h2>
      <p>The local server uses fixtures, not a GitHub credential. Production custody, provider authorization, durable storage, and hosted MCP authentication are not connected yet.</p>
      <p>This public deployment does not run the local authority or accept MCP calls.</p>
    </section>
  </main>
  <footer>
    <p><a href="${REPOSITORY_URL}">Source and setup guide</a></p>
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
