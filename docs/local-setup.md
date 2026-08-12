# Local-first DeepSeek setup

Cairn's active local product keeps a DeepSeek API key in the desktop Secret Service and exposes only
`deepseek.chat.complete@v1` to Antigravity. It never asks for or prints the key in a terminal.

## Requirements

- Deno 2.9.0
- Linux Secret Service unlocked for the desktop session
- `/usr/bin/secret-tool` installed

## Start

From the repository root:

```sh
deno task local:run
```

Open <http://127.0.0.1:8787/> and select **Add DeepSeek key**. The masked input appears only on the
separate custodian origin, <http://127.0.0.1:8788/intake>. Submission stores the value through
`secret-tool` stdin and redirects back to the gateway, removing the input from the displayed DOM.
Use **Disconnect** to deny dispatch while retaining the key, **Connect** to create fresh grant
authority, **Replace key** to repeat intake directly (whether connected or disconnected), and
**Delete key and authority** to clear Secret Service and disable the grant. This first usable
connector adds, replaces, and deletes one DeepSeek key. Additional APIs require separate reviewed,
fixed connectors; Cairn does not support arbitrary API configuration.

Custom distinct ports are supported:

```sh
deno task local:run --gateway-port 8790 --custodian-port 8791
```

## Antigravity

Verified configuration shape with Antigravity CLI 1.1.12. Save this globally at
`~/.gemini/config/mcp_config.json`, or for one workspace at `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "cairn-local": {
      "serverUrl": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

In Antigravity IDE, open **Agent panel → … → MCP Servers → Manage MCP Servers → View raw config**.
After editing, use the MCP Manager refresh button. In Antigravity CLI, enter `/mcp` and reload the
server configuration. The handcrafted MCP test suite checks the protocol contract; it is not a real
Antigravity acceptance run.

The four tools are `search_capabilities`, `describe_operation`, `connection_status`, and
`invoke_operation`. Invoke only:

```json
{
  "operation": "deepseek.chat.complete@v1",
  "connection": "deepseek_local",
  "arguments": {
    "messages": [{ "role": "user", "content": "Answer briefly: hello" }],
    "max_output_tokens": 256
  }
}
```

Inputs allow 1–8 system/user messages, at most 8192 UTF-8 bytes each and 32768 total, and optional
output tokens 1–1024. Endpoint, model, headers, tools, files, streaming, and other provider options
are not caller inputs. Output contains bounded assistant text, complete/length finish category, and
validated token counts. Receipts contain no prompts or outputs. Daily policy permits at most 100
dispatched requests and 50,000 conservatively reserved tokens. Each reservation charges UTF-8 input
bytes plus requested maximum output tokens before dispatch and persists atomically in non-secret
custodian metadata; failed or ambiguous dispatches are not refunded or retried.

## Stop and reset

Stop both child services with **Ctrl-C**. To restart, run the same command; the key remains only in
Secret Service and non-secret authority metadata remains in
`~/.local/state/cairn/gateway/deepseek.json`; conservative quota reservations remain in
`~/.local/state/cairn/custodian/deepseek-usage.json`.

Preferred reset: click **Delete key and authority**. If the service cannot start, clear exactly this
credential and then remove only the non-secret Cairn metadata:

```sh
/usr/bin/secret-tool clear cairn deepseek owner local
rm -f ~/.local/state/cairn/gateway/deepseek.json
rm -f ~/.local/state/cairn/custodian/deepseek-usage.json
```

## Credential-free validation and fixture regression

```sh
deno task local:smoke
deno task local:fixture-smoke
deno task check:local
deno task check
```

The smoke and tests use only fake stores and fake provider responses. The historical GitHub fixture
is retained through `deno task local:fixture`.

## Honest local boundary

This protects the key from extraction through normal Cairn gateway/control, MCP, logs, receipts,
config, arguments, URLs, and repository surfaces. It is not isolation from root, hostile processes
running as the same OS user, browser compromise, or a compromised Secret Service/custodian.
