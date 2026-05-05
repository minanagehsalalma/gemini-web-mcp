#!/usr/bin/env node
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import net from "node:net";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { existsSync } = require("node:fs");
const packageJson = require("../package.json");
const { analyzeWatermark, writeDebugOverlay } = require("./detect-gemini-watermark.js");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = {
  name: packageJson.name || "gemini-web-mcp",
  version: packageJson.version || "0.0.0",
};

function requireFirst(candidates, label) {
  const failures = [];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      return require(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${label} could not be loaded from any known path.\n${failures.join("\n")}`);
}

const playwrightModule = requireFirst([
  process.env.GEMINI_WEB_PLAYWRIGHT_MODULE,
  "playwright",
  "playwright-core",
], "Playwright");
const { chromium } = playwrightModule;

const cycleTlsModulePath = [
  process.env.GEMINI_WEB_CYCLETLS_JS_PATH,
  resolve(SCRIPT_DIR, "..", "vendor", "CycleTLS-Parity", "dist", "index.js"),
  "cycletls",
].find((candidate) => candidate && (candidate === "cycletls" || existsSync(candidate)));
const initCycleTLSModule = requireFirst([
  cycleTlsModulePath,
], "CycleTLS");
const initCycleTLS = initCycleTLSModule.default || initCycleTLSModule;

const CDP_URL = process.env.GEMINI_WEB_CDP_URL || "http://127.0.0.1:9340";
const GEMINI_URL = "https://gemini.google.com/app";
const WATERMARK_REMOVER_PATH = resolve(SCRIPT_DIR, "remove-gemini-watermark.js");
const CYCLETLS_EXE_PATH = [
  process.env.GEMINI_WEB_CYCLETLS_EXE_PATH,
  resolve(SCRIPT_DIR, "..", "vendor", "CycleTLS-Parity", "dist", "index.exe"),
].find((candidate) => candidate && existsSync(candidate));
const DIRECT_IMAGE_TEMPLATE_CACHE_PATH = resolve(SCRIPT_DIR, "cache", "direct-image-template.json");
const DIRECT_REQUEST_HEADER_ORDER = [
  "accept",
  "accept-language",
  "content-type",
  "origin",
  "referer",
  "priority",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "x-same-domain",
];
let buffer = "";
let cycleTlsClientPromise = null;
let directImageTemplateMemory = undefined;
const pendingMessageTasks = new Set();

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function ok(id, content) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }] } });
}

function fail(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asNestedStringArrays(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asStringArray(item));
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asTransport(value) {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "direct" || normalized === "ui") return normalized;
  return "auto";
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close(() => {
        if (!port) rejectPromise(new Error("Could not allocate a local port for CycleTLS."));
        else resolvePromise(port);
      });
    });
  });
}

async function getCycleTlsClient() {
  if (!cycleTlsClientPromise) {
    cycleTlsClientPromise = (async () => {
      const port = await getFreePort();
      const initOptions = {
        port,
        timeout: 180000,
        autoExit: false,
      };
      if (CYCLETLS_EXE_PATH) initOptions.executablePath = CYCLETLS_EXE_PATH;
      return await initCycleTLS(initOptions);
    })();
  }
  return await cycleTlsClientPromise;
}

async function shutdownCycleTlsClient() {
  if (!cycleTlsClientPromise) return;
  const current = cycleTlsClientPromise;
  cycleTlsClientPromise = null;
  const client = await current.catch(() => null);
  if (client && typeof client.exit === "function") {
    await client.exit().catch(() => {});
  }
}

async function loadDirectImageTemplateCache() {
  if (directImageTemplateMemory !== undefined) return directImageTemplateMemory;
  try {
    directImageTemplateMemory = JSON.parse(await readFile(DIRECT_IMAGE_TEMPLATE_CACHE_PATH, "utf8"));
  } catch {
    directImageTemplateMemory = null;
  }
  return directImageTemplateMemory;
}

async function saveDirectImageTemplateCache(template) {
  directImageTemplateMemory = template;
  await mkdir(dirname(DIRECT_IMAGE_TEMPLATE_CACHE_PATH), { recursive: true });
  await writeFile(DIRECT_IMAGE_TEMPLATE_CACHE_PATH, JSON.stringify(template, null, 2), "utf8");
  return template;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function parseDirectImageTemplateFromPostData(postData) {
  const form = new URLSearchParams(postData || "");
  const fReq = form.get("f.req");
  if (!fReq) return null;
  const outer = JSON.parse(fReq);
  const inner = JSON.parse(outer?.[1]);
  if (!Array.isArray(inner) || !Array.isArray(inner[0])) return null;
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    innerRequest: inner,
  };
}

function normalizeHeaderName(name) {
  return String(name || "").trim().toLowerCase();
}

function buildAcceptLanguageHeader(localeInfo) {
  const raw = [];
  for (const item of Array.isArray(localeInfo?.languages) ? localeInfo.languages : []) {
    if (typeof item === "string" && item.trim()) raw.push(item.trim());
  }
  if (typeof localeInfo?.language === "string" && localeInfo.language.trim()) raw.unshift(localeInfo.language.trim());
  const unique = [...new Set(raw)].slice(0, 4);
  if (!unique.length) return "en-US,en;q=0.9";
  return unique.map((value, index) => index === 0 ? value : `${value};q=${Math.max(0.1, 1 - (index * 0.1)).toFixed(1)}`).join(",");
}

function extractDirectTemplateHeaderEntries(headersInput) {
  const allowed = new Set(DIRECT_REQUEST_HEADER_ORDER);
  const entries = [];
  const input = Array.isArray(headersInput)
    ? headersInput
    : Object.entries(headersInput || {}).map(([name, value]) => ({ name, value }));
  for (const item of input) {
    const name = normalizeHeaderName(item?.name);
    if (!allowed.has(name)) continue;
    const value = Array.isArray(item?.value) ? item.value[0] : item?.value;
    if (typeof value !== "string" || !value.trim()) continue;
    entries.push([name, value.trim()]);
  }
  return entries;
}

function buildDirectImagePostData(template, prompt, at) {
  const inner = cloneJson(template?.innerRequest);
  if (!Array.isArray(inner) || !Array.isArray(inner[0])) throw new Error("Cached direct image template is invalid.");
  inner[0][0] = prompt;
  const outer = [null, JSON.stringify(inner)];
  return new URLSearchParams({
    "f.req": JSON.stringify(outer),
    at,
  }).toString();
}

function parseDirectImageUrls(raw) {
  const text = String(raw || "");
  const escapedMatches = text.match(/https:\\\/\\\/lh3\.googleusercontent\.com\\\/gg-dl\\\/[^\\"]+/g) || [];
  const plainMatches = text.match(/https:\/\/lh3\.googleusercontent\.com\/gg-dl\/[^\s"\\]+/g) || [];
  return [...new Set([...escapedMatches, ...plainMatches].map((item) => item.replace(/\\u003d/g, "=").replace(/\\\//g, "/")))];
}

function parseDirectImageCandidates(raw) {
  const normalized = String(raw || "")
    .replace(/\\u003d/g, "=")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, "\"");
  const candidates = [];
  const candidatePattern = /\[null,1,"([^"]+)","(https:\/\/lh3\.googleusercontent\.com\/gg-dl\/[^"]+)",null,"([^"]*)",null,null,\d+,\[(\d+),(\d+)\],null,"(image\/[^"]+)",null,null,null,\[(\d+),(\d+),(\d+)\]\]/g;
  let match;
  while ((match = candidatePattern.exec(normalized))) {
    const [, filename, url, token, createdAtSec, createdAtNs, mimeType, width, height, byteSize] = match;
    const candidateIndex = candidates.length;
    candidates.push({
      candidateIndex,
      filename,
      url,
      token,
      mimeType,
      width: Number.parseInt(width, 10) || null,
      height: Number.parseInt(height, 10) || null,
      byteSize: Number.parseInt(byteSize, 10) || null,
      createdAtSec: Number.parseInt(createdAtSec, 10) || null,
      createdAtNs: Number.parseInt(createdAtNs, 10) || null,
    });
  }
  return candidates;
}

function scoreDirectImageCandidate(candidate) {
  let score = 0;
  if (candidate?.mimeType === "image/png") score += 30;
  else if (candidate?.mimeType === "image/webp") score += 20;
  else if (candidate?.mimeType === "image/jpeg") score += 15;
  const width = Number(candidate?.width) || 0;
  const height = Number(candidate?.height) || 0;
  const shortSide = Math.min(width || 0, height || 0);
  const longSide = Math.max(width || 0, height || 0);
  if (shortSide >= 1024) score += 20;
  else if (shortSide >= 768) score += 12;
  else if (shortSide >= 512) score += 6;
  score += Math.min(20, Math.round((width * height) / 250000));
  score += Math.min(15, Math.round((Number(candidate?.byteSize) || 0) / 150000));
  score += Math.min(5, Math.round(longSide / 512));
  score -= (Number(candidate?.candidateIndex) || 0) * 2;
  return score;
}

function rankDirectImageCandidates(candidates = [], fallbackUrls = []) {
  const base = Array.isArray(candidates) && candidates.length
    ? candidates.map((candidate) => ({
      ...candidate,
      score: scoreDirectImageCandidate(candidate),
      source: "structured",
    }))
    : (Array.isArray(fallbackUrls) ? fallbackUrls : parseDirectImageUrls(fallbackUrls)).map((url, candidateIndex) => ({
      candidateIndex,
      url,
      mimeType: null,
      width: null,
      height: null,
      byteSize: null,
      filename: null,
      score: 100 - (candidateIndex * 2),
      source: "url",
    }));
  return [...base].sort((left, right) => right.score - left.score);
}

function summarizeDirectImageCandidates(candidates = []) {
  return candidates.slice(0, 5).map((candidate) => ({
    candidateIndex: candidate.candidateIndex,
    filename: candidate.filename || null,
    mimeType: candidate.mimeType || null,
    width: candidate.width || null,
    height: candidate.height || null,
    byteSize: candidate.byteSize || null,
    score: candidate.score,
    source: candidate.source || null,
  }));
}

function parseDirectImageResponse(raw) {
  const body = String(raw || "");
  const candidates = parseDirectImageCandidates(body);
  const imageUrls = candidates.length ? candidates.map((candidate) => candidate.url) : parseDirectImageUrls(body);
  const creating = /Creating your image/i.test(body);
  const errorMatch = body.match(/\[\[(?:.|\n)*?\[null,null,null,null,null,\[(\d+)\]\]\]/);
  const responseIdMatch = body.match(/r_[a-z0-9]+/i);
  const conversationIdMatch = body.match(/c_[a-z0-9]+/i);
  return {
    candidates,
    imageUrls,
    isCreatingImage: creating,
    errorCode: errorMatch ? Number.parseInt(errorMatch[1], 10) : null,
    responseId: responseIdMatch?.[0] || null,
    conversationId: conversationIdMatch?.[0] || null,
    rawLength: body.length,
    rawPreview: body.slice(0, 4000),
  };
}

async function readDirectImageStream(response, options = {}) {
  const startedAt = Number.isFinite(Number(options.startedAt)) ? Number(options.startedAt) : Date.now();
  const hardTimeoutMs = Number.isFinite(Number(options.hardTimeoutMs)) ? Number(options.hardTimeoutMs) : 1800000;
  const stream = response?.data;
  if (!stream || typeof stream.on !== "function") {
    const parsed = parseDirectImageResponse(response?.data);
    return {
      parsed,
      completion: parsed.imageUrls.length ? "image_url_detected" : "buffered_response",
      firstChunkMs: null,
      completedMs: Date.now() - startedAt,
      ended: true,
      timedOut: false,
    };
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    let raw = "";
    let firstChunkMs = null;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };

    const finalize = (completion, parsed, control = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (control.destroy !== false && typeof stream.destroy === "function" && !stream.destroyed) {
        stream.destroy();
      }
      resolvePromise({
        parsed,
        completion,
        firstChunkMs,
        completedMs: Date.now() - startedAt,
        ended: completion === "stream_end",
        timedOut: completion === "stream_timeout",
      });
    };

    const onData = (chunk) => {
      if (firstChunkMs == null) firstChunkMs = Date.now() - startedAt;
      raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const parsed = parseDirectImageResponse(raw);
      if (parsed.imageUrls.length) {
        finalize("image_url_detected", parsed);
        return;
      }
      if (parsed.errorCode != null) {
        finalize("error_code_detected", parsed);
      }
    };

    const onEnd = () => finalize("stream_end", parseDirectImageResponse(raw), { destroy: false });
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };

    timer = setTimeout(() => finalize("stream_timeout", parseDirectImageResponse(raw)), hardTimeoutMs);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

function buildDirectRequestProfile(template, bootstrap) {
  const headerMap = new Map();
  for (const [name, value] of extractDirectTemplateHeaderEntries(template?.headerEntries || [])) {
    headerMap.set(name, value);
  }
  if (!headerMap.has("accept")) headerMap.set("accept", "*/*");
  if (!headerMap.has("accept-language")) headerMap.set("accept-language", bootstrap.acceptLanguage || "en-US,en;q=0.9");
  if (!headerMap.has("content-type")) headerMap.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  headerMap.set("origin", "https://gemini.google.com");
  headerMap.set("referer", bootstrap.referer);
  if (!headerMap.has("sec-fetch-dest")) headerMap.set("sec-fetch-dest", "empty");
  if (!headerMap.has("sec-fetch-mode")) headerMap.set("sec-fetch-mode", "cors");
  if (!headerMap.has("sec-fetch-site")) headerMap.set("sec-fetch-site", "same-origin");
  if (!headerMap.has("x-same-domain")) headerMap.set("x-same-domain", "1");

  const capturedOrder = extractDirectTemplateHeaderEntries(template?.headerEntries || []).map(([name]) => name);
  const headerOrder = [];
  for (const name of [...capturedOrder, ...DIRECT_REQUEST_HEADER_ORDER]) {
    if (!headerMap.has(name) || headerOrder.includes(name)) continue;
    headerOrder.push(name);
  }

  return {
    headers: Object.fromEntries(headerMap.entries()),
    headerOrder,
  };
}

async function downloadDirectImage(url, outputPath, options = {}) {
  await mkdir(dirname(outputPath), { recursive: true });
  if (options.cookies || options.userAgent) {
    const client = await getCycleTlsClient();
    const response = await client(url, {
      cookies: options.cookies || {},
      userAgent: options.userAgent,
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "accept-language": options.acceptLanguage || "en-US,en;q=0.9",
        referer: options.referer || GEMINI_URL,
        origin: "https://gemini.google.com",
        "sec-fetch-dest": "image",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "cross-site",
      },
      headerOrder: [
        "accept",
        "accept-language",
        "referer",
        "origin",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
      ],
      orderAsProvided: true,
      responseType: "arraybuffer",
      timeout: 120000,
    }, "get");
    if (response.status >= 400) {
      throw new Error(`Direct image download failed: ${response.status}`);
    }
    const bytes = Buffer.from(response.data);
    await writeFile(outputPath, bytes);
    return {
      bytes: bytes.length,
      contentType: response.headers?.["content-type"] || response.headers?.["Content-Type"] || "image/png",
      transport: "cycletls",
    };
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Direct image download failed: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, bytes);
  return {
    bytes: bytes.length,
    contentType: response.headers.get("content-type") || "image/png",
    transport: "fetch",
  };
}

function compactWatermarkAnalysis(analysis) {
  const sparkle = analysis?.watermark?.sparkles?.[0] || null;
  return {
    image: analysis?.image,
    size: analysis?.size,
    answer: analysis?.answer,
    confidence: typeof analysis?.confidence === "number" ? analysis.confidence : null,
    confidencePercent: typeof analysis?.confidence === "number" ? Math.round(analysis.confidence * 1000) / 10 : null,
    clusterBounds: analysis?.watermark?.clusterBounds || null,
    bestSparkle: sparkle ? {
      bbox: sparkle.bbox,
      center: sparkle.center,
      size: sparkle.size,
      score: sparkle.score,
      edgeTouch: sparkle.edgeTouch,
    } : null,
  };
}

async function analyzeWatermarkFile(filePath, options = {}) {
  const resolvedPath = resolve(filePath);
  const analysis = await analyzeWatermark(resolvedPath);
  if (options.debugOutputPath) {
    await writeDebugOverlay(resolvedPath, analysis, resolve(options.debugOutputPath));
  }
  return {
    path: resolvedPath,
    debugOutputPath: options.debugOutputPath ? resolve(options.debugOutputPath) : null,
    analysis: compactWatermarkAnalysis(analysis),
  };
}

async function refreshGeminiDirectSurface(page) {
  if (page.url().includes("gemini.google.com")) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  } else {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  }
  await page.waitForTimeout(3000);
  return await statusForPage(page).catch(() => null);
}

async function downloadPreferredDirectImage(parsed, outputPath, options = {}) {
  const rankedCandidates = rankDirectImageCandidates(parsed?.candidates || [], parsed?.imageUrls || []);
  const attempts = [];
  for (const candidate of rankedCandidates) {
    try {
      const downloaded = await downloadDirectImage(candidate.url, outputPath, options);
      return {
        downloaded,
        selectedCandidate: candidate,
        candidateSummary: summarizeDirectImageCandidates(rankedCandidates),
        attempts,
      };
    } catch (error) {
      attempts.push({
        url: candidate.url,
        mimeType: candidate.mimeType || null,
        score: candidate.score,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failure = new Error(attempts.length
    ? `Direct image download failed for all ${attempts.length} candidate URL(s).`
    : "Direct image download had no candidate URLs to try.");
  failure.downloadAttempts = attempts;
  failure.candidateSummary = summarizeDirectImageCandidates(rankedCandidates);
  throw failure;
}

async function applyWatermarkRemoval(outputPath, options = {}) {
  if (!options.removeGeminiWatermark) return null;
  const verify = options.verifyWatermarkRemoval !== false;
  const before = verify ? await analyzeWatermarkFile(outputPath).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  })) : null;
  const ext = extname(outputPath) || ".png";
  const cleanPath = options.watermarkOutputPath
    ? resolve(options.watermarkOutputPath)
    : outputPath;
  const tempPath = cleanPath === outputPath
    ? outputPath.replace(new RegExp(`${ext.replace(".", "\\.")}$`, "i"), `.watermark-cleaning-${Date.now()}${ext}`)
    : cleanPath;

  await mkdir(dirname(tempPath), { recursive: true });
  const result = await execFileAsync(process.execPath, [WATERMARK_REMOVER_PATH, outputPath, tempPath], {
    cwd: SCRIPT_DIR,
    timeout: Number.isFinite(Number(options.watermarkTimeoutMs)) ? Number(options.watermarkTimeoutMs) : 120000,
    windowsHide: true,
  });

  if (cleanPath === outputPath) {
    await unlink(outputPath).catch(() => {});
    await rename(tempPath, outputPath);
  }

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const confidenceMatch = stdout.match(/Confidence:\s*([\d.]+)%/i);
  const placementMatch = stdout.match(/template at x:(\d+), y:(\d+)/i);
  const finalBytes = await stat(cleanPath).then((item) => item.size).catch(() => null);
  const after = verify ? await analyzeWatermarkFile(cleanPath).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  })) : null;
  const beforeConfidence = before?.analysis?.confidence;
  const afterConfidence = after?.analysis?.confidence;
  return {
    applied: true,
    outputPath: cleanPath,
    mode: cleanPath === outputPath ? "overwrite" : "separate-output",
    finalBytes,
    confidencePercent: confidenceMatch ? Number(confidenceMatch[1]) : null,
    placement: placementMatch ? { x: Number(placementMatch[1]), y: Number(placementMatch[2]) } : null,
    verification: {
      enabled: verify,
      before,
      after,
      confidenceDelta: typeof beforeConfidence === "number" && typeof afterConfidence === "number"
        ? Math.round((beforeConfidence - afterConfidence) * 1000) / 1000
        : null,
      improved: typeof beforeConfidence === "number" && typeof afterConfidence === "number"
        ? afterConfidence < beforeConfidence
        : null,
    },
    stdout: stdout.slice(-1000),
    stderr: stderr.slice(-1000),
  };
}

async function detectWatermarkFile(args = {}) {
  if (!args.inputPath || typeof args.inputPath !== "string") throw new Error("inputPath is required");
  return {
    ok: true,
    ...(await analyzeWatermarkFile(args.inputPath, { debugOutputPath: args.debugOutputPath })),
  };
}

async function removeWatermarkFile(args = {}) {
  if (!args.inputPath || typeof args.inputPath !== "string") throw new Error("inputPath is required");
  const inputPath = resolve(args.inputPath);
  const outputPath = resolve(args.outputPath || inputPath);
  const removal = await applyWatermarkRemoval(inputPath, {
    removeGeminiWatermark: true,
    watermarkOutputPath: outputPath,
    watermarkTimeoutMs: args.watermarkTimeoutMs,
    verifyWatermarkRemoval: args.verifyWatermarkRemoval !== false,
  });
  return {
    ok: true,
    inputPath,
    outputPath: removal.outputPath,
    watermarkRemoval: removal,
  };
}

async function withPage(callback) {
  return await withContext(async (context) => {
    const page = await getPreferredGeminiPage(context);
    return await callback(page, context);
  });
}

async function withContext(callback) {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    return await callback(context, browser);
  } finally {
    await browser.close();
  }
}

async function getPreferredGeminiPage(context) {
  const pages = context.pages();
  let page = pages.find((candidate) => candidate.url().includes("gemini.google.com"));
  page ||= pages.find((candidate) => candidate.url().includes("accounts.google.com"));
  page ||= pages.find((candidate) => candidate.url() !== "about:blank");
  page ||= pages[0];
  if (!page) page = await context.newPage();
  return page;
}

async function createGeminiTaskPage(context, options = {}) {
  if (options.reusePreferredPage) {
    return { page: await getPreferredGeminiPage(context), owned: false };
  }
  return { page: await context.newPage(), owned: true };
}

function watchDirectImageTemplate(page) {
  let latestTemplate = null;
  const pendingSnapshots = new Set();
  const onRequest = (request) => {
    if (!request.url().includes("/StreamGenerate?")) return;
    const task = (async () => {
      try {
        const template = parseDirectImageTemplateFromPostData(request.postData() || "");
        if (!template) return;
        const headersArray = typeof request.headersArray === "function"
          ? await request.headersArray().catch(() => [])
          : Object.entries(await request.allHeaders().catch(() => ({}))).map(([name, value]) => ({ name, value }));
        template.headerEntries = extractDirectTemplateHeaderEntries(headersArray);
        latestTemplate = template;
      } catch {}
    })();
    pendingSnapshots.add(task);
    task.finally(() => pendingSnapshots.delete(task));
  };
  page.on("request", onRequest);
  return {
    async finish() {
      page.off("request", onRequest);
      if (pendingSnapshots.size) await Promise.allSettled([...pendingSnapshots]);
      if (latestTemplate) await saveDirectImageTemplateCache(latestTemplate).catch(() => {});
      return latestTemplate;
    },
  };
}

async function getGeminiDirectBootstrap(page) {
  const browserSignals = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    language: navigator.language || null,
    languages: Array.isArray(navigator.languages) ? navigator.languages.filter(Boolean) : [],
    hl: new URL(location.href).searchParams.get("hl") || document.documentElement.lang || navigator.language || "en",
    fSid: window.WIZ_global_data?.FdrFJe || null,
  })).catch(() => ({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    language: "en-US",
    languages: ["en-US", "en"],
    hl: "en",
    fSid: null,
  }));
  const userAgent = browserSignals.userAgent;
  const fSid = browserSignals.fSid;
  const acceptLanguage = buildAcceptLanguageHeader(browserSignals);
  const cookiesList = await page.context().cookies([GEMINI_URL]).catch(() => []);
  const cookies = {};
  for (const cookie of cookiesList) {
    if (cookie?.name && typeof cookie.value === "string") cookies[cookie.name] = cookie.value;
  }
  const client = await getCycleTlsClient();
  const faq = await client("https://gemini.google.com/faq", {
    cookies,
    userAgent,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": acceptLanguage,
      referer: GEMINI_URL,
    },
    headerOrder: ["accept", "accept-language", "referer"],
    orderAsProvided: true,
    responseType: "text",
    timeout: 90000,
  }, "get");
  const html = String(faq.data || "");
  const at = html.split("SNlM0e")[1]?.split('":"')[1]?.split('"')[0] || null;
  const bl = html.split("cfb2h")[1]?.split('":"')[1]?.split('"')[0] || null;
  return {
    at,
    bl,
    fSid,
    userAgent,
    acceptLanguage,
    hl: String(browserSignals.hl || "en").split(/[-_]/)[0] || "en",
    cookies,
    referer: page.url() && page.url().includes("gemini.google.com") ? page.url() : GEMINI_URL,
  };
}

async function attemptDirectImageGeneration(page, args, outputPath) {
  const template = await loadDirectImageTemplateCache();
  if (!template?.innerRequest) {
    return {
      ok: false,
      transport: "direct",
      blocker: "No cached direct Gemini image request template is available yet.",
      shouldFallback: true,
    };
  }
  const startedAt = Date.now();
  const hardTimeoutMs = Number.isFinite(Number(args.hardTimeoutMs)) ? Number(args.hardTimeoutMs) : 1800000;
  const client = await getCycleTlsClient();
  let lastFailure = null;

  for (let attemptIndex = 1; attemptIndex <= 2; attemptIndex += 1) {
    if (attemptIndex === 2) {
      await refreshGeminiDirectSurface(page).catch(() => null);
    }
    const bootstrap = await getGeminiDirectBootstrap(page);
    if (!bootstrap.at || !bootstrap.bl || !bootstrap.fSid) {
      lastFailure = {
        ok: false,
        transport: "direct",
        blocker: "Could not bootstrap Gemini direct-request tokens from the signed-in session.",
        shouldFallback: true,
        waitedMs: Date.now() - startedAt,
        bootstrap: {
          hasAt: Boolean(bootstrap.at),
          hasBl: Boolean(bootstrap.bl),
          hasFSid: Boolean(bootstrap.fSid),
        },
        directResponse: {
          attemptIndex,
          refreshedBootstrap: attemptIndex > 1,
        },
      };
      continue;
    }

    const requestId = Math.floor(900000 * Math.random()) + 100000;
    const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${new URLSearchParams({
      bl: bootstrap.bl,
      "f.sid": String(bootstrap.fSid),
      hl: bootstrap.hl || "en",
      _reqid: String(requestId),
      rt: "c",
    })}`;
    const body = buildDirectImagePostData(template, args.prompt, bootstrap.at);
    const requestProfile = buildDirectRequestProfile(template, bootstrap);
    const response = await client(url, {
      cookies: bootstrap.cookies,
      userAgent: bootstrap.userAgent,
      headers: requestProfile.headers,
      headerOrder: requestProfile.headerOrder,
      orderAsProvided: true,
      body,
      responseType: "stream",
      timeout: hardTimeoutMs,
    }, "post");

    if (response.status >= 400) {
      const errorBody = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      lastFailure = {
        ok: false,
        transport: "direct",
        blocker: `Gemini direct image request returned HTTP ${response.status}.`,
        shouldFallback: true,
        waitedMs: Date.now() - startedAt,
        directResponse: {
          status: response.status,
          attemptIndex,
          refreshedBootstrap: attemptIndex > 1,
          bodyPreview: String(errorBody || "").slice(0, 4000),
        },
      };
      if (attemptIndex === 1 && (response.status === 400 || response.status === 401 || response.status === 403)) continue;
      return lastFailure;
    }

    const streamed = await readDirectImageStream(response, {
      startedAt,
      hardTimeoutMs,
    });
    const parsed = streamed.parsed;
    if (!parsed.imageUrls.length) {
      lastFailure = {
        ok: false,
        transport: "direct",
        blocker: parsed.errorCode === 13
          ? "Gemini direct image request returned error 13."
          : streamed.timedOut
            ? "Gemini direct image request never produced a downloadable image URL before the safety timeout."
            : "Gemini direct image request did not return any downloadable image URLs.",
        shouldFallback: true,
        waitedMs: Date.now() - startedAt,
        directResponse: {
          ...parsed,
          attemptIndex,
          refreshedBootstrap: attemptIndex > 1,
          candidates: summarizeDirectImageCandidates(rankDirectImageCandidates(parsed.candidates, parsed.imageUrls)),
        },
        stream: {
          completion: streamed.completion,
          firstChunkMs: streamed.firstChunkMs,
          completedMs: streamed.completedMs,
          timedOut: streamed.timedOut,
        },
      };
      if (attemptIndex === 1 && (parsed.errorCode == null || parsed.errorCode === 13)) continue;
      return lastFailure;
    }

    try {
      const selected = await downloadPreferredDirectImage(parsed, outputPath, {
        cookies: bootstrap.cookies,
        userAgent: bootstrap.userAgent,
        acceptLanguage: bootstrap.acceptLanguage,
        referer: bootstrap.referer,
      });
      const watermarkRemoval = await applyWatermarkRemoval(outputPath, {
        removeGeminiWatermark: args.removeGeminiWatermark === true,
        watermarkOutputPath: args.watermarkOutputPath,
        watermarkTimeoutMs: args.watermarkTimeoutMs,
        verifyWatermarkRemoval: args.verifyWatermarkRemoval !== false,
      });
      return {
        ok: true,
        transport: "direct",
        outputPath: watermarkRemoval?.outputPath || outputPath,
        bytes: watermarkRemoval?.finalBytes || selected.downloaded.bytes,
        originalBytes: selected.downloaded.bytes,
        contentType: selected.downloaded.contentType,
        captureMethod: "direct-cycletls-streamgenerate",
        watermarkRemoval,
        waitedMs: Date.now() - startedAt,
        firstChunkMs: streamed.firstChunkMs,
        directStream: {
          completion: streamed.completion,
          completedMs: streamed.completedMs,
          timedOut: streamed.timedOut,
        },
        directResponse: {
          status: response.status,
          responseId: parsed.responseId,
          conversationId: parsed.conversationId,
          imageUrlCount: parsed.imageUrls.length,
          selectedUrl: selected.selectedCandidate.url,
          selectedCandidate: {
            candidateIndex: selected.selectedCandidate.candidateIndex,
            filename: selected.selectedCandidate.filename || null,
            mimeType: selected.selectedCandidate.mimeType || null,
            width: selected.selectedCandidate.width || null,
            height: selected.selectedCandidate.height || null,
            byteSize: selected.selectedCandidate.byteSize || null,
            score: selected.selectedCandidate.score,
          },
          candidateSummary: selected.candidateSummary,
          downloadAttempts: selected.attempts,
          errorCode: parsed.errorCode,
          downloadTransport: selected.downloaded.transport,
          headerOrder: requestProfile.headerOrder,
          attemptIndex,
          refreshedBootstrap: attemptIndex > 1,
          rawPreview: parsed.rawPreview,
        },
      };
    } catch (error) {
      lastFailure = {
        ok: false,
        transport: "direct",
        blocker: error instanceof Error ? error.message : String(error),
        shouldFallback: true,
        waitedMs: Date.now() - startedAt,
        directResponse: {
          status: response.status,
          responseId: parsed.responseId,
          conversationId: parsed.conversationId,
          imageUrlCount: parsed.imageUrls.length,
          candidates: summarizeDirectImageCandidates(rankDirectImageCandidates(parsed.candidates, parsed.imageUrls)),
          downloadAttempts: Array.isArray(error?.downloadAttempts) ? error.downloadAttempts : [],
          attemptIndex,
          refreshedBootstrap: attemptIndex > 1,
          rawPreview: parsed.rawPreview,
        },
      };
      if (attemptIndex === 1) continue;
      return lastFailure;
    }
  }

  return lastFailure || {
    ok: false,
    transport: "direct",
    blocker: "Gemini direct image request failed unexpectedly.",
    shouldFallback: true,
    waitedMs: Date.now() - startedAt,
  };
}

