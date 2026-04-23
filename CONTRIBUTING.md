# Contributing

## Scope

This repo is for improving the Gemini web-session MCP bridge, not for bypassing login or importing cookies.

## Ground Rules

- Do not add cookie-import workflows
- Keep the direct transport honest about its limits
- Prefer deterministic-first behavior before adding more UI retries
- Preserve manual login as the only auth path
- Document breaking behavior changes in the README or architecture notes

## Dev Notes

- Run `npm install`
- Keep a dedicated Gemini Chrome profile open
- Use `npm run check` after MCP edits
- If you touch direct transport code, verify both `direct` and `auto` behavior against a live signed-in session
