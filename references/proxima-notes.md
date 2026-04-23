# Proxima-Inspired Notes

Local inspection of `Zen4-bit/Proxima` showed its Gemini provider is browser-session based:

- Electron `BrowserView` opens `https://gemini.google.com/app`.
- Gemini uses persistent partition `persist:gemini`.
- `gemini-engine.js` is injected into the Gemini page.
- The engine fetches `/faq` with browser credentials and extracts `SNlM0e` plus `cfb2h` tokens.
- It posts form data to `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`.
- It parses nested JSON/SSE-ish response payloads.
- File/image upload fallback uses clipboard-paste simulation into Gemini's UI.

This skill copies the safe architecture pattern, not the cookie-import path. Pasted Google cookies must not be used.

Limitations:

- Web endpoints are unofficial and can change.
- Login must be manual in the dedicated Chrome profile.
- Image generation through Gemini web UI is best-effort and may not be available for the signed-in account.
- If the web app blocks or asks for billing/quota/consent, stop and fall back to `pollinations-free-image`.
