# Agent Usage Example

This is the practical way most people will use `gemini-web-mcp`:

- the user talks to an agent
- the agent decides to call the MCP tools
- the user gets back a normal answer plus a saved output path

## Example 1: text-to-image

### User prompt to the agent

```text
Generate a polished banner for my repo called Gemini Web MCP.
Use a dark technical aesthetic with subtle neon accents.
Save it as E:\TEMPDOWNLOADS\CodexImagine\outputs\banner.png.
```

### What the agent does under the hood

- checks Gemini session state
- chooses `generate_image_ui`
- uses `transport: auto`
- tries direct `CycleTLS` first
- falls back to the browser only if needed

### Example agent reply

```text
Generated your banner and saved it to:
E:\TEMPDOWNLOADS\CodexImagine\outputs\banner.png

Transport used: direct
Watermark cleanup: applied
```

## Example 2: image-to-image

### User prompt to the agent

```text
Take E:\TEMPDOWNLOADS\CodexImagine\inputs\concept.png and turn it into
a cleaner open source project banner. Keep the composition, but make it
look more premium. Save the result to
E:\TEMPDOWNLOADS\CodexImagine\outputs\banner-v2.png.
```

### What the agent does under the hood

- detects this is image-to-image work
- attaches the reference image
- uses the UI path because browser state matters here
- waits until Gemini finishes creating the image
- saves the visible result

### Example agent reply

```text
Created the image-to-image variation and saved it to:
E:\TEMPDOWNLOADS\CodexImagine\outputs\banner-v2.png

Transport used: ui
Reference images used: 1
```

## Example 3: save an already visible result

### User prompt to the agent

```text
Do not generate anything new. Save the latest visible Gemini image to
E:\TEMPDOWNLOADS\CodexImagine\outputs\latest.png.
```

### Example agent reply

```text
Saved the latest visible Gemini image to:
E:\TEMPDOWNLOADS\CodexImagine\outputs\latest.png
```

## When to use this example style

Use this style when you want to explain the repo to:

- end users
- agent builders
- people evaluating the product quickly

If you want the lower-level JSON-RPC tool calls instead, see [mcp-usage.md](./mcp-usage.md).
