---
name: gemini-web-session
description: Use when the user wants a Proxima-style Gemini web-session MCP bridge without API keys or cookie import. Attaches to a dedicated manually signed-in Chrome profile for gemini.google.com, injects a web-session engine for text/chat, and can best-effort drive the Gemini UI for image prompts. Do not use to import pasted cookies, bypass Google login, or claim stable API support.
---

# Gemini Web Session

## Purpose

This skill replicates the safe part of Proxima's Gemini approach: a local MCP server attaches to a signed-in Gemini web session and uses the browser's own authenticated context. It avoids official Gemini API billing, but it depends on the user's normal Gemini web access and can break if Google changes the web app.

Never import pasted Google cookies. The user must sign in manually in the dedicated Chrome profile.

## Setup

Launch a dedicated browser profile:

```powershell
& ".\scripts\launch-gemini-profile.ps1"
```

Sign in manually in that visible Chrome window, open Gemini, and keep it open.

Register the MCP server:

```powershell
codex mcp add gemini-web-session --env GEMINI_WEB_CDP_URL=http://127.0.0.1:9340 -- node ".\scripts\gemini-web-mcp.mjs"
```

Codex may need a restart before new MCP tools appear.

For best direct-request fidelity, also provide the CycleTLS-Parity fork:

```powershell
$env:GEMINI_WEB_CYCLETLS_JS_PATH="E:\path\to\CycleTLS-Parity\dist\index.js"
$env:GEMINI_WEB_CYCLETLS_EXE_PATH="E:\path\to\CycleTLS-Parity\dist\index.exe"
```

## Tools

- `open_gemini`: open `https://gemini.google.com/app` in the dedicated profile.
- `check_status`: report URL/title and whether login or prompt surface is visible.
- `check_status`: also reports whether a cached direct CycleTLS image template is currently available.
- `inspect_state`: report the current Gemini UI state with diagnosis, confidence, recommendation, and visible image candidates.
- `list_attachments`: list the currently attached reference files in the visible Gemini composer.
- `clear_attachments`: remove the currently attached reference files from the visible Gemini composer.
- `list_visible_images`: list the current visible Gemini-generated image candidates with candidate ordering.
- `ask_gemini`: use Gemini's signed-in web session to send a text prompt through the web backend.
- `generate_image_ui`: select Gemini's image mode by default, optionally attach one or more reference images, type an image prompt into the Gemini UI, and save one or more resulting images.
- `wait_for_image`: wait for the current Gemini page to finish image generation and save the result without submitting a new prompt.
- `save_visible_images`: save one or more visible Gemini image candidates by latest order, explicit candidate index, or all visible candidates.
- `save_latest_image`: save the latest visible generated image from the current Gemini page.
- `detect_watermark_file`: analyze an existing PNG for Gemini's sparkle watermark and optionally write a debug overlay.
- `remove_watermark_file`: run the bundled watermark remover on an existing saved PNG.

Image-saving tools accept `removeGeminiWatermark: true` to run the bundled `scripts/remove-gemini-watermark.js` on the saved PNG. By default this overwrites the saved `outputPath` with the cleaned image; pass `watermarkOutputPath` to write a separate cleaned file. Cleanup also verifies before/after detector confidence unless `verifyWatermarkRemoval=false`.

`generate_image_ui` now accepts `transport`:
- `auto`: prefer a direct Gemini image request through CycleTLS-Parity first, then fall back to Playwright UI automation when needed.
- `direct`: use only the direct CycleTLS path and fail instead of falling back.
- `ui`: force the old Playwright UI path.

`generate_image_ui` accepts `referenceImagePaths` for shared image-to-image workflows, `referenceImagePathsByItem` for per-item reference batches, `prompt` for one shared prompt, `prompts` for per-item prompt variants, `preserveAttachments` when you intentionally want to reuse attachments already sitting in the composer, `count` for multi-image creation, and `concurrency` plus `cooldownMs` for controlled parallel work. Parallel mode uses isolated Gemini tabs in the same signed-in browser context and staggers request starts with a cooldown gate. For `count > 1`, output names get a padded numeric suffix unless `outputPath` or `watermarkOutputPath` contains `{index}` or `{n}`.

