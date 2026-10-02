import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
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

// Refuse URLs that point back into this machine or the network it sits on.
//
// Two things get checked, because a hostname can be either: the literal, if it
// is already an address, and every address it resolves to if it is a name.
// Both matter — the old version only looked at resolved records, so bracketed
// IPv6 literals sailed straight past (`lookup("[::1]")` fails, and a failed
// lookup was treated as "fine").
//
// Known limit, and the reason #19 stays worth reading: yt-dlp resolves the
// host again when it fetches, so a name that answers publicly here and
// privately a moment later is not stopped by this. Closing that properly needs
// the fetch pinned to the address we vetted, which yt-dlp gives no way to do.
// What this can do is make sure nothing gets through by simply being written
// in a form the check didn't recognise.
export async function rejectPrivateHost(url) {
  // `hostname` keeps the brackets on an IPv6 literal; nothing downstream wants
  // them, and neither does isIP.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) {
    throw new Error("Local network URLs are not supported.");
  }

  // Already an address: no lookup involved, so no lookup to disagree with.
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error("Private network URLs are not supported.");
    }
    return;
  }

  const records = await lookup(host, { all: true, verbatim: true }).catch(
    () => null,
  );
  // Fail closed. A name this machine can't resolve is one whose destination we
  // cannot check, and letting it through was how numeric-encoded addresses got
  // a free pass.
  if (!records || !records.length) {
    throw new Error("That host could not be resolved.");
  }
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw new Error("Private network URLs are not supported.");
  }
}

// Expand an IPv6 address to its eight groups, or null if it isn't one.
function ipv6Groups(address) {
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  // A trailing IPv4 part (::ffff:127.0.0.1) becomes two groups.
  const last = right.length ? right[right.length - 1] : left[left.length - 1];
  if (last && last.includes(".")) {
    const bytes = last.split(".").map(Number);
    if (bytes.length !== 4 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
      return null;
    }
    const pair = [
      ((bytes[0] << 8) | bytes[1]).toString(16),
      ((bytes[2] << 8) | bytes[3]).toString(16),
    ];
    if (right.length) right.splice(-1, 1, ...pair);
    else left.splice(-1, 1, ...pair);
  }
  const missing = 8 - left.length - right.length;
  if (tail === undefined && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  const parsed = groups.map((g) => parseInt(g || "0", 16));
  return parsed.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : parsed;
}

// The v4 ranges that are not somewhere on the public internet: this machine,
// this network, the link, the carrier's own space, and the block reserved for
// benchmarking. 169.254.169.254 — the cloud metadata endpoint — falls inside
// link-local, which is the one that turns a private fetch into stolen
// credentials. The documentation blocks (192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24) aren't listed: nothing routes them, so there is nothing
// behind them to reach.
//
// This reads as a list because it is one. Every line is a CIDR block with the
// reason it's here; keeping them as one expression is what lets you check the
// set against a reference by eye, which is the only review that matters for a
// table of ranges.
function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable: treat as unsafe rather than guess
  }
  const [a, b] = parts;
  return (
    a === 0 ||                             // 0.0.0.0/8 — "this host"
    a === 10 ||                            // private
    a === 127 ||                           // the whole loopback block
    (a === 100 && b >= 64 && b <= 127) ||  // carrier-grade NAT
    (a === 169 && b === 254) ||            // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||   // private
    (a === 192 && b === 168) ||            // private
    (a === 192 && parts[1] === 0 && parts[2] === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) ||           // benchmarking
    a >= 224                               // multicast and reserved
  );
}

// Two 16-bit groups as the IPv4 address they carry.
const v4From = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");

// The same table for v6, plus the wrapper forms — an address that is really an
// IPv4 one in disguise has to be judged as that address, or ::ffff:127.0.0.1
// walks straight through. Each wrapper is a prefix with the v4 address at a
// fixed place in it; the public ones are allowed only when the address inside
// is public.
function isPrivateIpv6(address) {
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const zero = (from, to) => groups.slice(from, to).every((g) => g === 0);

  // ::ffff:0:0/96, IPv4-mapped: the last 32 bits are the address.
  if (zero(0, 5) && groups[5] === 0xffff) return isPrivateIpv4(v4From(groups[6], groups[7]));
  // 64:ff9b::/96, the well-known NAT64 prefix: on an IPv6-only network this is
  // how every IPv4 site is reached, so it can't be refused wholesale — but
  // 64:ff9b::127.0.0.1 is a gateway being asked for its own loopback.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) {
    return isPrivateIpv4(v4From(groups[6], groups[7]));
  }
  // 2002::/16, 6to4: the IPv4 address is the next 32 bits.
  if (groups[0] === 0x2002) return isPrivateIpv4(v4From(groups[1], groups[2]));

  return (
    zero(0, 6) ||                         // ::/96 — ::, ::1, and the deprecated
                                          //   IPv4-compatible form (::127.0.0.1)
    (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) || // 64:ff9b:1::/48
                                          //   local-use NAT64, private by definition
    (groups[0] & 0xfe00) === 0xfc00 ||    // fc00::/7 unique local
    (groups[0] & 0xffc0) === 0xfe80 ||    // fe80::/10 link-local
    (groups[0] & 0xffc0) === 0xfec0 ||    // fec0::/10 site-local (deprecated)
    (groups[0] & 0xff00) === 0xff00       // ff00::/8 multicast
  );
}

// Anything this can't identify as an address is refused: a check that guesses
// is worse than no check, because it reads as one.
function isPrivateAddress(address) {
  const kind = isIP(address);
  if (kind === 4) return isPrivateIpv4(address);
  if (kind === 6) return isPrivateIpv6(address);
  return true; // not an address we can reason about
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
  const {
    timeoutMs = 60_000,
    allowFailure = false,
    input = null,
    env,
    // Collect stdout as a Buffer instead of a string. Anything that isn't text
    // — a WAV from the speech engine, say — is corrupted by decoding it.
    binary = false,
    // Called with each complete stderr line as it arrives, rather than after
    // the child exits. The long-running Python steps report their progress
    // there (see PROGRESS_PREFIX in transcribe.py / ocr_captions.py), and a
    // progress line delivered at exit is worth nothing. stderr is still
    // accumulated as before, so error reporting is unchanged.
    onStderrLine = null,
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [input != null ? "pipe" : "ignore", "pipe", "pipe"],
      env,
    });
    const stdoutChunks = [];
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
      if (binary) stdoutChunks.push(chunk);
      else stdout += chunk.toString();
    });

    let stderrLine = "";
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (!onStderrLine) return;
      // A chunk arrives when the pipe says so, not when a line ends, so the
      // tail is held back until its newline turns up (same reasoning as the
      // NDJSON parser the browser uses on the import stream).
      stderrLine += text;
      const lines = stderrLine.split("\n");
      stderrLine = lines.pop() ?? "";
      for (const line of lines) onStderrLine(line);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (allowFailure) {
        resolve({
          code: 1,
          stdout: binary ? Buffer.concat(stdoutChunks) : stdout,
          stderr: error.message,
        });
      }
      else reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) {
        resolve({ code, stdout: binary ? Buffer.concat(stdoutChunks) : stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}
