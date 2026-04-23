# CodexImagine

CycleTLS-first Gemini web-session MCP for Codex.

![CodexImagine hero](./assets/hero.png)

`CodexImagine` turns a manually signed-in `gemini.google.com` browser session into a local MCP server for Codex. It prefers direct `CycleTLS` requests for simple text-to-image work, falls back to Playwright only when the direct path is not enough, and keeps the rest of the workflow practical: image-to-image uploads, batch generation, visible-image capture, and optional Gemini watermark cleanup.

## Why This Exists

The official Gemini API image path is not useful if you do not want to enable billing. The Gemini web app is useful, but driving it entirely through DOM automation is slower and more fragile than it needs to be. This repo packages the bridge that came out of that tension:

- Direct `CycleTLS` image requests first for fresh text-to-image jobs
- Playwright fallback for UI-shaped flows like image-to-image and attachment-heavy prompts
- A dedicated signed-in Chrome profile instead of pasted cookies
- MCP tools for state inspection, attachment control, visible-image saving, and watermark cleanup
- A Codex skill surface, not just a raw script dump

## What It Does

- Exposes a local stdio MCP server for Codex
- Attaches to a dedicated Chrome profile over CDP
- Uses Gemini's signed-in web session instead of the paid API path
- Supports `text -> image`, `image -> image`, multi-image batches, and controlled parallel starts
- Parses streamed direct responses incrementally and ranks returned image candidates
- Can remove the Gemini sparkle watermark from saved PNGs on request

## What It Does Not Do

- It does not import cookies or session tokens
- It does not bypass Gemini billing or quota rules
- It does not guarantee that Google will keep the same web endpoints or selectors
- It does not make unofficial web automation “stable” in the API sense

## Quickstart

### 1. Install dependencies

```powershell
npm install
```

### 2. Provide CycleTLS

Best path: use the parity fork and point the repo at it.

```powershell
$env:GEMINI_WEB_CYCLETLS_JS_PATH="E:\path\to\CycleTLS-Parity\dist\index.js"
$env:GEMINI_WEB_CYCLETLS_EXE_PATH="E:\path\to\CycleTLS-Parity\dist\index.exe"
```

Fallback behavior:

- If those env vars are not set, the MCP tries `vendor/CycleTLS-Parity/dist/...`
- If that is absent, it tries the standard `cycletls` package

### 3. Launch the dedicated Gemini profile

```powershell
npm run launch:profile
```

Sign in manually in the visible Chrome window and keep Gemini open.

### 4. Register the MCP server in Codex

```powershell
codex mcp add gemini-web-session --env GEMINI_WEB_CDP_URL=http://127.0.0.1:9340 -- node ".\scripts\gemini-web-mcp.mjs"
```

If the tool list does not refresh, restart Codex.

## Main Tools

- `check_status`: verify login state, prompt surface, and direct-template cache readiness
- `inspect_state`: get the MCP's diagnosis of the current Gemini state
- `ask_gemini`: text/chat through the signed-in web session
- `generate_image_ui`: direct-first image generation with UI fallback
- `list_attachments` / `clear_attachments`: manage image-to-image context
- `list_visible_images` / `save_visible_images`: save existing outputs without re-generating
- `detect_watermark_file` / `remove_watermark_file`: work with saved Gemini PNGs

## Direct vs UI

`generate_image_ui` accepts `transport`:

- `auto`: direct `CycleTLS` first, then Playwright fallback
- `direct`: direct only, fail if the direct path does not succeed
- `ui`: skip direct and force the UI path

The direct path is best for fresh text-to-image prompts. The UI path still matters for:

- image-to-image
- attachment reuse
- style picker interactions
- other flows that only exist in the browser surface

## Repo Layout

```text
assets/      hero image and repo visuals
agents/      Codex/OpenAI skill metadata
docs/        architecture and usage notes
examples/    copy-paste config snippets
references/  short source notes from the original exploration
scripts/     MCP server, launcher, and watermark utilities
SKILL.md     installable Codex skill instructions
```

## Installation As A Skill

If you want this repo to be a real Codex skill, place or symlink the repo under your Codex skills directory with the folder name `gemini-web-session`, then register the MCP command from this repo.

## Safety Notes

- Use a dedicated browser profile for Gemini
- Treat this as an unofficial bridge, not a supported API
- Keep sensitive local outputs out of the repo
- Ask the user to handle login, CAPTCHA, quota, or consent screens manually

## Docs

- [Architecture](./docs/architecture.md)
- [MCP Registration Example](./examples/codex-mcp-setup.md)
- [Skill Instructions](./SKILL.md)

## License

MIT