async function statusForPage(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  const attachments = await listAttachedFiles(page).catch(() => ({ count: 0, items: [] }));
  const directTemplate = await loadDirectImageTemplateCache().catch(() => null);
  const promptInputCount = await page.locator([
    "rich-textarea",
    "[aria-label='Enter a prompt for Gemini']",
    "[data-placeholder='Ask Gemini']",
    "div[role='textbox'][contenteditable='true']",
    "textarea",
  ].join(",")).count().catch(() => 0);
  const visibleImageCount = (await getImageCandidates(page).catch(() => [])).length;
  const joined = `${url}\n${title}\n${text}`;
  const status = {
    url,
    title,
    needsLogin: /sign in|signin|serviceLogin|login|choose an account/i.test(joined),
    hasPromptSurface: (promptInputCount > 0 || /enter a prompt|ask gemini|message gemini|conversation with gemini|new chat|chat with gemini|prompt/i.test(joined)) && !/site can't be reached|ERR_/i.test(joined),
    promptInputCount,
    visibleImageCount,
    attachedFileCount: attachments.count,
    attachedFiles: attachments.items.slice(0, 5),
    directImageTemplateCached: Boolean(directTemplate?.innerRequest),
    isCreatingImage: /creating your image/i.test(joined),
    hasStylePicker: /pick a style for your image/i.test(joined),
    hasNetworkError: /site can't be reached|ERR_|took too long to respond/i.test(joined),
    cdpUrl: CDP_URL,
  };
  return { ...status, diagnosis: diagnoseStatus(status) };
}

