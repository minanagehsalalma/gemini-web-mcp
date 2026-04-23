# Technical Deep Dive

This document explains how `gemini-web-mcp` works under the hood.

It is intentionally implementation-oriented. If you want the shorter system view, start with [architecture.md](./architecture.md).

## High-Level Shape

The repo is a local stdio MCP server with two execution paths behind one tool surface:

1. A direct request path for simple fresh text-to-image work
2. A browser automation path for UI-shaped flows

The direct path exists because the Gemini web app can often be driven more reliably by replaying the same authenticated web request shape than by clicking through the UI every time. The UI path still exists because some operations only make sense in the browser.

## Runtime Components

### `scripts/gemini-web-mcp.mjs`

This is the main MCP server.

It is responsible for:

- stdin/stdout JSON-RPC handling for MCP
- attaching to the existing Chrome session over CDP
- bootstrapping Gemini request tokens from the live browser session
- sending direct `CycleTLS` requests when eligible
- falling back to Playwright automation when needed
- detecting and cleaning Gemini watermarks
- saving generated outputs to disk

### `scripts/launch-gemini-profile.ps1`

This launches a dedicated Chrome profile with remote debugging enabled.

That gives the MCP a stable browser to attach to at:

- `http://127.0.0.1:9340` by default

The dedicated profile matters because it keeps Gemini login state isolated from other personal browsing.

### `scripts/detect-gemini-watermark.js`

This analyzes saved PNGs and tries to detect Gemini's sparkle watermark.

It returns:

- detection confidence
- cluster bounds
- likely placement
- optional debug overlays

### `scripts/remove-gemini-watermark.js`

This attempts to remove the watermark from saved PNGs and can overwrite the original file or write to a separate output path.

## MCP Layer

The server speaks plain stdio MCP.

At a practical level that means:

- the process reads JSON-RPC messages from `stdin`
- dispatches them to tool handlers
- writes MCP-compatible JSON results to `stdout`

The tool surface is declared in-process inside `gemini-web-mcp.mjs`, not generated from an external schema file.

Important tool groups:

- state tools: `check_status`, `inspect_state`
- text tool: `ask_gemini`
- image tools: `generate_image_ui`, `wait_for_image`
- output tools: `save_latest_image`, `save_visible_images`
- attachment tools: `list_attachments`, `clear_attachments`
- watermark tools: `detect_watermark_file`, `remove_watermark_file`

## Tool Options

This section lists the practical options available on each MCP tool.

### `open_gemini`

Options:

- none

Purpose:

- open `https://gemini.google.com/app` in the attached Chrome profile

### `check_status`

Options:

- none

Purpose:

- return the current URL, title, prompt availability, login state, direct-template cache state, visible-image count, attachment count, and diagnosis

### `inspect_state`

Options:

- none

Purpose:

- return a richer state diagnosis with recommendations and visible image context

### `list_attachments`

Options:

- none

Purpose:

- list the currently attached reference files in the visible Gemini composer

### `clear_attachments`

Options:

- none

Purpose:

- remove the currently attached reference files from the visible Gemini composer

### `list_visible_images`

Options:

- none

Purpose:

- list visible generated image candidates on the current Gemini page

### `ask_gemini`

Options:

- `message`
  Required text prompt sent through the injected Gemini web-session engine

Purpose:

- use Gemini for text/chat without relying on DOM typing

### `generate_image_ui`

Options:

- `prompt`
  Shared prompt for all generated items
- `prompts`
  Per-item prompt list; item-specific values override the shared `prompt`
- `referenceImagePaths`
  Shared local file paths for image-to-image work
- `referenceImagePathsByItem`
  Per-item reference-image batches; item-specific values override shared paths
- `preserveAttachments`
  Keep already attached files in the Gemini composer instead of clearing them
- `transport`
  `auto`, `direct`, or `ui`
- `count`
  Number of images/items to generate
- `concurrency`
  Maximum number of isolated Gemini tabs used for parallel work
- `cooldownMs`
  Stagger delay between request starts in multi-item runs
- `continueOnFailure`
  Continue later items even if an earlier one fails
- `outputPath`
  Output file path; supports `{index}` or `{n}` placeholders for multi-item runs
- `timeoutMs`
  Soft timeout used after Gemini is no longer in the `Creating your image...` state
- `hardTimeoutMs`
  Safety cap for genuinely stuck generations
- `freshChat`
  Force opening a fresh Gemini prompt surface
- `useImageTool`
  Try Gemini's image mode explicitly before prompt submission
- `removeGeminiWatermark`
  Run the bundled watermark remover on the saved PNG
- `watermarkOutputPath`
  Separate output path for the cleaned image
- `watermarkTimeoutMs`
  Timeout for watermark cleanup work
- `verifyWatermarkRemoval`
  Run before/after verification when cleaning a watermark

Purpose:

- perform direct-first image generation, optionally with reference images, batching, concurrency, and watermark post-processing

### `wait_for_image`

Options:

- `outputPath`
  Where to save the generated image
- `timeoutMs`
  Soft timeout once Gemini is no longer actively creating
