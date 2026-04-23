# Gemini Web MCP

[![CI](https://github.com/minanagehsalalma/gemini-web-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/minanagehsalalma/gemini-web-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/minanagehsalalma/gemini-web-mcp)](./LICENSE)

Use a real Gemini web session from any MCP-compatible agent.

![Gemini Web MCP hero](./assets/hero.png)

`gemini-web-mcp` is an unofficial MCP server that turns a manually signed-in `gemini.google.com` browser session into a reusable tool for any agent or MCP client. It prefers direct `CycleTLS` transport for fresh text-to-image requests, falls back to Playwright when the browser UI is actually needed, and keeps the rest of the workflow productized instead of brittle: image-to-image uploads, batch generation, visible-image capture, session-aware state inspection, and optional Gemini watermark cleanup.

## Why This Exists

Gemini's web app is useful. The paid API path is not always the path people want. Pure DOM automation is also slower and more fragile than it needs to be.

This repo bridges that gap:

- Direct `CycleTLS` requests first for simple fresh generations
- Playwright fallback for browser-only flows like image-to-image and attachment-heavy prompting
- A dedicated signed-in Chrome profile instead of pasted cookies
- A real MCP surface that can be used by any compatible client, not just one agent runtime
- Operational tooling around the session: attachments, visible images, watermark cleanup, and diagnostics

## Positioning

- Category: unofficial Gemini web-session MCP bridge
- Audience: anyone building or using MCP-compatible agents
- Strength: direct-first transport with browser fallback, not browser automation only
- Boundary: manual login required, no cookie import, no billing bypass claims

## What You Get

- `ask_gemini` for text/chat through the signed-in web session
- `generate_image_ui` for direct-first image generation with UI fallback
- image-to-image via real browser uploads
- multi-image batches with concurrency and cooldown controls
- state-aware tooling such as `check_status`, `inspect_state`, `list_attachments`, and `clear_attachments`
- visible-image capture without re-generating outputs
- optional Gemini watermark detection and cleanup for saved PNGs

## Why It Feels Different

Most unofficial Gemini browser bridges either:

- stay trapped in fragile UI automation
- act like a one-off wrapper for a single client
- or skip the operational surfaces that matter once you use them repeatedly

`gemini-web-mcp` is built around a cleaner split:

- direct transport where it is actually reliable
- browser automation only when the UI is the source of truth
- one MCP surface usable from any compatible agent stack

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

### 4. Register the MCP server

Any stdio-capable MCP client can run the same Node entrypoint:

```powershell
node ".\scripts\gemini-web-mcp.mjs"
```

For a Codex CLI example, see [examples/codex-mcp-setup.md](./examples/codex-mcp-setup.md).

## Compatibility

This repo is designed for MCP-compatible clients in general.

Examples:

- Codex CLI
- Claude Desktop
- custom MCP agent runtimes
- other stdio-based MCP clients

The core value is the MCP server, not a Codex-only wrapper.

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
agents/      optional OpenAI/Codex skill metadata
docs/        architecture and usage notes
examples/    client and registration examples
references/  short source notes from the original exploration
scripts/     MCP server, launcher, and watermark utilities
SKILL.md     optional Codex skill instructions
```

## Optional Codex Skill

This repo includes a Codex skill because Codex is a useful MCP client, not because the project is Codex-only.

If you want the skill form, use [SKILL.md](./SKILL.md). If you only want the MCP server, the repo already stands on its own.

## Safety Notes

- Use a dedicated browser profile for Gemini
- Treat this as an unofficial bridge, not a supported API
- Keep sensitive local outputs out of the repo
- Ask the user to handle login, CAPTCHA, quota, or consent screens manually
- Do not add cookie-import flows

## Docs

- [Architecture](./docs/architecture.md)
- [Client Setup Example](./examples/codex-mcp-setup.md)
- [Optional Codex Skill](./SKILL.md)

## License

MIT
