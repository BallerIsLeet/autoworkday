import { Jar, request, type Cookie } from "./jar";
import { parsePayBatch, parsePayslip, parseWeek, previousWeekUri } from "./parse";

const HOST = process.env.WORKDAY_HOST ?? "https://wd5.myworkday.com";
const IDENTITY = process.env.WORKDAY_IDENTITY_HOST ?? "https://wd5-identity.myworkday.com";
const TENANT = process.env.WORKDAY_TENANT ?? "billgosling";
const UPC = `${IDENTITY}/wday/authgwy/${TENANT}/upc/api`;
const CURRENT_WEEK_TASK = `${HOST}/${TENANT}/task/2997$4767.htmld`;
const PAY_TAB = `${HOST}/${TENANT}/inst/12709$177/rel-task/12709$177.htmld`;
const CHECK_IN_TASK = `${HOST}/${TENANT}/task/2997$5195.htmld`;
const CHECK_OUT_TASK = `${HOST}/${TENANT}/task/2997$5196.htmld`;
const FLOW = `${HOST}/${TENANT}/flowController.htmld`;
const WD_CLIENT = "2026.43.23";

export type ClockAction = "in" | "break" | "meal" | "out";
// Check Out form's "Reason" options: Workday instance id and label
const REASONS: Record<Exclude<ClockAction, "in">, [string, string]> = {
  break: ["6371$2", "Break"],
  meal: ["6371$3", "Meal"],
  out: ["6371$1", "Out"],
};

const REMEMBER_MS = 30 * 24 * 3600e3;
const SESSION_MS = 12 * 3600e3;

// p is the Workday password, present only when the user chose "Keep me signed in".
// It lives inside the encrypted browser cookie and is never written anywhere on the server.
export type Session = { c: Cookie[]; t: string; u: string; p?: string; r: boolean; exp: number };
export type Pending = Session & { mfa: string };

export class AuthError extends Error {}
export class WorkdayError extends Error {}

async function visit(jar: Jar, url: string) {
  const out = await request(jar, url);
  await out.res.arrayBuffer().catch(() => {});
  return out;
}

async function fetchCsrf(jar: Jar): Promise<string> {
  const { res } = await request(jar, `${UPC}/csrfToken?${Date.now()}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new WorkdayError(`Workday sign-in is unavailable right now (HTTP ${res.status}).`);
  const token = ((await res.json()) as any)?.csrfToken;
  if (!token) throw new WorkdayError("Workday did not return a sign-in token.");
  return token;
}

async function postUpc(jar: Jar, token: string, path: string, body: unknown = {}) {
  const { res } = await request(jar, `${UPC}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Session-Secure-Token": token,
      "X-Workday-Client": "UPCUI",
    },
    body: JSON.stringify(body),
    follow: false,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  return { res, data };
}

function absolute(next: string, base: string) {
  return next.startsWith("http") ? next : `${base}${next}`;
}

async function finish(jar: Jar, token: string, next: string | null, user: string, remember: boolean, password?: string): Promise<Session> {
  if (next) {
    const { res } = await visit(jar, absolute(next, IDENTITY));
    if (!res.ok) throw new AuthError("Workday didn't finish signing you in. Try again.");
  }
  return {
    c: jar.cookies, t: token, u: user, r: remember,
    ...(remember && password ? { p: password } : {}),
    exp: Date.now() + (remember ? REMEMBER_MS : SESSION_MS),
  };
}

export type LoginResult = { kind: "done"; session: Session } | { kind: "mfa"; pending: Pending };