- `hardTimeoutMs`
  Safety cap for a stuck generation
- `baselineImageCount`
  Expected visible-image count before the new image appears
- `baselineSignatures`
  Previously known image signatures used to detect the new result
- `removeGeminiWatermark`
  Run the bundled watermark remover on the saved PNG
- `watermarkOutputPath`
  Separate output path for the cleaned image
- `watermarkTimeoutMs`
  Timeout for watermark cleanup work
- `verifyWatermarkRemoval`
  Run before/after verification when cleaning a watermark

Purpose:

- keep waiting on the current Gemini page and save the next completed result without sending a new prompt

### `save_visible_images`

Options:

- `outputPath`
  Base output path; multi-save flows can use numbered suffixes
- `all`
  Save all visible candidates
- `count`
  Save the first `n` visible candidates
- `imageIndex`
  Save one explicit candidate index
- `imageIndices`
  Save a specific list of candidate indices
- `removeGeminiWatermark`
  Run watermark cleanup on saved PNGs
- `watermarkOutputPath`
  Separate output path for cleaned files
- `watermarkTimeoutMs`
  Timeout for watermark cleanup work
- `verifyWatermarkRemoval`
  Run before/after verification when cleaning a watermark

Purpose:

- save one or more already visible Gemini image candidates from the current page

### `save_latest_image`

Options:

- `outputPath`
  Where to save the latest visible image
- `removeGeminiWatermark`
  Run watermark cleanup on the saved PNG
- `watermarkOutputPath`
  Separate output path for the cleaned image
- `watermarkTimeoutMs`
  Timeout for watermark cleanup work
- `verifyWatermarkRemoval`
  Run before/after verification when cleaning a watermark

Purpose:

- save the latest visible generated image candidate from the current page

### `detect_watermark_file`

Options:

- `inputPath`
  Required path to the PNG file to inspect
- `debugOutputPath`
  Optional path for a debug overlay image

Purpose:

- analyze an existing PNG for Gemini's watermark and optionally write a diagnostic overlay

### `remove_watermark_file`

Options:

- `inputPath`
  Required path to the PNG file to clean
- `outputPath`
  Optional destination path; if omitted, the cleaned output overwrites the source flow
- `watermarkTimeoutMs`
  Timeout for the cleanup command
- `verifyWatermarkRemoval`
  Run before/after verification when cleaning a watermark

Purpose:

- apply the bundled watermark remover to an already saved PNG

## Browser Attachment Model

The MCP does not launch a fresh browser context for every request.

Instead it:

1. Connects to an already running Chrome instance over CDP
2. Reuses the first available browser context
3. Finds or opens a Gemini page inside that context

This matters because Gemini auth lives in the real browser profile, not inside the MCP.

There is no cookie import path by design.

## Why Two Paths Exist

### Direct Path

Use when all of these are true:

- the request is a fresh text-to-image prompt
- no reference image uploads are needed
- no attachment reuse is required
- Gemini's normal web request shape can be replayed directly

Direct mode is faster because it avoids:

- DOM prompt filling
- button clicking
- repeated UI waits
- image polling through the page surface

### UI Path

Use when any of these are true:

- image-to-image is required
- attachments must be uploaded or preserved
- the style picker or another browser-only surface matters
- the direct request path is unavailable or failed

The UI path is slower, but it can model the exact browser interaction state that Gemini exposes.

## Direct Path Internals

The direct path is not a hardcoded Gemini API wrapper.

It works by replaying Gemini's own web request shape using the authenticated browser session as the source of truth.

### Step 1: Template Capture

The first successful UI-side generation can capture a real Gemini `StreamGenerate` request template from live browser traffic.

The MCP stores a cache file at:

- `scripts/cache/direct-image-template.json`

That cache holds:

- the inner request structure
- selected request headers from the live browser request

This is what lets later direct runs look like the real web app instead of an invented request body.

### Step 2: Bootstrap From The Live Page

Before sending a direct request, the MCP reads fresh session values from the signed-in page.

Important values include:

- `f.sid`
- request bootstrap tokens such as `at` and `bl`
- user agent
- language and locale
- current cookies
- current Gemini referer URL

Some of those values come from page state and some come from fetching Gemini's FAQ page through the same authenticated session.

### Step 3: Build A Browser-Like Request

The MCP then builds a direct `StreamGenerate` POST request with:

- the cached Gemini request template
- the current prompt injected into the inner request structure
- browser-like headers
- current cookies
- browser-consistent locale values

It uses `CycleTLS` for this step so the request looks closer to a real browser session than a basic HTTP client would.

### Step 4: Read The Stream Incrementally

The direct path does not wait for the entire response body before deciding whether the request succeeded.

Instead it reads the streamed response incrementally and watches for:

- `Creating your image...`
- actual returned downloadable image URLs
- explicit Gemini-side error codes

This matters because the response can remain open while the useful image URLs already exist.

### Step 5: Candidate Parsing And Ranking

If multiple image candidates are returned, the MCP does not blindly trust URL index `0`.

It parses structured candidate metadata when available and ranks candidates using signals like:

