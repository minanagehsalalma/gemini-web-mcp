$ErrorActionPreference = "Stop"

$Port = if ($env:GEMINI_WEB_CDP_PORT) { [int]$env:GEMINI_WEB_CDP_PORT } else { 9340 }
$ProfileName = if ($env:GEMINI_WEB_PROFILE_NAME) { $env:GEMINI_WEB_PROFILE_NAME } else { "GeminiWebMCPProfile" }

$chromeCandidates = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) {
  throw "Chrome executable not found."
}

$profile = Join-Path $env:LOCALAPPDATA $ProfileName
New-Item -ItemType Directory -Force -Path $profile | Out-Null

$args = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$profile",
  "--profile-directory=Default",
  "--disable-quic",
  "--enable-features=DnsOverHttps",
  "--dns-over-https-servers=https://dns.google/dns-query",
  "--no-first-run",
  "--new-window",
  "https://gemini.google.com/app"
)

Start-Process -FilePath $chrome -ArgumentList $args

Write-Host "Launched Chrome for Gemini Web Session."
Write-Host "Profile: $profile"
Write-Host "CDP: http://127.0.0.1:$Port"
Write-Host "Sign in manually in the visible browser, open Gemini, then keep it open."