export async function login(user: string, password: string, remember: boolean): Promise<LoginResult> {
  const jar = new Jar();
  await visit(jar, `${HOST}/${TENANT}/d/`);
  await visit(jar, `${IDENTITY}/wday/authgwy/${TENANT}/upc/login`);
  const token = await fetchCsrf(jar);

  const { res, data } = await postUpc(jar, token, "/auth/login-auth", { userName: user, password });
  if (data?.errorMessage) throw new AuthError(String(data.errorMessage));
  if (res.status === 401 || res.status === 403) throw new AuthError("Workday didn't accept that email and password.");
  if (!res.ok || !data) throw new WorkdayError(`Workday sign-in failed (HTTP ${res.status}).`);

  let next: string | null = data.nextUrl ?? null;

  if (data.authStatus === "MFA_REQUIRED") {
    const summaryUrl = absolute(data.nextUrl ?? "/auth/mfa/summary", UPC);
    const { res: sres } = await request(jar, summaryUrl, {
      headers: { "Session-Secure-Token": token, Accept: "application/json" },
    });
    if (!sres.ok) throw new WorkdayError("Workday asked for a verification code, but the code options didn't load.");
    const summary: any = await sres.json();
    const types: string[] = (summary?.mfaConfig ?? []).map((m: any) => m?.mfaType).filter(Boolean);
    const mfa = types.find((t) => t === "totp" || t === "email");
    if (!mfa) {
      throw new WorkdayError(
        `Workday wants a verification method this app can't handle (${types.join(", ") || "unknown"}). Sign in on Workday once, then try again.`,
      );
    }
    if (mfa === "email") await postUpc(jar, token, "/auth/mfa/email/init");
    return {
      kind: "mfa",
      pending: {
        c: jar.cookies, t: token, u: user, r: remember, mfa,
        ...(remember ? { p: password } : {}),
        exp: Date.now() + 10 * 60e3,
      },
    };
  }

  if (data.authStatus === "TRUST_REQUIRED") {
    const trust = await postUpc(jar, token, "/device/skip");
    if (!trust.res.ok) throw new WorkdayError(`Workday's device check failed (HTTP ${trust.res.status}).`);
    next = trust.data?.nextUrl ?? null;
  }

  return { kind: "done", session: await finish(jar, token, next, user, remember, password) };
}

export async function relogin(s: Session): Promise<Session> {
  if (!s.p) throw new AuthError("Your Workday session has ended. Sign in again.");
  let result: LoginResult;
  try {
    result = await login(s.u, s.p, true);
  } catch (err) {
    if (err instanceof AuthError) throw new AuthError("Workday no longer accepts your saved password. Sign in again.");
    throw err;
  }
  if (result.kind === "mfa") throw new AuthError("Workday wants a verification code. Sign in again to enter it.");
  return result.session;
}

export async function completeMfa(p: Pending, code: string): Promise<Session> {
  const jar = new Jar(p.c);
  const { res, data } = await postUpc(jar, p.t, `/auth/mfa/${p.mfa}/verify`, { verificationCode: code });
  if (!res.ok || data?.errorMessage) throw new AuthError(data?.errorMessage ?? "That code didn't work. Check it and try again.");
  return finish(jar, p.t, data?.nextUrl ?? null, p.u, p.r, p.p);
}

export async function logout(s: Session) {
  const jar = new Jar(s.c);
  await visit(jar, `${HOST}/wday/authgwy/${TENANT}/logout.htmld`).catch(() => {});
}

export class Workday {
  private jar: Jar;
  private s: Session;
  private tokenChanged = false;

  constructor(s: Session) {
    this.s = { ...s };
    this.jar = new Jar(s.c);
  }

  get dirty() {
    return this.jar.changed || this.tokenChanged;
  }

  snapshot(): Session {
    return { ...this.s, c: this.jar.cookies };
  }