- MIME type
- dimensions
- approximate byte size
- candidate index

This usually prefers the better PNG over a lower-value JPEG alternative when both exist.

### Step 6: Download With The Same Browser-Like Transport

The returned `gg-dl` image URL is downloaded through `CycleTLS`, not plain `fetch`, because those URLs can reject a simpler download path.

That preserves:

- cookies
- user agent
- browser-like image request headers

### Step 7: Optional Watermark Removal

If requested, the saved PNG is passed through:

- watermark detection
- watermark removal
- optional verification before/after

The MCP returns both the main image metadata and the watermark operation metadata.

## Direct Retry Strategy

The direct path includes a small but deliberate retry model.

If the first direct request looks suspicious, the MCP can:

1. Refresh the Gemini page surface
2. Re-bootstrap the session values
3. Retry once with fresh bootstrap state

This is meant to recover from stale request bootstrap state, not to brute-force Gemini.

The retry is intentionally narrow because repeated blind retries tend to make browser-session automation worse, not better.

## UI Path Internals

When the browser path is needed, the MCP switches to Playwright over CDP.

### State Inspection

Before doing expensive work, the MCP inspects the current Gemini page and classifies it into states such as:

- manual login required
- ready for prompt
- ready with attachments
- image generation in progress
- generated image visible
- network error

This reduces blind retries and lets the tool return a useful diagnosis rather than just failing vaguely.

### Attachment Handling

For image-to-image workflows, the MCP can:

- upload local files through Gemini's own file UI
- detect whether old files are still attached
- clear stale attachments by default
- preserve them intentionally when requested

This is important because stale attachments can silently contaminate later prompts.

### Prompt Submission

The MCP fills the visible Gemini composer, not hidden helper inputs.

It then:

- submits the prompt
- checks whether it actually left the composer
- optionally retries the send click once if the prompt still appears stuck

### Wait Policy

The browser path is designed to avoid the common bad behavior of re-triggering Gemini while it is already working.

If the page says:

- `Creating your image...`

the MCP keeps waiting.

It does not start a new chat or resubmit the prompt in that state.

### Image Capture

When a result appears, the MCP tries to save the generated image as the real image content, not a rough screenshot of the whole page.

Depending on the page state, that can mean:

- direct extraction from the visible image/canvas element
- saving one or more visible image candidates by explicit selection

## Multi-Image Behavior

`generate_image_ui` supports `count`, `concurrency`, and `cooldownMs`.

The model here is:

- never parallelize multiple jobs inside one Gemini page
- when concurrency is requested, use isolated tabs
- stagger request starts with a cooldown gate

That tries to reduce self-inflicted collisions and limit-triggering behavior.

For direct-eligible work, the repo is moving toward a cleaner direct-first batching model, but the current system still keeps the browser-aware controls available because Gemini session state can still matter between jobs.

## Watermark Flow

Watermark support is intentionally split into three layers:

1. Detect the watermark
2. Remove the watermark
3. Verify whether confidence improved

This is better than pretending cleanup always succeeded.

The returned metadata can include:

- confidence before
- confidence after
- confidence delta
- placement
- final output size

## Important Environment Variables

- `GEMINI_WEB_CDP_URL`
  Chrome CDP endpoint
- `GEMINI_WEB_CYCLETLS_JS_PATH`
  Path to the preferred [CycleTLS-Parity](https://github.com/minanagehsalalma/CycleTLS-Parity) JS module
- `GEMINI_WEB_CYCLETLS_EXE_PATH`
  Path to the preferred [CycleTLS-Parity](https://github.com/minanagehsalalma/CycleTLS-Parity) executable
- `GEMINI_WEB_PLAYWRIGHT_MODULE`
  Optional explicit Playwright module resolution override
- `GEMINI_WEB_CDP_PORT`
  Port used by the launcher script
- `GEMINI_WEB_PROFILE_NAME`
  Dedicated Chrome profile name used by the launcher

## Failure Modes By Design

This project is explicit about what it cannot safely guarantee.

Expected failure classes include:

- Gemini login or consent screens
- Gemini-side image errors such as error `13`
- stale bootstrap data
- UI changes in Gemini's DOM
- missing direct request template cache
- browser/network issues in the CDP-attached session

The MCP tries to make those failures legible so that the caller can choose whether to:

- retry
- refresh the session
- switch transport
- or stop and ask the user to intervene

## Why This Repo Is Still Unofficial

Even though the direct path is more sophisticated than simple DOM automation, the project still depends on Gemini's web product shape.

That means:

- selectors can change
- bootstrap fields can change
- response structure can change
- direct replayable request patterns can change

So the right mental model is:

- pragmatic bridge
- not stable vendor API

## If You Want To Extend It

The highest-leverage extension areas are:

- better direct batching for fully direct-eligible requests
- richer visual proof and demo tooling in the repo itself
- more client-specific MCP config examples
- stronger CI checks around docs and non-live code paths
- cleaner packaging for vendoring `CycleTLS-Parity`

If you are changing behavior, validate both:

- direct transport
- UI fallback

because this repo is fundamentally a transport split, not one single mechanism.