function diagnoseStatus(status) {
  if (status.hasNetworkError) {
    return {
      state: "network_error",
      confidence: "high",
      summary: "The Gemini page is loaded in the browser context, but the page content indicates a network error.",
      recommendation: "Fix browser/network access, then rerun open_gemini or check_status.",
    };
  }
  if (status.needsLogin) {
    return {
      state: "manual_login_required",
      confidence: "high",
      summary: "The dedicated Chrome profile is not ready for automation because Google login or consent is visible.",
      recommendation: "Handle login/consent manually in the visible Chrome profile. Do not import cookies.",
    };
  }
  if (status.isCreatingImage) {
    return {
      state: "image_generation_in_progress",
      confidence: "high",
      summary: "Gemini is actively showing 'Creating your image...'.",
      recommendation: "Wait; do not retry, refresh, or submit another prompt until this state clears.",
    };
  }
  if (status.hasStylePicker) {
    return {
      state: "image_style_picker",
      confidence: "high",
      summary: "Gemini is in image-mode style selection with a visible prompt composer.",
      recommendation: "Submit the prompt in the visible 'Describe your image' composer, or retry with useImageTool=false if it does not submit.",
    };
  }
  if (status.visibleImageCount > 0) {
    return {
      state: "generated_image_visible",
      confidence: "medium",
      summary: "At least one visible image candidate is present on the Gemini page.",
      recommendation: "Use save_latest_image to persist it, or continue the conversation intentionally with freshChat=false.",
    };
  }
  if (status.attachedFileCount > 0 && status.hasPromptSurface) {
    return {
      state: "ready_with_attachments",
      confidence: "high",
      summary: `Gemini is ready and the composer already has ${status.attachedFileCount} attached reference file(s).`,
      recommendation: "Clear the attachments unless you intentionally want to reuse them, or call generate_image_ui with preserveAttachments=true.",
    };
  }
  if (status.hasPromptSurface) {
    return {
      state: "ready_for_prompt",
      confidence: "high",
      summary: "Gemini is signed in and the prompt composer is available.",
      recommendation: "Use ask_gemini for text or generate_image_ui for image generation.",
    };
  }
  return {
    state: "unknown_ui_state",
    confidence: "low",
    summary: "Gemini is reachable, but the MCP does not recognize the current UI state.",
    recommendation: "Inspect the visible browser, then rerun check_status or open_gemini.",
  };
}

