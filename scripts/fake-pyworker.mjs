// Stands in for a Python --serve worker in test/pyworker.test.mjs, speaking
// the same line protocol (server/pyworker.mjs). It lives outside test/
// because `node --test` runs every .mjs there.
//
//   {"op": "echo", "value": x}   -> {"id", "value": x, "pid"}
//   {"op": "fail"}               -> {"id", "error": "asked to fail"}
//   {"op": "crash"}              -> exits without answering
//   {"op": "hang"}               -> never answers
//
// FAKE_WORKER_NOT_READY=1 makes it refuse to start.
import readline from "node:readline";

if (process.env.FAKE_WORKER_NOT_READY === "1") {
  process.stdout.write(`${JSON.stringify({ ready: false, error: "no model" })}\n`);
  process.exit(0);
}
process.stdout.write("library chatter that isn't JSON\n");
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "crash") process.exit(3);
  if (req.op === "hang") return;
  const reply = req.op === "fail" ? { id: req.id, error: "asked to fail" } : { id: req.id, value: req.value, pid: process.pid };
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
