# MCP Usage Example

This example shows the shape of the MCP calls after your client has already started `gemini-web-mcp` over stdio.

The exact client wrapper varies, but the tool names and arguments are the same.

## 1. List available tools

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

Example result:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      { "name": "check_status" },
      { "name": "ask_gemini" },
      { "name": "generate_image_ui" },
      { "name": "save_latest_image" }
    ]
  }
}
```

## 2. Check session state

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "check_status",
    "arguments": {}
  }
}
```

Use this first to confirm:

- Gemini is open
- manual sign-in is complete
- the prompt surface is available
- the direct template cache is ready

## 3. Send a text prompt

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "ask_gemini",
    "arguments": {
      "message": "Give me three banner concepts for a repo called Gemini Web MCP."
    }
  }
}
```

## 4. Generate an image

This example lets the MCP choose the best path automatically.

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "generate_image_ui",
    "arguments": {
      "prompt": "A polished open source repo banner for Gemini Web MCP, dark technical aesthetic, browser parity theme, clean typography, subtle neon accents",
      "transport": "auto",
      "outputPath": "E:\\TEMPDOWNLOADS\\CodexImagine\\outputs\\banner.png",
      "removeGeminiWatermark": true
    }
  }
}
```

Expected behavior:

- direct `CycleTLS` path first when the request is direct-eligible
- `Playwright` fallback when Gemini UI state is required
- saved local output at the path you passed in

## 5. Save an already visible result

If Gemini already generated an image and you do not want to prompt again:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "save_latest_image",
    "arguments": {
      "outputPath": "E:\\TEMPDOWNLOADS\\CodexImagine\\outputs\\latest.png",
      "removeGeminiWatermark": true
    }
  }
}
```

## Notes

- `transport: "auto"` is the normal default.
- Use `transport: "direct"` only when you want to force the direct path.
- Use `transport: "ui"` for browser-shaped flows like image-to-image or attachment-heavy work.
- For a fuller breakdown of available options, see [../docs/technical.md](../docs/technical.md).
