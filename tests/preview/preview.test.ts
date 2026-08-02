import { assert, equals } from "../assert.ts";
import preview from "../../preview/main.ts";

const ACCEPTED_REVISION = "08dc01a03ef229e40ff356da2eb03c3f01cf7a96";
const REPOSITORY_URL = "https://github.com/PaulKinlan/cairn-gateway";

const requiredSecurityHeaders: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store, max-age=0",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-permitted-cross-domain-policies": "none",
});

function request(path: string, method = "GET"): Response {
  return preview.fetch(new Request(`https://preview.cairn.invalid${path}`, { method }));
}

async function bodyOf(path: string, method = "GET"): Promise<string> {
  return await request(path, method).text();
}

function hostileRequest(path: string, method = "POST") {
  const base = new Request(`https://preview.cairn.invalid${path}`, { method });
  let bodyAccesses = 0;
  let bodyReaderCalls = 0;
  const hostile = new Proxy(base, {
    get(target, property) {
      if (property === "body") {
        bodyAccesses++;
        return new ReadableStream<Uint8Array>({
          pull() {
            bodyReaderCalls++;
            throw new Error("hostile request body was read");
          },
        });
      }
      if (
        property === "arrayBuffer" || property === "blob" || property === "bytes" ||
        property === "formData" || property === "json" || property === "text"
      ) {
        return () => {
          bodyReaderCalls++;
          throw new Error("hostile request body reader was called");
        };
      }
      return Reflect.get(target, property, target);
    },
  });
  return {
    request: hostile,
    counts: () => ({ bodyAccesses, bodyReaderCalls }),
  };
}

