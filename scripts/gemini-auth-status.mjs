/** Classify the minimal /faq bootstrap signals without returning auth values. */
export function classifyGeminiAuthBootstrap({ httpOk, hasAuthUser, hasLoginMarker, hasSnlM0e, hasCfb2h }) {
  if (!httpOk) {
    return { state: "unavailable", reason: "bootstrap_fetch_failed" };
  }

  if (!hasAuthUser) {
    return hasLoginMarker
      ? { state: "login_required", reason: "google_login_page" }
      : { state: "unavailable", reason: "auth_marker_missing" };
  }

  if (!hasSnlM0e || !hasCfb2h) {
    return { state: "unavailable", reason: "session_tokens_missing" };
  }

  return { state: "authenticated", reason: "session_bootstrap_ready" };
}