async function openGemini() {
  return await withPage(async (page) => {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2500);
    return await statusForPage(page);
  });
}

async function checkStatus() {
  return await withPage(async (page) => statusForPage(page));
}

async function inspectState() {
  return await withPage(async (page) => {
    const status = await statusForPage(page);
    const candidates = await getImageCandidates(page).catch(() => []);
    return {
      status,
      attachments: status.attachedFiles,
      imageCandidates: candidates.slice(0, 5),
      selfAwareness: {
        whatISee: status.diagnosis.summary,
        whatIWillDoNext: status.diagnosis.recommendation,
        safeBoundary: "I will use only the manually signed-in browser session and will not import cookies or bypass login, quota, billing, or consent screens.",
      },
    };
  });
}

function engineSource() {
  return String.raw`
(() => {
  if (window.__geminiWebMcpBridge) return true;
  const TOKEN_TTL = 300000;
  let tokens = null;
  let tokensFetchedAt = 0;
  let conversationId = "";
  let responseId = "";
  let choiceId = "";

  async function getTokens(forceRefresh = false) {
    const expired = Date.now() - tokensFetchedAt > TOKEN_TTL;
    if (tokens && !forceRefresh && !expired) return tokens;
    const res = await fetch("/faq", { credentials: "include" });
    if (!res.ok) throw new Error("Gemini token page fetch failed: " + res.status);
    const html = await res.text();
    if (!html.includes("$authuser")) throw new Error("Not logged into Gemini/Google");
    const at = html.split("SNlM0e")[1]?.split('":"')[1]?.split('"')[0];
    const bl = html.split("cfb2h")[1]?.split('":"')[1]?.split('"')[0];
    if (!at || !bl) throw new Error("Could not extract Gemini web tokens");
    tokens = { at, bl };
    tokensFetchedAt = Date.now();
    return tokens;
  }

  function stripPrefix(raw) {
    return raw.replace(/^\)\]}'?\s*\n?/, "");
  }

  function collectJsonStrings(value, out = []) {
    if (typeof value === "string" && value.length > 30) {
      try { JSON.parse(value); out.push(value); } catch {}
    } else if (Array.isArray(value)) {
      for (const item of value) collectJsonStrings(item, out);
    }
    return out;
  }

  function longestUsefulString(value, depth = 0) {
    if (depth > 10) return "";
    if (typeof value === "string") {
      if (/^[\w-]{10,}$/.test(value) && !value.includes(" ")) return "";
      return value;
    }
    let best = "";
    if (Array.isArray(value)) {
      for (const item of value) {
        const candidate = longestUsefulString(item, depth + 1);
        if (candidate.length > best.length) best = candidate;
      }
    }
    return best;
  }

  function parseResponse(raw) {
    const lines = stripPrefix(raw).split("\n").filter((line) => line.trim());
    const jsonStrings = [];
    for (const line of lines) {
      try { collectJsonStrings(JSON.parse(line), jsonStrings); } catch {}
    }
    if (!jsonStrings.length) throw new Error("Could not find Gemini response payload");

    let bestText = "";
    for (const encoded of jsonStrings) {
      try {
        const inner = JSON.parse(encoded);
        if (inner?.[5]?.[0] === 9) throw new Error("No Gemini access");
        if (Array.isArray(inner?.[1])) {
          if (typeof inner[1][0] === "string") conversationId = inner[1][0];
          if (typeof inner[1][1] === "string") responseId = inner[1][1];
        }
        if (typeof inner?.[4]?.[0]?.[0] === "string") choiceId = inner[4][0][0];
        const replyCandidates = Array.isArray(inner?.[4]) ? inner[4] : [];
        for (const candidate of replyCandidates) {
          if (typeof candidate?.[0] === "string") choiceId = candidate[0];
          if (Array.isArray(candidate?.[1])) {
            const joined = candidate[1].filter((part) => typeof part === "string").join("\n").trim();
            if (joined.length > bestText.length) bestText = joined;
          } else if (typeof candidate?.[1] === "string" && candidate[1].length > bestText.length) {
            bestText = candidate[1];
          }
        }
        if (!bestText) {
          const paths = [
            inner?.[0]?.[0],
            inner?.[0]?.[1]?.[0],
            inner?.[3]?.[0]?.[0],
          ];
          for (const candidate of paths) {
            if (typeof candidate === "string" && candidate.length > bestText.length) bestText = candidate;
          }
        }
        if (!bestText) {
          const longest = longestUsefulString(inner);
          if (longest.length > bestText.length) bestText = longest;
        }
      } catch (error) {
        if (String(error.message || error).includes("No Gemini access")) throw error;
      }
    }
    if (!bestText) throw new Error("Could not extract Gemini reply text");
    return bestText;
  }

  async function ask(message) {
    let currentTokens = await getTokens(false);
    let reqId = Math.floor(900000 * Math.random()) + 100000;
    const context = [conversationId, responseId, choiceId];
    const makeBody = (tokenSet) => new URLSearchParams({
      at: tokenSet.at,
      "f.req": JSON.stringify([null, JSON.stringify([[message], null, context])]),
    });
    const makeUrl = (tokenSet, id) => "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?" + new URLSearchParams({
      bl: tokenSet.bl,
      rt: "c",
      _reqid: String(id),
    });

    let res = await fetch(makeUrl(currentTokens, reqId), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
      body: makeBody(currentTokens),
    });

    if (res.status === 400) {
      currentTokens = await getTokens(true);
      reqId = Math.floor(900000 * Math.random()) + 100000;
      res = await fetch(makeUrl(currentTokens, reqId), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "x-same-domain": "1" },
        body: makeBody(currentTokens),
      });
    }
    if (!res.ok) throw new Error("Gemini web request failed: " + res.status + " " + (await res.text()).slice(0, 300));
    return parseResponse(await res.text());
  }

  function newConversation() {
    conversationId = "";
    responseId = "";
    choiceId = "";
  }

  window.__geminiWebMcpBridge = { ask, newConversation };
  return true;
})();`;
}

