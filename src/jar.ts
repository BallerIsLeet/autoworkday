export type Cookie = { n: string; v: string; d: string; p: string; h: boolean };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8";

function domainMatches(host: string, c: Cookie) {
  return c.h ? host === c.d : host === c.d || host.endsWith("." + c.d);
}

function defaultPath(url: URL) {
  const p = url.pathname;
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export class Jar {
  cookies: Cookie[];
  changed = false;

  constructor(cookies: Cookie[] = []) {
    this.cookies = cookies.map((c) => ({ ...c }));
  }

  header(url: URL) {
    const host = url.hostname;
    const path = url.pathname || "/";
    return this.cookies
      .filter((c) => domainMatches(host, c) && path.startsWith(c.p))
      .sort((a, b) => b.p.length - a.p.length)
      .map((c) => `${c.n}=${c.v}`)
      .join("; ");
  }

  store(url: URL, setCookies: string[]) {
    for (const line of setCookies) {
      const parts = line.split(";").map((s) => s.trim());
      const eq = parts[0].indexOf("=");
      if (eq < 1) continue;
      const n = parts[0].slice(0, eq);
      const v = parts[0].slice(eq + 1);
      let d = url.hostname;
      let h = true;
      let p = defaultPath(url);
      let expired = false;
      for (const attr of parts.slice(1)) {
        const i = attr.indexOf("=");
        const key = (i < 0 ? attr : attr.slice(0, i)).toLowerCase();
        const val = i < 0 ? "" : attr.slice(i + 1);
        if (key === "domain" && val) {
          d = val.replace(/^\./, "").toLowerCase();
          h = false;
        } else if (key === "path" && val.startsWith("/")) p = val;
        else if (key === "max-age" && Number(val) <= 0) expired = true;
        else if (key === "expires" && Date.parse(val) < Date.now()) expired = true;
      }
      if (!h && !(url.hostname === d || url.hostname.endsWith("." + d))) continue;
      const i = this.cookies.findIndex((c) => c.n === n && c.d === d && c.p === p);
      const old = i >= 0 ? this.cookies[i] : null;
      if (expired) {
        if (old) {
          this.cookies.splice(i, 1);
          this.changed = true;
        }
        continue;
      }
      if (old && old.v === v && old.h === h) continue;
      if (old) this.cookies.splice(i, 1);
      this.cookies.push({ n, v, d, p, h });
      this.changed = true;
    }
  }
}

export type RequestInit2 = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  follow?: boolean;
};

export async function request(jar: Jar, url: string, init: RequestInit2 = {}) {
  let target = new URL(url);
  let method = init.method ?? "GET";
  let body = init.body;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };

  for (let hop = 0; hop < 20; hop++) {
    const h = new Headers(headers);
    h.set("User-Agent", UA);
    if (!h.has("Accept")) h.set("Accept", DEFAULT_ACCEPT);
    if (!h.has("Accept-Language")) h.set("Accept-Language", "en-US,en;q=0.9");
    const cookie = jar.header(target);
    if (cookie) h.set("Cookie", cookie);

    const res = await fetch(target, { method, headers: h, body, redirect: "manual" });
    jar.store(target, res.headers.getSetCookie());

    const loc = res.headers.get("location");
    if (init.follow !== false && res.status >= 300 && res.status < 400 && loc) {
      await res.arrayBuffer().catch(() => {});
      target = new URL(loc, target);
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
        delete headers["Content-Type"];
      }
      continue;
    }
    return { res, url: target };
  }
  throw new Error("Workday redirected too many times.");
}
