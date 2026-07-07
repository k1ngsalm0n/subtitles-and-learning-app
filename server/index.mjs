import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleImportUrl } from "./import.mjs";
import { handleLookup } from "./lookup.mjs";
import { handleTranslate } from "./translate.mjs";
import { serveStatic } from "./static.mjs";
import { sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3000);

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/import-url") {
      await handleImportUrl(req, res);
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/lookup")) {
      await handleLookup(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/api/translate") {
      await handleTranslate(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(req, res, PUBLIC_DIR);
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, {
      error: error.message || "Unexpected server error",
    });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Miraa Studio running at http://localhost:${PORT}`);
});
