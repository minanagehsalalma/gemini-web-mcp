# Architecture

## Overview

`Gemini Web MCP` has two execution modes behind one MCP surface.

### Direct Path

Used for simple fresh text-to-image requests.

1. Read current Gemini bootstrap data from the signed-in browser session
2. Reuse a cached request template captured from a real Gemini UI request
3. Send the image request through `CycleTLS`
4. Parse the streamed response incrementally
5. Rank returned image candidates
6. Download the preferred candidate through the same browser-like transport

This path is faster and avoids launching a new Playwright interaction loop for every request.

### UI Path

Used when the request depends on browser-only behavior.

1. Attach to the dedicated signed-in Chrome profile over CDP
2. Inspect current Gemini state
3. Clear or preserve attachments intentionally
4. Upload reference images when needed
5. Fill the composer, submit, and wait for image creation to finish
6. Save the newest visible output or any explicitly selected visible image

This path is slower, but it is required for image-to-image and other UI-shaped flows.

## Core Files

- `scripts/gemini-web-mcp.mjs`
  Main MCP server and transport orchestration
- `scripts/launch-gemini-profile.ps1`
  Starts a dedicated Chrome profile with CDP enabled
- `scripts/detect-gemini-watermark.js`
  Detects the Gemini sparkle watermark in PNG outputs
- `scripts/remove-gemini-watermark.js`
  Removes the watermark when requested

## Runtime Assumptions

- A manually signed-in Chrome session is required
- `CycleTLS-Parity` is preferred for direct transport fidelity
- Playwright is used as a stateful fallback, not the first resort
- The repo keeps no cookie import path on purpose

## Failure Model

The MCP is intentionally explicit about failure types:

- login or consent required
- Gemini still creating an image
- direct request returned no usable URLs
- direct image download failed across all ranked candidates
- UI fallback did not produce a visible image before timeout

This makes it easier to decide whether to retry, refresh bootstrap state, or switch transports.