  private async json(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { res } = await request(this.jar, url, {
        method: init.method,
        body: init.body,
        headers: { "Session-Secure-Token": this.s.t, Accept: "application/json", ...(init.headers ?? {}) },
      });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.includes("json")) return (await res.json()) as any;
      const text = await res.text();
      if (res.ok && type.includes("xml")) {
        const msg = /<wml:Message>([^<]*)/.exec(text)?.[1];
        throw new WorkdayError(msg ? `Workday returned an error: ${msg}` : "Workday returned an error.");
      }
      if (res.status >= 500) throw new WorkdayError(`Workday is having trouble right now (HTTP ${res.status}).`);
      if (attempt === 0) {
        try {
          const t = await fetchCsrf(this.jar);
          if (t !== this.s.t) {
            this.s.t = t;
            this.tokenChanged = true;
          }
          continue;
        } catch {
          break;
        }
      }
    }
    throw new AuthError("Your Workday session has ended. Sign in again.");
  }

  async weeks(count: number) {
    let data = await this.json(CURRENT_WEEK_TASK);
    const user: string | null = data?.currentUser?.label ?? null;
    const weeks = [parseWeek(data)];
    while (weeks.length < count) {
      const uri = previousWeekUri(data);
      if (!uri) break;
      data = await this.json(`${HOST}${uri}.htmld`);
      weeks.push(parseWeek(data));
    }
    return { user, weeks };
  }

  async pay() {
    const landing = await this.json(PAY_TAB);
    const worklets: any[] = landing?.body?.children ?? [];
    const form = new URLSearchParams();
    for (const w of worklets) if (w.instanceId && w.taskIid) form.append("instance-ids", w.instanceId);
    for (const w of worklets) if (w.instanceId && w.taskIid) form.append("task-ids", w.taskIid);
    if (!form.has("task-ids")) throw new WorkdayError("Workday's Pay page had no payslip sections.");
    const batch = await this.json(`${HOST}/${TENANT}/tasksAsBatch.htmld`, {
      method: "POST",
      body: form.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Workday-Client": "2026.43.23" },
    });
    const pay = parsePayBatch(batch);
    // The newest payslip has the real hourly rate and what deductions took
    const newest = [...pay.payslips].sort((a, b) => b.date.localeCompare(a.date))[0];
    pay.latest = null;
    if (newest?.view?.startsWith(`/${TENANT}/`)) {
      try {
        pay.latest = parsePayslip(await this.json(`${HOST}${newest.view}.htmld`), newest.date);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        console.warn("Couldn't read the latest payslip:", (err as Error).message);
      }
    }
    for (const p of pay.payslips) delete p.view;
    return pay;
  }

  // Check in, or check out for a break, meal or the end of the day. Workday forms are
  // server-side flows: GET the task to open one, then POST field changes and the final
  // OK to flowController. Node ids change on every load, so they're read from the form.
  // With dryRun the reason is still validated, then the form is cancelled unsubmitted.
  async clock(action: ClockAction, dryRun = false): Promise<{ ok: true; message: string }> {
    const form = await this.json(action === "in" ? CHECK_IN_TASK : CHECK_OUT_TASK);
    if (!form?.flowExecutionKey || !form?.body?.id) throw new WorkdayError("Workday's time clock form didn't open.");
    try {
      if (action !== "in") {
        const [iid, label] = REASONS[action];
        const field = findField(form.body, "wd:Check_Out_Reason--IS");
        const text = await this.flow(form, {
          _eventId_add: field, [field]: iid, [`${iid}_DID`]: label, [`${iid}_IID`]: iid,
        });
        if (!text.includes("selectedIds") || !text.includes(`"${field}.`)) {
          throw new WorkdayError(`Workday didn't accept "${label}" as the reason. ${errorText(text)}`);
        }
      }
      const ok = findField(form.body, "wd:OK");
      if (dryRun) {
        await this.cancel(form);
        return { ok: true, message: `Dry run: Workday accepted the form; nothing was submitted.` };
      }
      const text = await this.flow(form, {
        _eventId_submit: String(form.body.id),
        "change-summary":
          '<wml:Change_Summary xmlns:wml="http://www.workday.com/ns/model/1.0" ' +
          'xmlns:wd="urn:com.workday/bsvc" xmlns:nyw="urn:com.netyourwork/aod">' +
          `<wd:OK Ref="${ok}" Replaced=""><V>1</V></wd:OK></wml:Change_Summary>`,
      });
      const done = /You have successfully[^"<]*/.exec(text)?.[0];
      if (!done) throw new WorkdayError(`Workday didn't confirm the punch. ${errorText(text)}`);
      return { ok: true, message: done.trim().replace(/\.+$/, ".") };
    } catch (err) {
      // An open, unsubmitted form counts against Workday's concurrent-request limit
      await this.cancel(form);
      throw err;
    }
  }

  private async flow(form: any, fields: Record<string, string>) {
    const body = new URLSearchParams({ _flowExecutionKey: form.flowExecutionKey, ...fields, sessionSecureToken: form.sessionSecureToken });
    const { res } = await request(this.jar, FLOW, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Session-Secure-Token": form.sessionSecureToken,
        Accept: "application/json",
        "X-Workday-Client": WD_CLIENT,
      },
    });
    const text = await res.text();
    if (res.status >= 500) throw new WorkdayError(`Workday is having trouble right now (HTTP ${res.status}).`);
    if (!res.ok) throw new AuthError("Your Workday session has ended. Sign in again.");
    return text;
  }

  private async cancel(form: any) {
    await this.flow(form, { _eventId_cancel: "Cancel" }).catch(() => {});
  }
}

function findField(root: any, property: string): string {
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (Array.isArray(o)) stack.push(...o);
    else if (o && typeof o === "object") {
      if (o.propertyName === property && o.hideAdvice !== "ALWAYS" && o.id) return String(o.id);
      for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
    }
  }
  throw new WorkdayError(`Workday's time clock form changed (no ${property} field).`);
}

function errorText(text: string) {
  return /<wml:Message>([^<]+)/.exec(text)?.[1] ?? /"(?:message|errorMessage)"\s*:\s*"([^"]+)/.exec(text)?.[1] ?? "";
}