## Operating Rules

- Use `check_status` before sending prompts.
- Use `inspect_state` when deciding what to do next; prefer its diagnosis/recommendation over blind retries.
- Prefer `list_attachments` or `inspect_state` before image-to-image continuation if you are not sure what files are already attached.
- Use `list_visible_images` when Gemini shows several outputs and you want to choose what to save instead of assuming the latest image is the right one.
- If login, CAPTCHA, account, quota, billing, or consent screens appear, stop and ask the user to handle them in the visible browser.
- Prefer `ask_gemini` for text/chat. It is closer to Proxima's engine path and does not rely on brittle DOM typing.
- Prefer `generate_image_ui` with the default `transport=auto`; for simple fresh text-to-image requests it will try CycleTLS first, reuse the cached request shape from a real Gemini UI request, parse the streamed response incrementally, rank returned image candidates instead of blindly trusting the first URL, refresh bootstrap state once on suspicious direct failures, and only use Playwright UI when the direct request path is unavailable or unusable.
- Use `generate_image_ui` only as best-effort image generation. Gemini web UI selectors and output structure can change.
- The direct CycleTLS path currently targets simple fresh text-to-image requests. Image-to-image, attachment reuse, and other UI-dependent flows still fall back to Playwright.
- Prefer the default fresh-chat behavior for `generate_image_ui`; use `freshChat=false` only when intentionally continuing the current Gemini conversation.
- Prefer the default `useImageTool=true` for image prompts. If Gemini opens only the style picker and does not submit, retry with `useImageTool=false`.
- For multi-image generation, use `concurrency` only with isolated tabs and a non-trivial `cooldownMs`; do not try to parallelize multiple Gemini requests inside one page.
- For image-to-image, pass absolute local file paths in `referenceImagePaths`; the MCP uploads them through Gemini's own file menu and waits for attachment chips before submitting.
- For batched variation work, pair `prompts` with `referenceImagePathsByItem`; item-specific values win over shared `prompt` and shared `referenceImagePaths`.
- By default `generate_image_ui` clears stale attached files before composing the next request. Use `preserveAttachments=true` only when you intentionally want to keep the current attached files.
- Use `clear_attachments` to recover from a polluted composer instead of manually guessing whether old reference files are still influencing the next run.
- For `count > 1`, inspect `plannedOutputPaths`, `outputPaths`, and per-item `results`; one Gemini item can fail while later items succeed if `continueOnFailure=true`.
- Use `save_visible_images` with `all=true`, `count`, `imageIndex`, or `imageIndices` when the current Gemini page already has several useful candidates and you want explicit control over which files are written.
- If `check_status` reports `directImageTemplateCached: false`, the first UI fallback generation can refresh the cached direct-request template and browser header snapshot for later `transport=auto` runs.
- Do not retry or start another chat while Gemini says `Creating your image...`; wait for that state to disappear. `timeoutMs` applies after Gemini is no longer creating, and `hardTimeoutMs` is only a safety cap for indefinitely stuck generations.
- Use `removeGeminiWatermark: true` only when the user requests a cleaned saved output; if it fails, preserve the error details instead of pretending the image was cleaned.
- Use `detect_watermark_file` when you need evidence before/after cleanup; compare detector `confidence` and `confidenceDelta` rather than assuming the visual patch succeeded.
- If image generation fails, keep `pollinations-free-image` as the reliable no-key fallback.

## What This Does Not Do

- It does not use the Gemini API key.
- It does not bypass billing for API-only models.
- It does not import cookies or session tokens.
- It does not guarantee image generation availability; it only uses whatever the signed-in Gemini web account can access.
