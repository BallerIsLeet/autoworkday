// Vercel function for every /api/* route. vercel.json rewrites /api/<route> here as ?route=<route>.
import { api, fail } from "../src/app";

async function handle(req: Request) {
  const url = new URL(req.url);
  const route = url.searchParams.get("route");
  const path = route ? `/api/${route}` : url.pathname;
  try {
    return await api(req, path);
  } catch (err) {
    return fail(err, req);
  }
}

export const GET = handle;
export const POST = handle;
