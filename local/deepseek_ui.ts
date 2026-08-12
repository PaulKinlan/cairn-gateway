import type { DeepSeekView } from "./deepseek_controller.ts";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll(
    '"',
    "&quot;",
  );
}
function hidden(csrf: string) {
  return `<input type="hidden" name="csrf_token" value="${escape(csrf)}">`;
}
function rows(view: DeepSeekView) {
  return view.receipts.length
    ? view.receipts.map((r) =>
      `<tr><td>${
        new Date(r.at * 1000).toISOString()
      }</td><td>${r.decision}</td><td>${r.reason}</td><td>${r.requestUnits}</td><td>${
        r.inputTokens ?? "—"
      }/${r.outputTokens ?? "—"}</td></tr>`
    ).join("")
    : `<tr><td colspan="5">No calls yet.</td></tr>`;
}
export function renderDeepSeekPage(
  origin: string,
  custodianOrigin: string,
  csrf: string,
  view: DeepSeekView,
  notice = "",
) {
  const action = !view.configured
    ? `<a class="button" href="${escape(custodianOrigin)}/intake">Add DeepSeek key</a>`
    : view.connected
    ? `<form method="post" action="/admin/disconnect">${
      hidden(csrf)
    }<button>Disconnect</button></form>`
    : `<form method="post" action="/admin/connect">${
      hidden(csrf)
    }<button>Connect</button></form><a class="button secondary" href="${
      escape(custodianOrigin)
    }/intake">Replace key</a>`;
  const config = JSON.stringify(
    { mcpServers: { "cairn-local": { serverUrl: `${origin}/mcp` } } },
    null,
    2,
  );
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cairn local DeepSeek</title><style>body{font:16px system-ui;background:#f3efe5;color:#17211c;margin:0}header,main{max-width:70rem;margin:auto;padding:2rem}section{background:#fffdf7;border:1px solid #aeb8b0;border-radius:.7rem;padding:1.5rem;margin:1rem 0}h1{font-size:clamp(2rem,6vw,4rem);max-width:18ch}button,.button{display:inline-block;background:#145d38;color:white;border:0;border-radius:.4rem;padding:.8rem 1rem;font-weight:700;text-decoration:none;font:inherit}.secondary{background:#536159}.danger{background:#862d24}.actions{display:flex;gap:.75rem;flex-wrap:wrap}.status{font-weight:700}pre{overflow:auto;background:#eee9dc;padding:1rem}table{width:100%;border-collapse:collapse}td,th{padding:.6rem;text-align:left;border-bottom:1px solid #ccc}</style></head><body><header><p>Local-first custody</p><h1>DeepSeek through Cairn, without sharing your key.</h1><p>The key intake runs on a separate loopback origin and Secret Service stores it. The gateway exposes only <code>deepseek.chat.complete@v1</code>.</p></header><main>${
    notice ? `<section><p>${escape(notice)}</p></section>` : ""
  }<section><h2>Connection</h2><p>Configured: <span class="status">${
    view.configured ? "yes" : "no"
  }</span> · Connected: <span class="status">${
    view.connected ? "yes" : "no"
  }</span> · Health: <span class="status">${
    view.healthy === null ? "not checked" : view.healthy ? "healthy" : "unhealthy"
  }</span></p><div class="actions">${action}${
    view.configured
      ? `<form method="post" action="/admin/delete">${
        hidden(csrf)
      }<button class="danger">Delete key and authority</button></form>`
      : ""
  }</div></section><section><h2>Fixed grant</h2><p><code>${view.grant.operation}</code> · ${view.grant.status} · version ${view.grant.version}</p><p>Only 1–8 system/user messages are accepted. Caller URL, model, headers, tools, files, and provider options are impossible.</p></section><section><h2>Antigravity</h2><pre>${
    escape(config)
  }</pre><p>Use the existing four tools: <code>search_capabilities</code>, <code>describe_operation</code>, <code>connection_status</code>, and <code>invoke_operation</code>.</p></section><section><h2>Secret-free receipts</h2><table><thead><tr><th>Time</th><th>Decision</th><th>Reason</th><th>Units</th><th>Input/output tokens</th></tr></thead><tbody>${
    rows(view)
  }</tbody></table></section></main></body></html>`;
}