async function ensureEngine(page) {
  if (!page.url().includes("gemini.google.com")) {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2500);
  }
  const status = await statusForPage(page);
  if (status.needsLogin || status.hasNetworkError) return { ready: false, status };
  await page.evaluate(() => {
    delete window.__geminiWebMcpBridge;
  }).catch(() => {});
  await page.evaluate(engineSource());
  const ready = await page.evaluate(() => typeof window.__geminiWebMcpBridge !== "undefined");
  return { ready, status: await statusForPage(page) };
}

async function askGemini(args = {}) {
  if (!args.message || typeof args.message !== "string") throw new Error("message is required");
  return await withPage(async (page) => {
    const engine = await ensureEngine(page);
    if (!engine.ready) return { ok: false, blocker: "Gemini web engine is not ready. Sign in manually in the visible browser, then retry.", status: engine.status };
    const response = await page.evaluate(async (message) => window.__geminiWebMcpBridge.ask(message), args.message);
    return { ok: true, response };
  });
}

async function fillPrompt(page, prompt) {
  const selectors = [
    "[aria-label='Enter a prompt for Gemini'][contenteditable='true']",
    "[data-placeholder='Describe your image'][contenteditable='true']",
    "[data-placeholder='Ask Gemini'][contenteditable='true']",
    "rich-textarea .ql-editor[contenteditable='true']",
    "div[role='textbox']",
    "textarea",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      await candidate.click({ timeout: 8000 }).catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.type(prompt, { delay: 1 });
      await page.waitForTimeout(500);
      if (await promptStillInComposer(page, prompt).catch(() => false)) return true;
    }
  }
  return false;
}

async function clickSend(page) {
  const candidates = [
    page.locator("button[aria-label='Send message']"),
    page.locator("button[aria-label*='Send message' i]"),
    page.locator("button[aria-label*='Send' i]"),
    page.getByRole("button", { name: /send/i }),
    page.getByRole("button", { name: /submit/i }),
    page.getByRole("button", { name: /run/i }),
  ];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      if (!count) continue;
      const button = candidate.last();
      const enabled = await button.isEnabled().catch(() => false);
      const visible = await button.isVisible().catch(() => false);
      if (enabled && visible) {
        await button.click({ timeout: 10000 });
        await page.waitForTimeout(1000);
        return true;
      }
    }
    await page.waitForTimeout(1000);
  }
  await page.keyboard.press("Control+Enter").catch(() => {});
  await page.waitForTimeout(1000);
  return true;
}

async function promptStillInComposer(page, prompt) {
  const value = await page.locator("[aria-label='Enter a prompt for Gemini'], [data-placeholder='Ask Gemini'], div[role='textbox'][contenteditable='true']").last().innerText({ timeout: 5000 }).catch(() => "");
  const normalizedValue = value.replace(/\s+/g, " ").trim();
  const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();
  return normalizedPrompt.length > 0 && normalizedValue.includes(normalizedPrompt.slice(0, Math.min(80, normalizedPrompt.length)));
}

async function selectImageTool(page) {
  const candidates = [
    page.getByRole("button", { name: /create image/i }),
    page.locator("button[aria-label*='Create image' i]"),
  ];
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    if (!count) continue;
    const button = candidate.first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

async function ensureReferenceImages(paths) {
  const resolved = [];
  for (const pathValue of asStringArray(paths)) {
    const fullPath = resolve(pathValue);
    await access(fullPath);
    resolved.push(fullPath);
  }
  return resolved;
}

async function listAttachedFiles(page) {
  const items = await page.locator("button[aria-label^='Remove file ']").evaluateAll((buttons) => {
    return buttons.map((button, index) => {
      const label = button.getAttribute("aria-label") || "";
      const name = label.replace(/^Remove file\s+/i, "").trim();
      return {
        index,
        label,
        name: name || null,
      };
    });
  }).catch(() => []);
  return { count: items.length, items };
}

async function clearAttachedFiles(page) {
  const before = await listAttachedFiles(page);
  const removed = [];
  let previousCount = before.count;
  while (previousCount > 0) {
    const current = await listAttachedFiles(page);
    const button = page.locator("button[aria-label^='Remove file ']").first();
    if (!await button.isVisible().catch(() => false)) break;
    await button.scrollIntoViewIfNeeded().catch(() => {});
    const first = current.items[0] || null;
    await button.click({ timeout: 8000 }).catch(() => {});
    await page.waitForFunction((targetCount) => {
      return document.querySelectorAll("button[aria-label^='Remove file ']").length < targetCount;
    }, previousCount, { timeout: 10000 }).catch(() => {});
    if (first) removed.push({ label: first.label, name: first.name });
    previousCount = await page.locator("button[aria-label^='Remove file ']").count().catch(() => 0);
    if (previousCount > 0) await page.waitForTimeout(250);
  }
  const after = await listAttachedFiles(page);
  return {
    beforeCount: before.count,
    clearedCount: Math.max(0, before.count - after.count),
    afterCount: after.count,
    removed,
    remaining: after.items,
  };
}

async function attachReferenceImages(page, imagePaths) {
  if (!imagePaths.length) return { attachedCount: 0, paths: [] };
  const uploadButton = page.locator("button[aria-label='Open upload file menu']").first();
  if (!await uploadButton.isVisible().catch(() => false)) {
    throw new Error("Could not find Gemini upload button.");
  }

  const beforeRemoveButtons = await page.locator("button[aria-label^='Remove file ']").count().catch(() => 0);
  await uploadButton.click({ timeout: 8000 });
  await page.waitForTimeout(500);

  const uploadFilesButton = page.locator("button[aria-label*='Upload files']").first();
  if (!await uploadFilesButton.isVisible().catch(() => false)) {
    throw new Error("Gemini upload menu opened, but the Upload files action was not visible.");
  }

  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 });
  await uploadFilesButton.click({ timeout: 8000 });
  const chooser = await chooserPromise;
  await chooser.setFiles(imagePaths);

  const expectedCount = beforeRemoveButtons + imagePaths.length;
  await page.waitForFunction((targetCount) => {
    return document.querySelectorAll("button[aria-label^='Remove file ']").length >= targetCount;
  }, expectedCount, { timeout: 60000 }).catch(() => {});

  await page.waitForFunction(() => {
    return !document.querySelector("[aria-label='Loading image']");
  }, undefined, { timeout: 60000 }).catch(() => {});

  const attachedCount = await page.locator("button[aria-label^='Remove file ']").count().catch(() => beforeRemoveButtons);
  return { attachedCount, paths: imagePaths };
}

async function getImageCandidates(page) {
  return await page.locator("img, canvas").evaluateAll((elements) => {
    return elements
      .map((element, index) => {
        const box = element.getBoundingClientRect();
        const src = element.currentSrc || element.src || "";
        const alt = element.getAttribute("alt") || "";
        const cls = element.getAttribute("class") || "";
        const naturalWidth = element instanceof HTMLImageElement ? element.naturalWidth : element instanceof HTMLCanvasElement ? element.width : 0;
        const naturalHeight = element instanceof HTMLImageElement ? element.naturalHeight : element instanceof HTMLCanvasElement ? element.height : 0;
        const signature = [element.tagName, src, alt, cls, Math.round(box.width), Math.round(box.height)].join("|");
        return { index, area: Math.round(box.width * box.height), width: box.width, height: box.height, naturalWidth, naturalHeight, tag: element.tagName, src, alt, cls, signature };
      })
      .filter((item) => item.area > 20000)
      .filter((item) => !/media_gen_templates|bard-robin-zs\/media_gen_templates/i.test(item.src))
      .filter((item) => !/uploaded image preview|preview-image|attachment-preview|file-preview/i.test(`${item.alt} ${item.cls}`))
      .sort((a, b) => b.index - a.index);
  });
}

