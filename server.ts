// Local server: `bun run server.ts`. On Vercel, api/index.ts serves /api/* and public/ is static.
import { join, normalize, sep } from "node:path";
import { SECURITY_HEADERS, api, fail } from "./src/app.js";

const PUBLIC = join(import.meta.dir, "public");
const PORT = Number(process.env.PORT ?? 3000);
const HOSTNAME = process.env.HOST ?? "127.0.0.1";

async function staticFile(path: string) {
  const rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
  const full = normalize(join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC + sep)) return null;
  const file = Bun.file(full);
  if (!(await file.exists())) return null;
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Cache-Control", "no-cache");
  return new Response(file, { headers });
}

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 120,
  async fetch(req) {
    const started = performance.now();
    const path = new URL(req.url).pathname;
    let res: Response;
    try {
      res = path.startsWith("/api/") ? await api(req, path) : (await staticFile(path)) ?? (await staticFile("/"))!;
    } catch (err) {
      res = fail(err, req);
    }
    if (path.startsWith("/api/")) {
      console.log(`${req.method} ${path} ${res.status} ${Math.round(performance.now() - started)}ms`);
    }
    return res;
  },
});

console.log(`Shift Card running at http://${server.hostname}:${server.port}`);
