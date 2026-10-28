// The /api/* routes, shared by the local Bun server (server.ts) and the Vercel function (api/index.ts).
import {
  clearPending, clearSession, readPending, readSession, writePending, writeSession,
} from "./session";
import { AuthError, Workday, WorkdayError, completeMfa, login, logout, relogin, type ClockAction, type Pending, type Session } from "./workday";

const CLOCK_ACTIONS: ClockAction[] = ["in", "break", "meal", "out"];

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(body: unknown, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

export function fail(err: unknown, req: Request) {
  const headers = new Headers();
  if (err instanceof AuthError) {
    clearSession(req, headers);
    return json({ error: err.message, signedOut: true }, 401, headers);
  }
  if (err instanceof WorkdayError) return json({ error: err.message }, 502, headers);
  console.error(err);
  return json({ error: "Something went wrong talking to Workday. Try again in a minute." }, 500, headers);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown, max: number) {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

async function withWorkday<T>(req: Request, fn: (wd: Workday) => Promise<T>) {
  const s = await readSession<Session>(req);
  if (!s) return json({ error: "Sign in to see your hours.", signedOut: true }, 401);
  try {
    let wd = new Workday(s);
    let fresh = false;
    let data: T;
    try {
      data = await fn(wd);
    } catch (err) {
      if (!(err instanceof AuthError) || !s.p) throw err;
      console.log("Workday session ended; signing back in with the saved sign-in from the browser cookie");
      wd = new Workday(await relogin(s));
      fresh = true;
      data = await fn(wd);
    }
    const headers = new Headers();
    if (fresh || wd.dirty) await writeSession(req, headers, wd.snapshot());
    return json(data, 200, headers);
  } catch (err) {
    return fail(err, req);
  }
}

export async function api(req: Request, path: string): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "POST" && req.headers.get("x-requested-with") !== "shift-card") {
    return json({ error: "Missing request header." }, 400);
  }

  if (path === "/api/session" && req.method === "GET") {
    const s = await readSession<Session>(req);
    return s ? json({ user: s.u, saved: !!s.p }) : json({ signedOut: true }, 401);
  }

  if (path === "/api/login" && req.method === "POST") {
    const b = await body(req);
    const email = str(b.email, 200);
    const password = str(b.password, 500);
    if (!email || !password) return json({ error: "Enter your work email and password." }, 400);
    try {
      const result = await login(email.trim(), password, b.remember === true);
      const headers = new Headers();
      if (result.kind === "mfa") {
        await writePending(req, headers, result.pending);
        return json({ mfa: result.pending.mfa }, 200, headers);
      }
      clearPending(req, headers);
      await writeSession(req, headers, result.session);
      return json({ user: result.session.u }, 200, headers);
    } catch (err) {
      return fail(err, req);
    }
  }

  if (path === "/api/mfa" && req.method === "POST") {
    const p = await readPending<Pending>(req);
    if (!p) return json({ error: "That sign-in took too long. Start again.", restart: true }, 401);
    const code = str((await body(req)).code, 20)?.replace(/\s+/g, "");
    if (!code) return json({ error: "Enter the verification code." }, 400);
    try {
      const session = await completeMfa(p, code);
      const headers = new Headers();
      clearPending(req, headers);
      await writeSession(req, headers, session);
      return json({ user: session.u }, 200, headers);
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message }, 401);
      return fail(err, req);
    }
  }

  if (path === "/api/logout" && req.method === "POST") {
    const s = await readSession<Session>(req);
    if (s) await logout(s);
    const headers = new Headers();
    clearSession(req, headers);
    return json({ ok: true }, 200, headers);
  }

  if (path === "/api/weeks" && req.method === "GET") {
    const count = Math.min(10, Math.max(1, Number(url.searchParams.get("count")) || 1));
    return withWorkday(req, (wd) => wd.weeks(count));
  }

  if (path === "/api/pay" && req.method === "GET") {
    return withWorkday(req, (wd) => wd.pay());
  }

  if (path === "/api/clock" && req.method === "POST") {
    const b = await body(req);
    const action = CLOCK_ACTIONS.find((a) => a === b.action);
    if (!action) return json({ error: "Unknown time clock action." }, 400);
    return withWorkday(req, (wd) => wd.clock(action, b.dryRun === true));
  }

  return json({ error: "Not found." }, 404);
}