async function captureImage(page, outputPath, image, options = {}) {
  if (!image) return null;
  await mkdir(dirname(outputPath), { recursive: true });
  const locator = page.locator("img, canvas").nth(image.index);
  const downloaded = await locator.evaluate(async (element) => {
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    }

    if (element instanceof HTMLCanvasElement) {
      const dataUrl = element.toDataURL("image/png");
        return { base64: dataUrl.split(",")[1], contentType: "image/png", method: "canvas-data-url", width: element.width, height: element.height };
    }

    if (element instanceof HTMLImageElement) {
      await element.decode().catch(() => {});
      const canvas = document.createElement("canvas");
      canvas.width = element.naturalWidth || element.width;
      canvas.height = element.naturalHeight || element.height;
      const context = canvas.getContext("2d");
      if (context && canvas.width && canvas.height) {
        context.drawImage(element, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        return { base64: dataUrl.split(",")[1], contentType: "image/png", method: "image-canvas", width: canvas.width, height: canvas.height };
      }
    }

    const src = element.currentSrc || element.src || "";
    if (!src) return null;
    const response = await fetch(src);
    if (!response.ok) return null;
    const blob = await response.blob();
    return { base64: arrayBufferToBase64(await blob.arrayBuffer()), contentType: blob.type || "image/png", method: "image-fetch", width: element.naturalWidth || element.width || 0, height: element.naturalHeight || element.height || 0 };
  }).catch(() => null);

  if (downloaded?.base64) {
    const bytes = Buffer.from(downloaded.base64, "base64");
    await writeFile(outputPath, bytes);
    const watermarkRemoval = await applyWatermarkRemoval(outputPath, options);
    return {
      outputPath: watermarkRemoval?.outputPath || outputPath,
      bytes: watermarkRemoval?.finalBytes || bytes.length,
      originalBytes: bytes.length,
      contentType: downloaded.contentType,
      captureMethod: downloaded.method,
      imageWidth: downloaded.width,
      imageHeight: downloaded.height,
      watermarkRemoval,
      capturedElement: image,
    };
  }

  await locator.screenshot({ path: outputPath, timeout: 30000 });
  const watermarkRemoval = await applyWatermarkRemoval(outputPath, options);
  return {
    outputPath: watermarkRemoval?.outputPath || outputPath,
    bytes: watermarkRemoval?.finalBytes || await stat(outputPath).then((item) => item.size).catch(() => null),
    captureMethod: "element-screenshot",
    watermarkRemoval,
    capturedElement: image,
  };
}

async function captureNewImage(page, outputPath, baseline, options = {}) {
  const candidates = await getImageCandidates(page);
  const baselineSignatures = new Set(baseline.signatures || []);
  const fresh = candidates.filter((item) => item.index >= baseline.count || !baselineSignatures.has(item.signature));
  const source = fresh.length || baseline.count ? fresh : candidates;
  const image = source
    .filter((item) => item.width >= 128 && item.height >= 128)
    .filter((item) => !/uploaded image preview|preview-image|attachment-preview|file-preview/i.test(`${item.alt} ${item.cls}`))
    .filter((item) => /AI generated/i.test(`${item.alt}`) || item.area > 80000)
    .sort((a, b) => b.index - a.index)[0] || null;
  return await captureImage(page, outputPath, image, options);
}

async function waitForGeneratedImage(page, outputPath, baseline, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 1200000;
  const hardTimeoutMs = Number.isFinite(Number(options.hardTimeoutMs)) ? Number(options.hardTimeoutMs) : Math.max(timeoutMs, 1800000);
  const start = Date.now();
  let capture = null;
  let lastBodyText = "";

  while (Date.now() - start < hardTimeoutMs) {
    await page.waitForTimeout(5000);
    try {
      capture = await captureNewImage(page, outputPath, baseline, options);
    } catch (error) {
      return {
        ok: false,
        blocker: "A generated image was found, but saving or watermark post-processing failed.",
        error: error instanceof Error ? error.message : String(error),
        stdout: error?.stdout?.trim?.().slice(-1000),
        stderr: error?.stderr?.trim?.().slice(-1000),
        status: await statusForPage(page),
        waitedMs: Date.now() - start,
      };
    }
    if (capture) return { ok: true, ...capture, waitedMs: Date.now() - start };

    const current = await statusForPage(page);
    if (/upgrade|billing|quota|not available|can't help/i.test(JSON.stringify(current))) {
      return { ok: false, blocker: "Gemini UI reported availability/quota/billing/refusal text.", status: current, waitedMs: Date.now() - start };
    }

    const bodyText = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
    lastBodyText = bodyText;
    if (/something went wrong\s*\(\d+\)/i.test(bodyText)) {
      return { ok: false, blocker: "Gemini reported an image-generation error.", status: current, waitedMs: Date.now() - start, bodyExcerpt: bodyText.slice(0, 1000) };
    }
    if (/pick a style for your image/i.test(bodyText)) {
      return { ok: false, blocker: "Gemini opened the image style picker instead of submitting the prompt. Retry with useImageTool=false.", status: current, waitedMs: Date.now() - start, bodyExcerpt: bodyText.slice(0, 1000) };
    }

    if (!/creating your image/i.test(bodyText) && Date.now() - start >= timeoutMs) {
      break;
    }
  }

  const bodyText = lastBodyText || await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");
  const blocker = /creating your image/i.test(bodyText)
    ? "Gemini was still creating the image when the hard timeout expired."
    : "No image element found before timeout.";
  return { ok: false, blocker, status: await statusForPage(page), waitedMs: Date.now() - start, bodyExcerpt: bodyText.slice(0, 1000) };
}

function asPositiveInt(value, fallback, min = 1, max = 20) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function createStartGate(cooldownMs) {
  let nextAllowedStart = Date.now();
  return async () => {
    const now = Date.now();
    const startAt = Math.max(now, nextAllowedStart);
    nextAllowedStart = startAt + cooldownMs;
    const waitMs = Math.max(0, startAt - now);
    if (waitMs > 0) await sleep(waitMs);
    return { waitMs, scheduledStartAt: startAt };
  };
}

function countedPath(pathValue, index, count, fallbackPrefix) {
  const width = Math.max(2, String(count).length);
  const label = String(index).padStart(width, "0");
  const rawPath = pathValue || `${fallbackPrefix}-${Date.now()}.png`;
  if (rawPath.includes("{index}")) return resolve(rawPath.replaceAll("{index}", label));
  if (rawPath.includes("{n}")) return resolve(rawPath.replaceAll("{n}", label));
  if (count <= 1) return resolve(rawPath);
  const ext = extname(rawPath) || ".png";
  return resolve(rawPath.replace(new RegExp(`${ext.replace(".", "\\.")}$`, "i"), `-${label}${ext}`));
}

function effectivePromptForItem(args, itemIndex) {
  const prompts = asStringArray(args.prompts);
  const itemPrompt = prompts[itemIndex - 1];
  if (typeof itemPrompt === "string" && itemPrompt.trim()) return itemPrompt.trim();
  if (typeof args.prompt === "string" && args.prompt.trim()) return args.prompt.trim();
  return "";
}

function effectiveReferenceImagesForItem(args, itemIndex) {
  const byItem = asNestedStringArrays(args.referenceImagePathsByItem);
  if (Array.isArray(byItem[itemIndex - 1]) && byItem[itemIndex - 1].length) return byItem[itemIndex - 1];
  return asStringArray(args.referenceImagePaths);
}

function decorateImageCandidates(candidates) {
  return candidates
    .filter((item) => item.width >= 128 && item.height >= 128)
    .map((item, candidateIndex) => ({
      ...item,
      candidateIndex,
      isLatest: candidateIndex === 0,
    }));
}

function selectImageCandidates(candidates, args = {}) {
  const decorated = decorateImageCandidates(candidates);
  if (args.all === true) return decorated;
  const requestedIndices = Array.isArray(args.imageIndices)
    ? args.imageIndices.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isFinite(value) && value >= 0)
    : [];
  if (requestedIndices.length) {
    return requestedIndices
      .map((candidateIndex) => decorated.find((item) => item.candidateIndex === candidateIndex))
      .filter(Boolean);
  }
  const singleIndex = Number.parseInt(args.imageIndex, 10);
  if (Number.isFinite(singleIndex) && singleIndex >= 0) {
    return decorated.filter((item) => item.candidateIndex === singleIndex);
  }
  const selectionCount = asPositiveInt(args.count, 1, 1, 20);
  return decorated.slice(0, selectionCount);
}