Deno.test("GET / leads with local run steps and labels VS Code config as candidate", async () => {
  const response = request("/");
  equals(response.status, 200);
  equals(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert(html.startsWith("<!DOCTYPE html>"));
  assert(html.includes('<html lang="en">'));
  assert(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0">'));
  equals(html.match(/<h1(?:\s|>)/g)?.length, 1);
  for (const landmark of ["<header>", "<main>", "<section", "<footer>"]) {
    assert(html.includes(landmark), `missing ${landmark}`);
  }
  assert(html.includes("Run Cairn on your machine."));
  assert(html.includes("deno task local:run"));
  assert(html.includes("http://127.0.0.1:8787/"));
  assert(html.includes("candidate VS Code configuration pending named-client validation"));
  assert(html.includes("not an accepted compatibility claim"));
  assert(html.includes(".vscode/mcp.json"));
  assert(html.includes('"type": "http"'));
  assert(html.includes("http://127.0.0.1:8787/mcp"));
  assert(html.includes("github.user.read@v1"));
  assert(!html.includes("114 cases"));
  assert(!html.includes(ACCEPTED_REVISION));
  assert(html.includes(`href="${REPOSITORY_URL}"`));
});

Deno.test("preview HTML needs no scripts, forms, remote assets, cookies, or analytics", async () => {
  const html = await bodyOf("/");
  for (
    const forbidden of [
      /<script\b/i,
      /<form\b/i,
      /<iframe\b/i,
      /<img\b/i,
      /<link\b/i,
      /@import\b/i,
      /\burl\s*\(/i,
      /document\.cookie/i,
      /localStorage|sessionStorage|indexedDB/i,
      /analytics|telemetry|tracking pixel/i,
    ]
  ) assert(!forbidden.test(html), String(forbidden));
  const urls = html.match(/https?:\/\/[^"'\s<]+/g) ?? [];
  equals(urls, [
    "http://127.0.0.1:8787/",
    "http://127.0.0.1:8787/mcp",
    REPOSITORY_URL,
  ]);
});

Deno.test("preview keeps the public deployment outside the local authority", async () => {
  const html = await bodyOf("/");
  assert(html.includes("The local server uses fixtures, not a GitHub credential."));
  assert(html.includes("Production custody"));
  assert(html.includes("durable storage"));
  assert(
    html.includes("This public deployment does not run the local authority or accept MCP calls."),
  );
});

Deno.test("GET /healthz returns the canonical stable health schema", async () => {
  const response = request("/healthz");
  equals(response.status, 200);
  equals(response.headers.get("content-type"), "application/json; charset=utf-8");
  equals(await response.json(), {
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
  });
});

Deno.test("MCP routes fail closed permanently for every method with JSON-RPC-shaped 403", async () => {
  for (const path of ["/mcp", "/mcp/legacy"]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "BREW"]) {
      const response = request(path, method);
      equals(response.status, 403);
      equals(response.headers.get("content-type"), "application/json; charset=utf-8");
      equals(response.headers.get("retry-after"), null);
      equals(response.headers.get("www-authenticate"), null);
      equals(JSON.parse(await response.text()), {
        jsonrpc: "2.0",
        error: {
          code: -32003,
          message: "Cairn preview invocation is permanently disabled.",
        },
        id: null,
      });
    }
  }
});

Deno.test("MCP failure does not inspect or read a hostile body stream", async () => {
  for (const path of ["/mcp", "/mcp/legacy"]) {
    const hostile = hostileRequest(path);
    const response = preview.fetch(hostile.request);
    equals(response.status, 403);
    await response.text();
    equals(hostile.counts(), { bodyAccesses: 0, bodyReaderCalls: 0 });
  }
});

Deno.test("unknown routes are matched before method or body processing", async () => {
  for (const path of ["/missing", "/healthz/", "/mcp/", "/mcp?session=sentinel"]) {
    const hostile = hostileRequest(path);
    const response = preview.fetch(hostile.request);
    equals(response.status, 404);
    equals(await response.json(), {
      error: "not_found",
      message: "Preview route not found.",
    });
    equals(hostile.counts(), { bodyAccesses: 0, bodyReaderCalls: 0 });
  }
});

Deno.test("known status routes reject non-GET methods deterministically", async () => {
  for (const path of ["/", "/healthz"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      const response = request(path, method);
      equals(response.status, 405);
      equals(response.headers.get("allow"), "GET");
      equals(await response.json(), {
        error: "method_not_allowed",
        message: "Only GET is available on this preview route.",
      });
    }
  }
});

Deno.test("every response carries strict security and isolation headers", () => {
  for (
    const response of [
      request("/"),
      request("/healthz"),
      request("/mcp", "POST"),
      request("/mcp/legacy", "DELETE"),
      request("/missing"),
      request("/", "POST"),
    ]
  ) {
    for (const [name, value] of Object.entries(requiredSecurityHeaders)) {
      equals(response.headers.get(name), value);
    }
    const csp = response.headers.get("content-security-policy") ?? "";
    for (
      const directive of [
        "default-src 'none'",
        "connect-src 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "script-src 'none'",
      ]
    ) assert(csp.includes(directive), directive);
    const permissions = response.headers.get("permissions-policy") ?? "";
    assert(permissions.includes("camera=()"));
    assert(permissions.includes("geolocation=()"));
    assert(permissions.includes("microphone=()"));
    assert(permissions.includes("storage-access=()"));
    equals(response.headers.get("set-cookie"), null);
  }
});

Deno.test("route responses are byte-for-byte deterministic", async () => {
  for (
    const [path, method] of [
      ["/", "GET"],
      ["/healthz", "GET"],
      ["/mcp", "POST"],
      ["/mcp/legacy", "OPTIONS"],
      ["/missing", "GET"],
      ["/", "POST"],
    ] as const
  ) {
    const first = request(path, method);
    const second = request(path, method);
    equals(first.status, second.status);
    equals([...first.headers.entries()], [...second.headers.entries()]);
    equals(await first.text(), await second.text());
  }
});

Deno.test("request data, secrets, private hosts, and local paths never leak", async () => {
  const sentinels = [
    "TOP_SECRET_SENTINEL",
    "private.cairn.internal",
    "/home/operator/private",
    "client_secret",
  ];
  const responses = [
    preview.fetch(
      new Request(
        "https://private.cairn.internal/healthz?client_secret=TOP_SECRET_SENTINEL",
        { headers: { "x-local-path": "/home/operator/private" } },
      ),
    ),
    preview.fetch(
      new Request("https://private.cairn.internal/mcp", {
        method: "POST",
        body: "TOP_SECRET_SENTINEL /home/operator/private",
      }),
    ),
  ];
  for (const response of responses) {
    const body = await response.text();
    for (const sentinel of sentinels) assert(!body.includes(sentinel), sentinel);
    assert(!/(?:\/home\/|\/Users\/|[A-Z]:\\)/.test(body));
  }
});

Deno.test("preview source has no activation, dependency, or mutable browser surfaces", async () => {
  const source = await Deno.readTextFile("preview/main.ts");
  for (
    const forbidden of [
      /\bDeno\.(?:env|openKv|serve|serveHttp|listen|listenTls)\b/,
      /\bglobalThis\.fetch\s*\(/,
      /\bnew\s+(?:WebSocket|EventSource)\b/,
      /\b(?:localStorage|sessionStorage|indexedDB|caches)\b/,
      /document\.cookie/,
      /from\s+["'](?:https?:|npm:|jsr:)/,
      /import\s*\(["'](?:https?:|npm:|jsr:)/,
      /<script\b/i,
      /<form\b/i,
      /\bSet-Cookie\b/i,
    ]
  ) assert(!forbidden.test(source), String(forbidden));
  const urls = source.match(/https?:\/\/[^"'\s<]+/g) ?? [];
  equals(urls, [
    REPOSITORY_URL,
    "http://127.0.0.1:8787/",
    "http://127.0.0.1:8787/mcp",
  ]);
  const server = await Deno.readTextFile("preview/server.ts");
  equals(
    server,
    'import preview from "./main.ts";\n\nDeno.serve((request) => preview.fetch(request));\n',
  );
});
