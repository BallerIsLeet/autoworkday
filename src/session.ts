const SESSION = "sc_s";
const PENDING = "sc_p";
const CHUNK = 3800;
const MAX_CHUNKS = 4;

let keyPromise: Promise<CryptoKey> | null = null;

function key() {
  if (!keyPromise) {
    const secret = process.env.SESSION_SECRET;
    let raw: Promise<ArrayBuffer> | Uint8Array;
    if (secret && secret.length >= 32) {
      raw = crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    } else if (process.env.VERCEL) {
      // Each function instance would pick its own random key and sign people out at random
      throw new Error("Set SESSION_SECRET (32+ characters) in the Vercel project's environment variables.");
    } else {
      console.warn("SESSION_SECRET is missing or shorter than 32 characters. Using a random key: everyone is signed out when the server restarts.");
      raw = crypto.getRandomValues(new Uint8Array(32));
    }
    keyPromise = Promise.resolve(raw).then((k) =>
      crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]),
    );
  }
  return keyPromise;
}

function b64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

async function seal(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), data));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

async function unseal<T>(token: string): Promise<T | null> {
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 29) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, await key(), buf.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

function readCookies(req: Request) {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function attrs(req: Request, maxAge: number | null) {
  const url = new URL(req.url);
  const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}${maxAge === null ? "" : `; Max-Age=${maxAge}`}`;
}

type Expiring = { exp: number; r?: boolean };

export async function readSession<T extends Expiring>(req: Request): Promise<T | null> {
  const jar = readCookies(req);
  let token = "";
  for (let i = 0; i < MAX_CHUNKS && jar[`${SESSION}${i}`]; i++) token += jar[`${SESSION}${i}`];
  if (!token) return null;
  const s = await unseal<T>(token);
  return s && s.exp > Date.now() ? s : null;
}

export async function writeSession(req: Request, headers: Headers, s: Expiring) {
  const token = await seal(s);
  const chunks = token.match(new RegExp(`.{1,${CHUNK}}`, "g")) ?? [];
  if (chunks.length > MAX_CHUNKS) throw new Error("Session is too large to store in a cookie.");
  const maxAge = s.r ? Math.max(0, Math.floor((s.exp - Date.now()) / 1000)) : null;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    if (chunks[i]) headers.append("Set-Cookie", `${SESSION}${i}=${chunks[i]}; ${attrs(req, maxAge)}`);
    else headers.append("Set-Cookie", `${SESSION}${i}=; ${attrs(req, 0)}`);
  }
}

export function clearSession(req: Request, headers: Headers) {
  for (let i = 0; i < MAX_CHUNKS; i++) headers.append("Set-Cookie", `${SESSION}${i}=; ${attrs(req, 0)}`);
  headers.append("Set-Cookie", `${PENDING}=; ${attrs(req, 0)}`);
}

export async function readPending<T extends Expiring>(req: Request): Promise<T | null> {
  const token = readCookies(req)[PENDING];
  if (!token) return null;
  const p = await unseal<T>(token);
  return p && p.exp > Date.now() ? p : null;
}

export async function writePending(req: Request, headers: Headers, p: Expiring) {
  headers.append("Set-Cookie", `${PENDING}=${await seal(p)}; ${attrs(req, 600)}`);
}

export function clearPending(req: Request, headers: Headers) {
  headers.append("Set-Cookie", `${PENDING}=; ${attrs(req, 0)}`);
}