async function generateOneImageOnPage(page, args, outputPath, itemIndex = 1, count = 1) {
  const referenceImagePaths = await ensureReferenceImages(args.referenceImagePaths).catch((error) => {
    throw new Error(`referenceImagePaths validation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const prompt = typeof args.prompt === "string" && args.prompt.trim()
    ? args.prompt.trim()
    : referenceImagePaths.length
      ? "Create a variation of the attached reference image."
      : "";
  const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 1200000;
  const hardTimeoutMs = Number.isFinite(Number(args.hardTimeoutMs)) ? Number(args.hardTimeoutMs) : Math.max(timeoutMs, 1800000);
  const freshChat = typeof args.freshChat === "boolean" ? args.freshChat : true;
  const useImageTool = typeof args.useImageTool === "boolean" ? args.useImageTool : true;
  const transport = asTransport(args.transport);
  const observations = [];
  if (!prompt && !referenceImagePaths.length) {
    return {
      ok: false,
      itemIndex,
      count,
      requestedOutputPath: outputPath,
      blocker: "This item has no prompt text and no referenceImagePaths after per-item resolution.",
      observations,
    };
  }
  observations.push(`Transport policy: ${transport === "auto" ? "prefer direct CycleTLS first, then fall back to Playwright UI if needed." : transport === "direct" ? "direct CycleTLS only." : "force Playwright UI."}`);
  if (Number.isFinite(Number(args.cooldownWaitMs)) && Number(args.cooldownWaitMs) > 0) {
    observations.push(`Waited ${Number(args.cooldownWaitMs)}ms before starting this item to stagger Gemini requests.`);
  }
  if (args.parallelIsolation === true) {
    observations.push("Used an isolated Gemini tab for this item so parallel work does not collide in one page.");
  }
  if (freshChat || !page.url().includes("gemini.google.com")) {
    await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3000);
    observations.push("Opened a fresh Gemini prompt surface to avoid stale images from older conversations.");
  }
  const status = await statusForPage(page);
  observations.push(`Initial state: ${status.diagnosis.state} (${status.diagnosis.confidence} confidence).`);
  if (status.needsLogin || status.hasNetworkError || !status.hasPromptSurface) {
    return { ok: false, itemIndex, count, requestedOutputPath: outputPath, blocker: "Gemini UI is not ready. Sign in/open Gemini manually in the visible browser, then retry.", status, observations };
  }
  const existingAttachments = await listAttachedFiles(page).catch(() => ({ count: 0, items: [] }));
  if (existingAttachments.count > 0) {
    if (args.preserveAttachments === true) {
      observations.push(`Preserved ${existingAttachments.count} existing attachment(s) already present in the Gemini composer.`);
    } else {
      const cleared = await clearAttachedFiles(page);
      observations.push(`Cleared ${cleared.clearedCount} stale attachment(s) before composing the next request.`);
    }
  } else {
    observations.push("No existing Gemini attachments were present before composing this request.");
  }
  const directEligible = transport !== "ui" && freshChat !== false && !referenceImagePaths.length && Boolean(prompt);
  if (directEligible) {
    const directAttempt = await attemptDirectImageGeneration(page, {
      ...args,
      prompt,
      hardTimeoutMs,
      watermarkOutputPath: args.watermarkOutputPath,
    }, outputPath).catch((error) => ({
      ok: false,
      transport: "direct",
      blocker: error instanceof Error ? error.message : String(error),
      shouldFallback: true,
    }));
    if (directAttempt.ok) {
      observations.push("Direct CycleTLS image request succeeded before any Playwright UI fallback was needed.");
      return {
        ...directAttempt,
        itemIndex,
        count,
        requestedOutputPath: outputPath,
        baselineImageCount: 0,
        freshChat,
        imageToolSelected: false,
        strategy: {
          freshChat,
          useImageTool,
          referenceImageCount: 0,
          promptPreview: prompt.slice(0, 180),
          timeoutMs,
          hardTimeoutMs,
          removeGeminiWatermark: args.removeGeminiWatermark === true,
          waitPolicy: "Send the Gemini image request directly over CycleTLS-Parity and save the first returned downloadable image URL.",
          countPolicy: args.parallelIsolation
            ? "Generate this item in an isolated Gemini tab under a controlled parallel run."
            : "Generate images sequentially because Gemini's web UI is stateful.",
          cooldownWaitMs: Number.isFinite(Number(args.cooldownWaitMs)) ? Number(args.cooldownWaitMs) : 0,
          preserveAttachments: false,
          transport,
          fallbackUsed: false,
        },
        observations,
        url: page.url(),
      };
    }
    observations.push(`Direct CycleTLS path did not complete this item: ${directAttempt.blocker}`);
    if (transport === "direct") {
      return {
        ok: false,
        itemIndex,
        count,
        requestedOutputPath: outputPath,
        blocker: directAttempt.blocker,
        transport: "direct",
        directResponse: directAttempt.directResponse,
        observations,
        status: await statusForPage(page),
      };
    }
    observations.push("Falling back to Playwright UI automation for this item.");
  } else if (transport !== "ui") {
    observations.push("Direct CycleTLS path is not eligible for this item because it is not a simple fresh text-to-image request.");
  }
  observations.push(prompt ? `Effective prompt preview: ${prompt.slice(0, 180)}${prompt.length > 180 ? "..." : ""}` : "No explicit prompt was supplied; Gemini will get the fallback variation prompt.");
  const imageToolSelected = useImageTool ? await selectImageTool(page) : false;
  observations.push(imageToolSelected ? "Selected Gemini image mode before submitting the prompt." : "Skipped explicit image mode and will rely on the prompt text to trigger image generation.");
  if (referenceImagePaths.length) {
    const attachment = await attachReferenceImages(page, referenceImagePaths);
    observations.push(`Attached ${referenceImagePaths.length} reference image(s); Gemini now shows ${attachment.attachedCount} removable attachment chip(s).`);
  }
  const beforeImages = await getImageCandidates(page);
  const baseline = { count: beforeImages.length, signatures: beforeImages.map((item) => item.signature) };
  observations.push(`Baseline visible image candidates: ${baseline.count}.`);
  const filled = await fillPrompt(page, prompt);
  if (!filled) return { ok: false, itemIndex, count, requestedOutputPath: outputPath, blocker: "Could not find Gemini prompt input.", status: await statusForPage(page), observations };
  observations.push("Filled the visible Gemini composer.");
  const directTemplateWatcher = watchDirectImageTemplate(page);
  let result;
  let capturedTemplate = null;
  try {
    await clickSend(page);
    if (await promptStillInComposer(page, prompt)) {
      await clickSend(page);
      observations.push("Prompt still appeared in the composer after the first send attempt, so I sent it once more.");
    } else {
      observations.push("Prompt left the composer after submit.");
    }
    result = await waitForGeneratedImage(page, outputPath, baseline, {
      timeoutMs,
      hardTimeoutMs,
      removeGeminiWatermark: args.removeGeminiWatermark === true,
      watermarkOutputPath: args.watermarkOutputPath,
      watermarkTimeoutMs: args.watermarkTimeoutMs,
      verifyWatermarkRemoval: args.verifyWatermarkRemoval !== false,
    });
  } finally {
    capturedTemplate = await directTemplateWatcher.finish().catch(() => null);
  }
  if (capturedTemplate?.innerRequest) observations.push("Refreshed the cached direct CycleTLS image template from the live Gemini UI request.");
  return {
    ...result,
    itemIndex,
    count,
    requestedOutputPath: outputPath,
    baselineImageCount: baseline.count,
    freshChat,
    imageToolSelected,
    strategy: {
      freshChat,
      useImageTool,
      referenceImageCount: referenceImagePaths.length,
      promptPreview: prompt.slice(0, 180),
      timeoutMs,
      hardTimeoutMs,
      removeGeminiWatermark: args.removeGeminiWatermark === true,
      waitPolicy: "Keep waiting while Gemini says 'Creating your image...'; do not retry in that state.",
      countPolicy: args.parallelIsolation
        ? "Generate this item in an isolated Gemini tab under a controlled parallel run."
        : "Generate images sequentially because Gemini's web UI is stateful.",
      cooldownWaitMs: Number.isFinite(Number(args.cooldownWaitMs)) ? Number(args.cooldownWaitMs) : 0,
      preserveAttachments: args.preserveAttachments === true,
      transport,
      fallbackUsed: true,
    },
    observations,
    url: page.url(),
  };
}

async function generateImageUi(args = {}) {
  const promptVariants = asStringArray(args.prompts);
  const referenceImageMatrix = asNestedStringArrays(args.referenceImagePathsByItem);
  const hasPrompt = (typeof args.prompt === "string" && args.prompt.trim()) || promptVariants.length > 0;
  const hasReferenceImages = asStringArray(args.referenceImagePaths).length > 0 || referenceImageMatrix.some((item) => item.length > 0);
  if (!hasPrompt && !hasReferenceImages) throw new Error("prompt or referenceImagePaths is required");
  const inferredCount = Math.max(
    Number.isFinite(Number(args.count)) ? Number.parseInt(args.count, 10) : 1,
    promptVariants.length || 0,
    referenceImageMatrix.length || 0,
    1,
  );
  const count = asPositiveInt(args.count, inferredCount, 1, 20);
  const requestedConcurrency = asPositiveInt(args.concurrency, 1, 1, 4);
  const concurrency = Math.min(count, requestedConcurrency);
  const cooldownMs = asPositiveInt(args.cooldownMs, 15000, 0, 300000);
  const continueOnFailure = args.continueOnFailure === true;
  const startedAt = Date.now();
  return await withContext(async (context) => {
    const results = new Array(count);
    const plannedOutputPaths = [];
    const startGate = createStartGate(cooldownMs);
    let nextIndex = 1;
    let stopScheduling = false;

    const runWorker = async (workerId) => {
      while (true) {
        if (stopScheduling) return;
        const itemIndex = nextIndex;
        if (itemIndex > count) return;
        nextIndex += 1;

        const outputPath = countedPath(args.outputPath, itemIndex, count, "gemini-web-image");
        plannedOutputPaths[itemIndex - 1] = outputPath;
        const watermarkOutputPath = args.watermarkOutputPath
          ? countedPath(args.watermarkOutputPath, itemIndex, count, "gemini-web-image-clean")
          : undefined;
        const startReservation = await startGate();
        const { page, owned } = await createGeminiTaskPage(context, {
          reusePreferredPage: concurrency === 1 && itemIndex === 1,
        });

        try {
          const result = await generateOneImageOnPage(page, {
            ...args,
            prompt: effectivePromptForItem(args, itemIndex),
            referenceImagePaths: effectiveReferenceImagesForItem(args, itemIndex),
            freshChat: concurrency > 1 ? true : args.freshChat,
            watermarkOutputPath,
            cooldownWaitMs: startReservation.waitMs,
            parallelIsolation: concurrency > 1,
          }, outputPath, itemIndex, count);
          results[itemIndex - 1] = result;
          if (!result.ok && !continueOnFailure) stopScheduling = true;
        } finally {
          if (owned) await page.close().catch(() => {});
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, (_, index) => runWorker(index + 1)));
    const completedResults = results.filter(Boolean);
    const succeeded = completedResults.filter((item) => item.ok).length;
    const failed = completedResults.length - succeeded;
    if (count === 1) return completedResults[0];
    return {
      ok: succeeded === count,
      requestedCount: count,
      attemptedCount: completedResults.length,
      succeeded,
      failed,
      requestedConcurrency,
      concurrency,
      cooldownMs,
      continueOnFailure,
      totalWaitedMs: Date.now() - startedAt,
      plannedOutputPaths,
      outputPaths: completedResults.filter((item) => item.ok && item.outputPath).map((item) => item.outputPath),
      results: completedResults,
      strategy: {
        countPolicy: concurrency > 1
          ? "Generate images in parallel across isolated Gemini tabs, but stagger request starts with a cooldown gate."
          : "Generate images sequentially in one Gemini tab.",
        promptPolicy: promptVariants.length
          ? "Use prompts[itemIndex-1] when present, otherwise fall back to prompt."
          : "Use one shared prompt for all items unless a given item falls back to image-to-image variation mode.",
        referencePolicy: referenceImageMatrix.length
          ? "Use referenceImagePathsByItem[itemIndex-1] when present, otherwise fall back to shared referenceImagePaths."
          : "Use one shared referenceImagePaths set for all items.",
        outputPathPolicy: "For count > 1, append a padded numeric suffix unless outputPath contains {index} or {n}.",
        parallelPolicy: `Use up to ${concurrency} Gemini tabs and reserve a ${cooldownMs}ms cooldown between request starts.`,
      },
    };
  });
}

async function waitForImage(args = {}) {
  const outputPath = resolve(args.outputPath || `gemini-web-waited-image-${Date.now()}.png`);
  const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 1200000;
  const hardTimeoutMs = Number.isFinite(Number(args.hardTimeoutMs)) ? Number(args.hardTimeoutMs) : Math.max(timeoutMs, 1800000);
  return await withPage(async (page) => {
    const beforeImages = await getImageCandidates(page);
    const baseline = {
      count: typeof args.baselineImageCount === "number" ? args.baselineImageCount : Math.max(0, beforeImages.length - 1),
      signatures: Array.isArray(args.baselineSignatures) ? args.baselineSignatures : [],
    };
    const result = await waitForGeneratedImage(page, outputPath, baseline, {
      timeoutMs,
      hardTimeoutMs,
      removeGeminiWatermark: args.removeGeminiWatermark === true,
      watermarkOutputPath: args.watermarkOutputPath,
      watermarkTimeoutMs: args.watermarkTimeoutMs,
      verifyWatermarkRemoval: args.verifyWatermarkRemoval !== false,
    });
    return { ...result, baselineImageCount: baseline.count, url: page.url() };
  });
}

async function listAttachments() {
  return await withPage(async (page) => {
    const attachments = await listAttachedFiles(page);
    return {
      ok: true,
      count: attachments.count,
      attachments: attachments.items,
      url: page.url(),
    };
  });
}

async function clearAttachments() {
  return await withPage(async (page) => {
    const cleared = await clearAttachedFiles(page);
    return {
      ok: true,
      ...cleared,
      url: page.url(),
    };
  });
}

async function listVisibleImages() {
  return await withPage(async (page) => {
    const candidates = decorateImageCandidates(await getImageCandidates(page));
    return {
      ok: true,
      count: candidates.length,
      images: candidates,
      url: page.url(),
    };
  });
}

async function saveVisibleImages(args = {}) {
  return await withPage(async (page) => {
    const candidates = selectImageCandidates(await getImageCandidates(page), args);
    if (!candidates.length) {
      return { ok: false, blocker: "No matching visible Gemini image candidates were found on the current page.", status: await statusForPage(page) };
    }
    const results = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const outputPath = countedPath(args.outputPath || `gemini-web-visible-image-${Date.now()}.png`, index + 1, candidates.length, "gemini-web-visible-image");
      const watermarkOutputPath = args.watermarkOutputPath
        ? countedPath(args.watermarkOutputPath, index + 1, candidates.length, "gemini-web-visible-image-clean")
        : undefined;
      const capture = await captureImage(page, outputPath, candidate, {
        removeGeminiWatermark: args.removeGeminiWatermark === true,
        watermarkOutputPath,
        watermarkTimeoutMs: args.watermarkTimeoutMs,
        verifyWatermarkRemoval: args.verifyWatermarkRemoval !== false,
      });
      results.push({
        ok: true,
        candidateIndex: candidate.candidateIndex,
        requestedOutputPath: outputPath,
        ...capture,
      });
    }
    if (results.length === 1) {
      return {
        ...results[0],
        url: page.url(),
      };
    }
    return {
      ok: true,
      savedCount: results.length,
      outputPaths: results.map((item) => item.outputPath),
      results,
      url: page.url(),
    };
  });
}

async function saveLatestImage(args = {}) {
  return await saveVisibleImages({
    ...args,
    count: 1,
    outputPath: args.outputPath || `gemini-web-latest-image-${Date.now()}.png`,
  });
}

const tools = [
  { name: "open_gemini", description: "Open Gemini web app in the dedicated CDP browser.", inputSchema: { type: "object", properties: {} } },
  { name: "check_status", description: "Check whether Gemini web app is reachable and signed in.", inputSchema: { type: "object", properties: {} } },
  { name: "inspect_state", description: "Inspect the current Gemini UI state with diagnosis, recommendation, and visible image candidates.", inputSchema: { type: "object", properties: {} } },
  { name: "list_attachments", description: "List currently attached reference files in the visible Gemini composer.", inputSchema: { type: "object", properties: {} } },
  { name: "clear_attachments", description: "Remove all currently attached reference files from the visible Gemini composer.", inputSchema: { type: "object", properties: {} } },
  { name: "list_visible_images", description: "List visible Gemini-generated image candidates on the current page.", inputSchema: { type: "object", properties: {} } },
  {
    name: "ask_gemini",
    description: "Ask Gemini through the signed-in web session using an injected web-session engine.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "generate_image_ui",
    description: "Prefer direct Gemini image requests through CycleTLS-Parity, then fall back to Gemini web UI automation when needed.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, prompts: { type: "array", items: { type: "string" } }, referenceImagePaths: { type: "array", items: { type: "string" } }, referenceImagePathsByItem: { type: "array", items: { type: "array", items: { type: "string" } } }, preserveAttachments: { type: "boolean" }, transport: { type: "string" }, count: { type: "integer" }, concurrency: { type: "integer" }, cooldownMs: { type: "integer" }, continueOnFailure: { type: "boolean" }, outputPath: { type: "string" }, timeoutMs: { type: "integer" }, hardTimeoutMs: { type: "integer" }, freshChat: { type: "boolean" }, useImageTool: { type: "boolean" }, removeGeminiWatermark: { type: "boolean" }, watermarkOutputPath: { type: "string" }, watermarkTimeoutMs: { type: "integer" }, verifyWatermarkRemoval: { type: "boolean" } } },
  },
  {
    name: "wait_for_image",
    description: "Wait for the current Gemini page to finish image generation and save the generated image without submitting a new prompt.",
    inputSchema: { type: "object", properties: { outputPath: { type: "string" }, timeoutMs: { type: "integer" }, hardTimeoutMs: { type: "integer" }, baselineImageCount: { type: "integer" }, baselineSignatures: { type: "array", items: { type: "string" } }, removeGeminiWatermark: { type: "boolean" }, watermarkOutputPath: { type: "string" }, watermarkTimeoutMs: { type: "integer" }, verifyWatermarkRemoval: { type: "boolean" } } },
  },
  {
    name: "save_visible_images",
    description: "Save one or more visible Gemini image candidates from the current page.",
    inputSchema: { type: "object", properties: { outputPath: { type: "string" }, all: { type: "boolean" }, count: { type: "integer" }, imageIndex: { type: "integer" }, imageIndices: { type: "array", items: { type: "integer" } }, removeGeminiWatermark: { type: "boolean" }, watermarkOutputPath: { type: "string" }, watermarkTimeoutMs: { type: "integer" }, verifyWatermarkRemoval: { type: "boolean" } } },
  },
  {
    name: "save_latest_image",
    description: "Save the latest visible generated image from the current Gemini page.",
    inputSchema: { type: "object", properties: { outputPath: { type: "string" }, removeGeminiWatermark: { type: "boolean" }, watermarkOutputPath: { type: "string" }, watermarkTimeoutMs: { type: "integer" }, verifyWatermarkRemoval: { type: "boolean" } } },
  },
  {
    name: "detect_watermark_file",
    description: "Analyze an existing PNG for the Gemini sparkle watermark and optionally write a debug overlay.",
    inputSchema: { type: "object", properties: { inputPath: { type: "string" }, debugOutputPath: { type: "string" } }, required: ["inputPath"] },
  },
  {
    name: "remove_watermark_file",
    description: "Run the bundled Gemini watermark remover on an existing saved PNG file.",
    inputSchema: { type: "object", properties: { inputPath: { type: "string" }, outputPath: { type: "string" }, watermarkTimeoutMs: { type: "integer" }, verifyWatermarkRemoval: { type: "boolean" } }, required: ["inputPath"] },
  },
];

async function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (name === "open_gemini") ok(message.id, await openGemini());
      else if (name === "check_status") ok(message.id, await checkStatus());
      else if (name === "inspect_state") ok(message.id, await inspectState());
      else if (name === "list_attachments") ok(message.id, await listAttachments());
      else if (name === "clear_attachments") ok(message.id, await clearAttachments());
      else if (name === "list_visible_images") ok(message.id, await listVisibleImages());
      else if (name === "ask_gemini") ok(message.id, await askGemini(args));
      else if (name === "generate_image_ui") ok(message.id, await generateImageUi(args));
      else if (name === "wait_for_image") ok(message.id, await waitForImage(args));
      else if (name === "save_visible_images") ok(message.id, await saveVisibleImages(args));
      else if (name === "save_latest_image") ok(message.id, await saveLatestImage(args));
      else if (name === "detect_watermark_file") ok(message.id, await detectWatermarkFile(args));
      else if (name === "remove_watermark_file") ok(message.id, await removeWatermarkFile(args));
      else throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      fail(message.id, error instanceof Error ? error.message : String(error));
    }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const task = (async () => {
      try {
        await handle(JSON.parse(line));
      } catch (error) {
        fail(null, error instanceof Error ? error.message : String(error));
      }
    })();
    pendingMessageTasks.add(task);
    task.finally(() => {
      pendingMessageTasks.delete(task);
    });
  }
});
process.stdin.on("end", async () => {
  await Promise.allSettled([...pendingMessageTasks]);
  await shutdownCycleTlsClient();
  process.exit(0);
});
