import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";

export const MAX_BODY_BYTES = 1_000_000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function normalizeExternalUrl(value) {
  if (!value || typeof value !== "string") {
    throw new Error("A URL is required.");
  }

  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }
  return url;
}

export async function rejectPrivateHost(url) {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) {
    throw new Error("Local network URLs are not supported.");
  }

  const records = await lookup(host, { all: true, verbatim: true }).catch(
    () => [],
  );
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("Private network URLs are not supported.");
  }
}

function isPrivateAddress(address) {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address) ||
    address.startsWith("169.254.") ||
    address.startsWith("fc") ||
    address.startsWith("fd")
  );
}

export async function ensureCommand(command, installMessage) {
  const result = await runCommand(command, ["--version"], {
    timeoutMs: 10_000,
    allowFailure: true,
  });
  if (result.code !== 0) {
    throw new HttpError(503, `${command} is required. ${installMessage}`);
  }
}

export function runCommand(command, args, options = {}) {
  const { timeoutMs = 60_000, allowFailure = false, input = null } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    if (input != null) {
      // Ignore EPIPE if the child exits before reading all of stdin.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (allowFailure) resolve({ code: 1, stdout, stderr: error.message });
      else reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}
