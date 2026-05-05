import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const serverPath = resolve(scriptDir, "gemini-web-mcp.mjs");
const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const child = spawn(process.execPath, [serverPath], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05" },
})}\n`);
child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
})}\n`);
child.stdin.end();

const exitCode = await new Promise((resolvePromise, rejectPromise) => {
  const timeout = setTimeout(() => {
    child.kill();
    rejectPromise(new Error("Smoke test timed out waiting for the MCP server to exit."));
  }, 15000);
  child.on("error", (error) => {
    clearTimeout(timeout);
    rejectPromise(error);
  });
  child.on("close", (code) => {
    clearTimeout(timeout);
    resolvePromise(code);
  });
});

assert.equal(exitCode, 0, `Expected clean MCP server exit, got ${exitCode}.\n${stderr}`);

const messages = parseJsonLines(stdout);
const initialize = messages.find((message) => message.id === 1);
const toolList = messages.find((message) => message.id === 2);

assert.ok(initialize?.result, `Missing initialize response.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
assert.equal(initialize.result.serverInfo?.name, packageJson.name, "MCP serverInfo.name should match package.json name.");
assert.equal(initialize.result.serverInfo?.version, packageJson.version, "MCP serverInfo.version should match package.json version.");

const toolNames = new Set((toolList?.result?.tools || []).map((tool) => tool.name));
for (const requiredTool of ["ask_gemini", "generate_image_ui", "check_status", "save_latest_image"]) {
  assert.ok(toolNames.has(requiredTool), `Missing required tool "${requiredTool}" in tools/list response.`);
}
