# MCP Client Setup Example (Codex CLI)

```powershell
$env:GEMINI_WEB_CDP_URL="http://127.0.0.1:9340"
$env:GEMINI_WEB_CYCLETLS_JS_PATH="E:\path\to\CycleTLS-Parity\dist\index.js"
$env:GEMINI_WEB_CYCLETLS_EXE_PATH="E:\path\to\CycleTLS-Parity\dist\index.exe"

codex mcp add gemini-web-session --env GEMINI_WEB_CDP_URL=$env:GEMINI_WEB_CDP_URL --env GEMINI_WEB_CYCLETLS_JS_PATH=$env:GEMINI_WEB_CYCLETLS_JS_PATH --env GEMINI_WEB_CYCLETLS_EXE_PATH=$env:GEMINI_WEB_CYCLETLS_EXE_PATH -- node ".\scripts\gemini-web-mcp.mjs"
```

Optional:

```powershell
$env:GEMINI_WEB_PLAYWRIGHT_MODULE="playwright"
```
