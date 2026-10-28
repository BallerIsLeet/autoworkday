(function () {
'use strict';

/* ---------------- helpers ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const TZ = 'America/Toronto';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const cad = new Intl.NumberFormat('en-CA', {style: 'currency', currency: 'CAD'});
const money = v => (v == null || !isFinite(v)) ? '—' : cad.format(v).replace(/ /g, ' ').replace('CA$', '$');
const partsFmt = new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
const todayFmt = new Intl.DateTimeFormat('en-CA', {timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric'});

function nowTZ() {
  const d = new Date();
  const p = Object.fromEntries(partsFmt.formatToParts(d).map(x => [x.type, x.value]));
  return {date: p.year + '-' + p.month + '-' + p.day, min: (+p.hour) * 60 + (+p.minute) + ((+p.second) + d.getMilliseconds() / 1000) / 60};
}
function fmtMin(min) {
  if (min == null) return '—';
  let t = Math.round(min) % 1440; if (t < 0) t += 1440;
  const h = Math.floor(t / 60), m = t % 60;
  return ((h % 12) || 12) + ':' + pad(m) + ' ' + (h < 12 ? 'a.m.' : 'p.m.');
}
function setHTML(el, html) { if (el.__html !== html) { el.innerHTML = html; el.__html = html; } }
function fmtEnd(min) { return min == null ? '—' : fmtMin(min) + (min >= 1440 ? ' next day' : ''); }
function hms(min) { const t = Math.max(0, Math.floor(min * 60)); return Math.floor(t / 3600) + ':' + pad(Math.floor(t % 3600 / 60)) + ':' + pad(t % 60); }
function hm(min) { const t = Math.max(0, Math.round(min)); const h = Math.floor(t / 60), m = t % 60; return h ? h + 'h ' + pad(m) + 'm' : m + ' min'; }
function hrs(h) { return (Math.round(h * 100) / 100).toFixed(2); }
function isoParts(iso) { const [y, m, d] = iso.split('-').map(Number); return {y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay()}; }
function shortDate(iso, withDow) { if (!iso) return '—'; const p = isoParts(iso); return (withDow ? DAYS[p.dow] + ', ' : '') + MONTHS[p.m - 1] + ' ' + p.d; }
function dayDiff(a, b) { const A = isoParts(a), B = isoParts(b); return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 864e5); }
function inDays(n) { return n > 1 ? 'in ' + n + ' days' : n === 1 ? 'tomorrow' : n === 0 ? 'today' : (-n) + ' days ago'; }

let reduceMotion = false;
try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

/* ---------------- settings (this browser only) ---------------- */
const DEFAULTS = {rate: null, unpaid: 1, target: 7.5, weekTarget: 37.5, skipBreaks: false};
let settings = Object.assign({}, DEFAULTS);
try { Object.assign(settings, JSON.parse(localStorage.getItem('shiftcard-settings') || '{}')); } catch (e) {}
function saveSettings() { try { localStorage.setItem('shiftcard-settings', JSON.stringify(settings)); } catch (e) {} }

/* ---------------- state ---------------- */
const state = {
  user: null, name: null,
  weeks: [], weeksLoaded: 0, weeksLoading: false,
  updatedAt: 0, refreshing: false,
  pay: null, payLoading: false, payError: null,
  wkIdx: 0, flagScope: 'all',
};

/* ---------------- API ---------------- */
class ApiError extends Error {}
async function api(path, opts) {
  opts = opts || {};
  const init = {method: opts.method || 'GET', headers: {Accept: 'application/json'}, credentials: 'same-origin'};
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  if (init.method !== 'GET') init.headers['X-Requested-With'] = 'shift-card';
  let res;
  try { res = await fetch(path, init); }
  catch (e) { throw new ApiError("Can't reach the Shift Card server. Check that it's running."); }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new ApiError(data.error || 'Request failed (HTTP ' + res.status + ').');
    err.status = res.status; err.data = data;
    if (res.status === 401 && data.signedOut && !opts.auth) signedOut(data.error);
    throw err;
  }
  return data;
}

/* ---------------- banner ---------------- */
let retryFn = null;
function showBanner(msg, retry) { $('#bannerText').textContent = msg; retryFn = retry || null; $('#bannerRetry').hidden = !retry; $('#banner').hidden = false; }
function hideBanner() { $('#banner').hidden = true; }
$('#bannerRetry').addEventListener('click', () => { hideBanner(); if (retryFn) retryFn(); });

/* ---------------- routing ---------------- */
const VIEWS = ['home', 'timings', 'payslips', 'login'];
let firstRoute = true;
function go(v) {
  try { history.pushState(null, '', '#' + v); } catch (e) {}
  route(v);
}
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href^="#"]');
  if (!a) return;
  const v = a.getAttribute('href').slice(1);
  if (!VIEWS.includes(v)) return;
  e.preventDefault();
  go(v);
});
window.addEventListener('popstate', () => route());
window.addEventListener('hashchange', () => route());
function route(forced) {
  let v = typeof forced === 'string' ? forced : (location.hash || '').replace('#', '');
  if (!VIEWS.includes(v)) v = 'home';
  if (!state.user) v = 'login';
  else if (v === 'login') v = 'home';
  VIEWS.forEach(n => { $('#view-' + n).hidden = n !== v; });
  document.body.classList.toggle('is-login', v === 'login');
  $$('[data-nav]').forEach(a => { if (a.dataset.nav === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (!firstRoute) {
    const h = $('#view-' + v + ' h1');
    if (h) h.focus({preventScroll: true});
    window.scrollTo(0, 0);
  }
  firstRoute = false;
  if (v === 'timings') ensureWeeks(5);
  if (v === 'payslips' || v === 'home') ensurePay();
  if (v === 'timings') renderTimings();
  if (v === 'payslips') renderPay();
}

/* ---------------- login ---------------- */
let mfaPending = false;
function setLoginBusy(busy, text) {
  const b = $('#signinBtn');
  b.disabled = busy;
  if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  $('#signinText').textContent = text;
}
function loginError(msg) { const el = $('#loginError'); el.textContent = msg || ''; el.hidden = !msg; }
function resetLogin(msg) {
  mfaPending = false;
  $('#credFields').hidden = false; $('#mfaFields').hidden = true; $('#mfaRestart').hidden = true;
  $('#loginLede').textContent = 'Sign in with your Workday account to see your hours and pay.';
  $('#password').value = ''; $('#mfaCode').value = '';
  setLoginBusy(false, 'Sign in');
  loginError(msg);
}
$('#mfaRestart').addEventListener('click', () => { resetLogin(); $('#email').focus(); });
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('#signinBtn').disabled) return;
  loginError('');
  try {
    let res;
    if (mfaPending) {
      const code = $('#mfaCode').value.trim();
      if (!code) { loginError('Enter the verification code.'); $('#mfaCode').focus(); return; }
      setLoginBusy(true, 'Checking code…');
      res = await api('/api/mfa', {method: 'POST', body: {code}, auth: true});
    } else {
      const email = $('#email').value.trim(), password = $('#password').value;
      if (!email || !password) { loginError('Enter your work email and password.'); (email ? $('#password') : $('#email')).focus(); return; }
      setLoginBusy(true, 'Signing in to Workday…');
      res = await api('/api/login', {method: 'POST', body: {email, password, remember: $('#remember').checked}, auth: true});
      if (res.mfa) {
        mfaPending = true;
        $('#credFields').hidden = true; $('#mfaFields').hidden = false; $('#mfaRestart').hidden = false;
        $('#mfaNote').textContent = res.mfa === 'email' ? 'Workday emailed you a verification code. Enter it below.' : 'Enter the code from your authenticator app.';
        $('#loginLede').textContent = 'One more step.';
        setLoginBusy(false, 'Verify');
        $('#mfaCode').focus();
        return;
      }
    }
    $('#password').value = ''; $('#mfaCode').value = '';
    mfaPending = false;
    setLoginBusy(false, 'Sign in');
    signedIn(res.user);
  } catch (err) {
    if (err.data && err.data.restart) { resetLogin(err.message); return; }
    setLoginBusy(false, mfaPending ? 'Verify' : 'Sign in');
    loginError(err.message);
  }
});

function signedIn(user) {
  state.user = user;
  hideBanner();
  const want = (location.hash || '').replace('#', '');
  go(VIEWS.includes(want) && want !== 'login' ? want : 'home');
  refreshCurrent();
  ensurePay();
}
function signedOut(msg) {
  const wasIn = !!state.user;
  Object.assign(state, {user: null, name: null, weeks: [], weeksLoaded: 0, weeksLoading: false, pay: null, payLoading: false, payError: null, updatedAt: 0, wkIdx: 0});
  resetLogin(wasIn ? (msg || 'You were signed out. Sign in again.') : '');
  route('login');
}
$('#signoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', {method: 'POST', auth: true}); } catch (e) {}
  signedOut();
  loginError('');
});

/* ---------------- data loading ---------------- */
async function refreshCurrent() {
  if (!state.user || state.refreshing) return;
  state.refreshing = true;
  $('#refreshBtn').disabled = true; $('#refreshBtn').classList.add('spinning');
  try {
    const data = await api('/api/weeks?count=1');
    if (data.user) state.name = data.user;
    state.weeks[0] = data.weeks[0];
    if (!state.weeksLoaded) state.weeksLoaded = 1;
    state.updatedAt = Date.now();
    hideBanner();
    renderTimings();
  } catch (err) {
    if (state.user) showBanner(err.message, refreshCurrent);
  } finally {
    state.refreshing = false;
    $('#refreshBtn').disabled = false; $('#refreshBtn').classList.remove('spinning');
    tick();
  }
}
$('#refreshBtn').addEventListener('click', () => { refreshCurrent(); if (state.pay === null) ensurePay(); });

async function ensureWeeks(n) {
  if (!state.user || state.weeksLoading || state.weeksLoaded >= n) return;
  state.weeksLoading = true;
  renderTimings();
  try {
    const data = await api('/api/weeks?count=' + n);
    state.weeks = data.weeks;
    state.weeksLoaded = n;
    if (data.weeks.length < n) state.noMoreWeeks = true;
    if (data.user) state.name = data.user;
    state.updatedAt = Date.now();
    hideBanner();
  } catch (err) {
    if (state.user) showBanner(err.message, () => ensureWeeks(n));
  } finally {
    state.weeksLoading = false;
    renderTimings();
  }
}

async function ensurePay() {
  if (!state.user || state.payLoading || state.pay) return;
  state.payLoading = true; state.payError = null;
  renderPay();
  try { state.pay = await api('/api/pay'); }
  catch (err) { state.payError = err.message; }
  finally { state.payLoading = false; renderPay(); tick(); }
}

/* ---------------- day model ---------------- */
function dayModel(week, date) {
  const es = week.entries.filter(e => e.date === date);
  const blocks = es.filter(e => e.kind === 'work' && e.start != null && e.end != null).sort((a, b) => a.start - b.start);
  const ins = es.filter(e => e.kind === 'in' && e.start != null).sort((a, b) => a.start - b.start);
  const outs = es.filter(e => e.kind === 'out' && e.end != null).sort((a, b) => a.end - b.end);
  const deduct = es.filter(e => e.kind === 'deduct');
  const lastEnd = blocks.length ? blocks[blocks.length - 1].end : -1;
  const open = ins.filter(i => i.start >= lastEnd).pop() || null;
  const day = week.days.find(d => d.date === date);
  return {
    date, es, blocks, ins, outs, deduct, open,
    unpaid: deduct.filter(d => !d.paid).reduce((a, d) => a + Math.abs(d.hours || 0), 0),
    hasDeduct: deduct.length > 0,
    hasMeal: deduct.some(d => /meal/i.test(d.type)) || blocks.some(b => /meal|lunch/i.test(b.reason || '')),
    total: day ? day.total : 0,
    label: day ? day.label : date,
    saved: es.filter(e => e.status === 'saved').length,
    onBlocks: blocks.reduce((a, b) => a + (b.end - b.start), 0),
  };
}
const isBreakReason = r => /break/i.test(r || '');
const isMealReason = r => /meal|lunch/i.test(r || '');

/* ---------------- actual start (this browser only) ---------------- */
// Until a manager corrects a missed clock-in, the real start time lives here per day
const adjKey = date => 'shiftcard-start-' + date;
function getAdjStart(date) {
  try { const v = localStorage.getItem(adjKey(date)); return v == null || v === '' || !isFinite(+v) ? null : +v; } catch (e) { return null; }
}
function setAdjStart(date, min) {
  try { if (min == null) localStorage.removeItem(adjKey(date)); else localStorage.setItem(adjKey(date), String(min)); } catch (e) {}
}

function liveToday() {
  const now = nowTZ();
  const week = state.weeks[0];
  if (!week) return null;
  const m = dayModel(week, now.date);
  // Workday's first punch today; an earlier actual start fills the gap with worked time
  const realFirst = m.blocks.length ? m.blocks[0].start : (m.open ? m.open.start : null);
  const adjStart = getAdjStart(now.date);
  const adjusted = adjStart != null && realFirst != null && adjStart < realFirst;
  if (adjusted) {
    m.blocks.unshift({kind: 'work', start: adjStart, end: realFirst, reason: null, adjusted: true});
    m.onBlocks += realFirst - adjStart;
  }
  const last = m.blocks[m.blocks.length - 1];
  const outAfter = last ? m.outs.some(o => o.end >= last.end) : m.outs.length > 0;
  let status = 'none', since = null;
  if (m.open) { status = 'in'; since = m.open.start; }
  else if (last && isMealReason(last.reason) && !outAfter) { status = 'meal'; since = last.end; }
  else if (last && isBreakReason(last.reason) && !outAfter) { status = 'break'; since = last.end; }
  else if (last || m.outs.length) { status = 'out'; since = Math.max(last ? last.end : 0, ...m.outs.map(o => o.end)); }
  const onClock = m.onBlocks + (m.open ? Math.max(0, now.min - m.open.start) : 0);
  const target = settings.target * 60;
  // Unpaid break time still to come: Workday's posted deductions once they exist, otherwise the
  // Settings estimate, or none when breaks are skipped to leave early
  const planned = skip => (m.hasDeduct ? m.unpaid : skip ? 0 : settings.unpaid) * 60;
  const unpaid = planned(settings.skipBreaks);
  const clockTarget = target + unpaid;
  const altRemaining = target + planned(!settings.skipBreaks) - onClock;
  let paid = clockTarget > 0 ? onClock * target / clockTarget : 0;
  if (status === 'out' && m.total > 0 && !adjusted) paid = m.total * 60;
  const remaining = clockTarget - onClock;
  const first = m.blocks.length ? m.blocks[0].start : (m.open ? m.open.start : null);
  return {now, week, m, status, since, onClock, paid, target, unpaid, clockTarget, remaining, altRemaining, first, last, realFirst, adjStart, adjusted};
}

/* ---------------- home ---------------- */
const cdEl = $('#countdown');
let cdLast = '';
function renderCountdown(str) {
  if (str === cdLast) return;
  const chars = str.split('');
  if (cdEl.childElementCount !== chars.length) {
    cdEl.innerHTML = chars.map(ch => '<span class="' + (ch === ':' ? 'c' : ch === '+' ? 'sgn' : 'd') + '"></span>').join('');
  }
  chars.forEach((ch, i) => { const s = cdEl.children[i]; if (s.textContent !== ch) s.textContent = ch; });
  cdLast = str;
}
const punchesEl = $('#punches');
punchesEl.innerHTML = Array.from({length: 30}, (_, i) => '<i' + ((i % 4 === 3 && i < 29) ? ' class="hr"' : '') + '></i>').join('');
const holes = Array.from(punchesEl.children);

const STAMP = {
  in: {cls: 'st-in', word: 'Clocked in', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle class="pulse" cx="10" cy="10" r="6" fill="currentColor"/></svg>'},
  break: {cls: 'st-break', word: 'On break', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="4" width="3.5" height="12" fill="currentColor"/><rect x="11.5" y="4" width="3.5" height="12" fill="currentColor"/></svg>'},
  meal: {cls: 'st-meal', word: 'Meal break', icon: '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9h14a7 7 0 0 1-14 0zM7 5v-2M10 5V2M13 5v-2"/></svg>'},
  out: {cls: 'st-out', word: 'Clocked out', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="4" width="12" height="12" fill="currentColor"/></svg>'},
  none: {cls: 'st-out', word: 'Not clocked in', icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="4" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"/></svg>'},
};
let stampKey = '';

function tick() {
  if (!state.user) return;
  const L = liveToday();
  const now = nowTZ();
  $('#todayLabel').textContent = todayFmt.format(new Date()) + ' · Eastern time';
  if (state.name) $('#nameTxt').textContent = state.name;
  if (state.updatedAt) {
    const ago = Math.floor((Date.now() - state.updatedAt) / 60000);
    $('#syncTxt').textContent = 'From Workday ' + (ago < 1 ? 'just now' : ago + ' min ago');
  }
  if (!L) { renderMoney(null); renderSummary(null); return; }

  // stamp
  const st = STAMP[L.status];
  const sub = L.status === 'none' ? 'no check-in yet today' : 'since ' + fmtMin(L.since);
  const key = L.status + sub;
  if (key !== stampKey) {
    const el = $('#statusStamp');
    el.className = 'stamp stamp-big ' + st.cls;
    el.innerHTML = st.icon + '<span><span class="word">' + st.word + '</span><br><span class="sub">' + esc(sub) + '</span></span>';
    stampKey = key;
  }
  setHTML($('#clockInTxt'), L.first != null ? esc(fmtMin(L.first)) + (L.adjusted ? '<span class="adj-tag">actual</span>' : '') : '—');
  $('#adjBtn').hidden = L.realFirst == null;

  // countdown
  const over = L.remaining <= 0;
  const live = L.status === 'in';
  cdEl.classList.toggle('over', over && L.status !== 'none');
  cdEl.classList.toggle('paused', L.status === 'break' || L.status === 'meal');
  cdEl.classList.toggle('stopped', L.status === 'out' || L.status === 'none');
  const remainingPaid = L.clockTarget > 0 ? Math.abs(L.remaining) : 0;
  renderCountdown((over ? '+' : '') + hms(remainingPaid));
  const unpaidTxt = hm(L.unpaid);
  $('#countLabel').textContent =
    L.status === 'none' ? 'Your day, once you clock in' :
    over ? 'Past ' + settings.target + ' paid hours by' :
    L.status === 'in' ? 'On the clock until ' + settings.target + ' paid hours' :
    L.status === 'out' ? 'Short of ' + settings.target + ' paid hours' :
    'Left until ' + settings.target + ' paid hours · paused on break';
  $('#countSr').textContent = (over ? 'Over by ' : 'Time left: ') + hms(remainingPaid);
  const fl = $('#finishLine');
  const unpaidNote = L.unpaid > 0 ? ' <span class="muted">· includes ' + esc(unpaidTxt) + ' unpaid break' + (L.m.hasDeduct ? ' from Workday' : '') + '</span>' : '';
  if (L.status === 'none') fl.innerHTML = 'Check in above to start. Starting now, you\'d be done at <strong>' + esc(fmtMin(now.min + L.clockTarget)) + '</strong>' + unpaidNote;
  else if (L.status === 'out') fl.innerHTML = over ? 'You finished your ' + settings.target + ' paid hours today.' : 'You clocked out <strong>' + esc(hm(L.remaining)) + '</strong> short on the clock.';
  else if (over) fl.innerHTML = 'Reached ' + settings.target + ' h at <strong>' + esc(fmtMin(now.min + L.remaining)) + '</strong> <span class="muted">· anything after is extra time</span>';
  else if (live) fl.innerHTML = 'Done at <strong>' + esc(fmtMin(now.min + L.remaining)) + '</strong>' + unpaidNote;
  else fl.innerHTML = 'Done at <strong>' + esc(fmtMin(now.min + L.remaining)) + '</strong> <span class="muted">if you check back in now · ' + (L.status === 'meal' ? 'meal' : 'break') + ' running ' + esc(hm(now.min - L.since)) + '</span>';
  renderBreakMode(L, now, over);

  // punches
  const q = L.paid / 15;
  holes.forEach((h, i) => {
    const hr = (i % 4 === 3 && i < 29) ? ' hr' : '';
    if (i < Math.floor(q)) { h.className = 'on' + hr; h.style.removeProperty('--p'); }
    else if (i === Math.floor(q)) { h.className = 'part' + hr; h.style.setProperty('--p', Math.round((q - i) * 100) + '%'); }
    else { h.className = hr.trim(); h.style.removeProperty('--p'); }
  });
  const pct = L.target > 0 ? Math.min(100, L.paid / L.target * 100) : 0;
  punchesEl.setAttribute('aria-label', Math.min(30, Math.floor(q)) + ' of 30 quarter-hours paid, ' + Math.floor(pct) + ' percent of the day');
  $('#workedTxt').textContent = hms(L.paid);
  $('#targetTxt').textContent = hms(L.target);
  $('#pctTxt').textContent = Math.floor(pct) + '%';

  renderTimeline(L);
  renderMoney(L);
  renderSummary(L);
  renderClock(L);
  renderTodayWarnings(L);
}

/* ---------------- breaks: take them or skip to leave early ---------------- */
function renderBreakMode(L, now, over) {
  $$('#brkMode button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.brk === 'skip') === !!settings.skipBreaks)));
  const alt = $('#altFinish');
  // The two modes only differ while breaks are still a plan, not once Workday has posted them
  const differs = !L.m.hasDeduct && settings.unpaid > 0;
  const going = L.status === 'in' || L.status === 'break' || L.status === 'meal' || L.status === 'none';
  if (!differs || !going || over) { alt.hidden = true; $('#brkMode').hidden = !differs || L.status === 'out'; return; }
  $('#brkMode').hidden = false;
  const altEnd = now.min + L.altRemaining;
  setHTML(alt, settings.skipBreaks
    ? 'Taking your ' + esc(hm(settings.unpaid * 60)) + ' of breaks: done at <strong>' + esc(fmtMin(altEnd)) + '</strong>'
    : 'Skipping breaks to leave early: done at <strong>' + esc(fmtMin(altEnd)) + '</strong>');
  alt.hidden = false;
}
$('#brkMode').addEventListener('click', e => {
  const b = e.target.closest('button[data-brk]');
  if (!b) return;
  settings.skipBreaks = b.dataset.brk === 'skip';
  saveSettings();
  tick();
});

/* ---------------- time clock ---------------- */
const CLOCK = {
  in: {label: 'Check in', back: 'Back from break', confirm: 'Tap to check in', done: 'Checked in'},
  break: {label: 'Start break', confirm: 'Tap to start break', done: 'Break started'},
  meal: {label: 'Start meal', confirm: 'Tap to start meal', done: 'Meal started'},
  out: {label: 'Clock out', confirm: 'Tap to clock out for the day', done: 'Clocked out'},
};
// Which buttons make sense for each status
const CLOCK_FOR = {none: ['in'], out: ['in'], in: ['break', 'meal', 'out'], break: ['in'], meal: ['in']};
let clockBusy = false, armed = null, armTimer = 0;

function disarm() {
  clearTimeout(armTimer);
  armed = null;
  $$('.clock-btn').forEach(b => b.removeAttribute('data-armed'));
}

function renderClock(L) {
  const status = L ? L.status : 'none';
  const show = CLOCK_FOR[status] || ['in'];
  $$('.clock-btn').forEach(b => {
    const a = b.dataset.clock;
    b.hidden = !show.includes(a);
    b.disabled = clockBusy;
    const label = armed === a ? CLOCK[a].confirm : (a === 'in' && (status === 'break' || status === 'meal') ? CLOCK.in.back : CLOCK[a].label);
    const t = b.querySelector('.t');
    if (t.textContent !== label) t.textContent = label;
  });
  if (armed && !show.includes(armed)) disarm();
}

function clockMsg(text, kind) {
  const el = $('#clockMsg');
  el.textContent = text || '';
  el.className = 'clock-msg' + (kind ? ' ' + kind : '');
}

// Every press is a real punch in Workday, so it takes two taps: arm, then confirm within 5 s
$('#clockBtns').addEventListener('click', async e => {
  const b = e.target.closest('.clock-btn');
  if (!b || clockBusy) return;
  const action = b.dataset.clock;
  if (armed !== action) {
    disarm();
    armed = action;
    b.setAttribute('data-armed', '');
    clockMsg('Tap again within 5 seconds to send this to Workday.');
    armTimer = setTimeout(() => { disarm(); clockMsg(''); tick(); }, 5000);
    tick();
    return;
  }
  disarm();
  clockBusy = true;
  clockMsg('Sending to Workday…');
  tick();
  try {
    const res = await api('/api/clock', {method: 'POST', body: {action}});
    clockMsg(res.message || CLOCK[action].done + '.', 'ok');
    state.updatedAt = 0;
    await refreshCurrent();
    state.weeksLoaded = Math.min(state.weeksLoaded, 1);
  } catch (err) {
    clockMsg(err.message, 'err');
  } finally {
    clockBusy = false;
    tick();
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && armed) { disarm(); clockMsg(''); tick(); } });

/* ---------------- adjust start form ---------------- */
function openAdjust() {
  const L = liveToday();
  if (!L || L.realFirst == null) return;
  const v = L.adjStart != null ? L.adjStart : L.realFirst;
  $('#adjInput').value = pad(Math.floor(v / 60)) + ':' + pad(v % 60);
  $('#adjClear').hidden = L.adjStart == null;
  $('#adjErr').hidden = true;
  $('#adjForm').hidden = false;
  $('#adjBtn').setAttribute('aria-expanded', 'true');
  $('#adjInput').focus();
}
function closeAdjust() {
  $('#adjForm').hidden = true;
  $('#adjBtn').setAttribute('aria-expanded', 'false');
}
$('#adjBtn').addEventListener('click', () => ($('#adjForm').hidden ? openAdjust() : closeAdjust()));
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-adjust]')) openAdjust(); });
$('#adjCancel').addEventListener('click', () => { closeAdjust(); $('#adjBtn').focus(); });
$('#adjClear').addEventListener('click', () => { setAdjStart(nowTZ().date, null); closeAdjust(); tick(); $('#adjBtn').focus(); });
$('#adjForm').addEventListener('submit', e => {
  e.preventDefault();
  const L = liveToday();
  const [h, m] = ($('#adjInput').value || '').split(':').map(Number);
  const err = msg => { $('#adjErr').textContent = msg; $('#adjErr').hidden = false; };
  if (!L || !isFinite(h) || !isFinite(m)) return err('Enter a time.');
  const min = h * 60 + m;
  if (min >= L.realFirst) return err('Pick a time before ' + fmtMin(L.realFirst) + ', when Workday has you checking in.');
  if (min < L.realFirst - 12 * 60) return err('That\'s more than 12 hours before your Workday check-in.');
  setAdjStart(L.now.date, min);
  closeAdjust();
  tick();
  $('#adjBtn').focus();
});

/* ---------------- today's warnings ---------------- */
const LATE_MIN = 30;
let warnKey = '';
function renderTodayWarnings(L) {
  const items = [];
  if (L) {
    // First punch today vs. the usual start on other days this week (median)
    const starts = [];
    L.week.days.forEach(d => {
      if (d.date === L.now.date) return;
      const m = dayModel(L.week, d.date);
      const first = m.blocks.length ? m.blocks[0].start : (m.ins[0] ? m.ins[0].start : null);
      if (first != null) starts.push(first);
    });
    if (L.adjusted) {
      items.push({info: true, html: '<b>Using your actual start, ' + esc(fmtMin(L.adjStart)) + '</b>Workday still has your first check-in at ' + esc(fmtMin(L.realFirst)) + ', so your end time and pay here count from ' + esc(fmtMin(L.adjStart)) + ' until your manager corrects it.'});
    } else if (L.realFirst != null && starts.length) {
      starts.sort((a, b) => a - b);
      const usual = starts[Math.floor((starts.length - 1) / 2)];
      if (L.realFirst - usual >= LATE_MIN) {
        items.push('<b>Late first check-in</b>You checked in at ' + esc(fmtMin(L.realFirst)) + ', ' + esc(hm(L.realFirst - usual)) + ' after your usual start (' + esc(fmtMin(usual)) + '). If you forgot to clock in, submit a time correction in Workday, and use <button type="button" class="adj-btn" data-adjust>Adjust</button> to see your real end time here.');
      }
    }
    L.m.outs.forEach(o => items.push('<b>Check-out with no check-in</b>Workday has a check-out at ' + esc(fmtMin(o.end)) + ' today with nothing before it.'));
    if ((L.status === 'break' || L.status === 'meal') && L.now.min - L.since > (L.status === 'meal' ? 60 : 30)) {
      items.push('<b>Long ' + L.status + '</b>Your ' + L.status + ' has been running for ' + esc(hm(L.now.min - L.since)) + '. Check back in when you\'re back.');
    }
  }
  const past = state.weeks.length ? computeFlags().filter(f => f.sev === 'high').length : 0;
  if (past) items.push('<b>' + past + ' earlier punch problem' + (past > 1 ? 's' : '') + '</b>Missed check-ins or check-outs on past days. <a href="#timings">Review them in Timings</a>.');
  const html = items.map(i => typeof i === 'string' ? '<li>' + i + '</li>' : '<li class="info">' + i.html + '</li>').join('');
  if (html === warnKey) return;
  warnKey = html;
  const el = $('#todayWarn');
  el.innerHTML = html;
  el.hidden = !items.length;
}

function renderTimeline(L) {
  const now = L.now.min;
  const segs = [];
  L.m.blocks.forEach((b, i) => {
    segs.push({k: 'work', s: b.start, e: b.end, adj: b.adjusted});
    const next = L.m.blocks[i + 1];
    if (next && next.start > b.end) segs.push({k: isMealReason(b.reason) ? 'meal' : 'break', s: b.end, e: next.start});
  });
  if (L.m.open) {
    const prev = L.last;
    if (prev && L.m.open.start > prev.end) segs.push({k: isMealReason(prev.reason) ? 'meal' : 'break', s: prev.end, e: L.m.open.start});
    segs.push({k: 'work', s: L.m.open.start, e: now});
  } else if (L.status === 'break' || L.status === 'meal') {
    segs.push({k: L.status, s: L.since, e: now});
  }
  const track = $('#track');
  if (!segs.length) {
    track.innerHTML = '';
    $('#ticks').innerHTML = '';
    track.setAttribute('aria-label', 'No punches yet today');
    renderPunchLog(L);
    return;
  }
  const start = segs[0].s;
  const projEnd = (L.status === 'in' || L.status === 'break' || L.status === 'meal') && L.remaining > 0 ? now + L.remaining : Math.max(...segs.map(s => s.e));
  const end = Math.max(projEnd, now <= segs[segs.length - 1].e + 1 ? now : segs[segs.length - 1].e);
  const H = 60;
  const r0 = Math.floor(start / H) * H, r1 = Math.ceil((end + 1) / H) * H;
  const span = r1 - r0;
  const pctOf = t => ((t - r0) / span * 100);
  const KCLASS = {work: 'k-work', break: 'k-break', meal: 'k-meal'};
  let html = segs.map(s => '<div class="seg ' + KCLASS[s.k] + (s.adj ? ' adj' : '') + '" style="left:' + pctOf(s.s).toFixed(3) + '%;width:' + Math.max(0.3, pctOf(s.e) - pctOf(s.s)).toFixed(3) + '%"></div>').join('');
  if (L.status !== 'out' && L.status !== 'none' && L.remaining > 0) {
    html += '<div class="seg left" style="left:' + pctOf(now).toFixed(3) + '%;width:' + (pctOf(now + L.remaining) - pctOf(now)).toFixed(3) + '%"></div>';
  }
  if (L.status !== 'out' && L.status !== 'none') html += '<div class="nowline" style="left:' + pctOf(now).toFixed(3) + '%"></div>';
  track.innerHTML = html;
  track.setAttribute('aria-label', 'Timeline from ' + fmtMin(start) + ' to ' + fmtMin(end) + ': ' + segs.map(s => s.k + ' ' + hm(s.e - s.s)).join(', '));
  const hours = Math.round(span / H);
  const step = (window.innerWidth < 560 && hours > 6) ? 2 : 1;
  let th = '';
  for (let i = 0; i <= hours; i += step) {
    const t = r0 + i * H;
    const h = Math.floor(t / 60) % 24;
    th += '<span style="left:' + pctOf(t).toFixed(3) + '%">' + ((h % 12) || 12) + (h < 12 ? 'a' : 'p') + '</span>';
  }
  $('#ticks').innerHTML = th;
  renderPunchLog(L);
}

function renderPunchLog(L) {
  const rows = [];
  L.m.blocks.forEach((b, i) => {
    const prev = L.m.blocks[i - 1];
    if (!prev) rows.push(['In', fmtMin(b.start), b.adjusted ? 'Actual start, not in Workday yet' : 'Start of shift', false]);
    else if (prev.adjusted && b.start === prev.end) rows.push(['Workday in', fmtMin(b.start), 'Check-in Workday has', false]);
    else if (b.start > prev.end) rows.push(['Back', fmtMin(b.start), hm(b.start - prev.end) + ' off the clock', false]);
    if (isBreakReason(b.reason) || isMealReason(b.reason)) rows.push([isMealReason(b.reason) ? 'Meal out' : 'Break out', fmtMin(b.end), hm(b.end - b.start) + ' worked before it', false]);
    else if (i === L.m.blocks.length - 1 && !L.m.open) rows.push(['Out', fmtMin(b.end), hm(L.m.onBlocks) + ' on the clock', false]);
  });
  const onlyAdj = L.m.blocks.length === 1 && L.m.blocks[0].adjusted;
  if (L.m.open) rows.push(onlyAdj ? ['Workday in', fmtMin(L.m.open.start), 'Check-in Workday has', false]
    : [L.m.blocks.length ? 'Back' : 'In', fmtMin(L.m.open.start), L.m.blocks.length ? 'Checked back in' : 'Start of shift', false]);
  L.m.outs.forEach(o => rows.push(['Out', fmtMin(o.end), 'No matching check-in', false]));
  if ((L.status === 'in' || L.status === 'break' || L.status === 'meal') && L.remaining > 0) rows.push(['Out (est.)', fmtMin(L.now.min + L.remaining), 'at ' + settings.target + ' paid h', true]);
  $('#punchlog').innerHTML = rows.length
    ? rows.map(r => '<tr' + (r[3] ? ' class="proj"' : '') + '><td>' + esc(r[0]) + '</td><td class="t">' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>').join('')
    : '<tr><td colspan="3" class="muted">No punches yet today.</td></tr>';
}

// Rate typed in Settings wins; otherwise the base hourly rate from the latest payslip
function payRate() {
  if (settings.rate > 0) return {rate: settings.rate, src: 'settings'};
  const P = state.pay && state.pay.latest;
  if (P && P.rate > 0) return {rate: P.rate, src: 'payslip', date: P.date};
  return null;
}
// Share of gross you kept on the latest payslip, after statutory and other deductions
function keptRatio() {
  const P = state.pay && state.pay.latest;
  return P && P.gross > 0 ? P.net / P.gross : null;
}

function renderMoney(L) {
  const big = $('#moneyBig');
  const paidH = L ? L.paid / 60 : 0;
  const R = payRate();
  const kept = keptRatio();
  $('#tapeHrs').textContent = paidH.toFixed(3) + ' h';
  const P = state.pay && state.pay.latest;
  $('#setRate').placeholder = P && P.rate > 0 ? P.rate.toFixed(2) : '0.00';
  $('#rateHelp').textContent = P && P.rate > 0
    ? 'Leave blank to use $' + P.rate.toFixed(2) + ' from your ' + shortDate(P.date) + ' payslip'
    : 'Leave blank to use the rate on your latest payslip';
  if (!R) {
    big.className = 'amt unset';
    big.textContent = state.payLoading ? 'Loading pay…' : 'Set your rate';
    $('#moneySr').textContent = 'Set your hourly rate in Settings to see what you made today.';
    ['#tapeRate', '#tapeAmt', '#tapeDed', '#tapeNet'].forEach(s => { $(s).textContent = '—'; });
    $('#tapeDedPct').textContent = '';
    setHTML($('#moneyNote'), state.payLoading ? 'Reading your rate from your latest payslip…' : 'Add your hourly rate in <button type="button" data-focus="setRate">Settings</button> to see today\'s earnings tick up.');
    return;
  }
  const gross = paidH * R.rate;
  const net = kept != null ? gross * kept : gross;
  const tenths = Math.floor(net * 1000);
  big.className = 'amt';
  big.innerHTML = '<span class="cur">$</span>' + Math.floor(tenths / 1000).toLocaleString('en-CA') + '.' + pad(Math.floor(tenths % 1000 / 10)) + '<span class="mill">' + (tenths % 10) + '</span>';
  $('#moneySr').textContent = kept != null ? 'Take-home today, estimated: ' + money(net) + ' (' + money(gross) + ' before deductions)' : 'Made today: ' + money(gross);
  $('#tapeRate').textContent = money(R.rate) + ' / h';
  $('#tapeAmt').textContent = money(Math.floor(gross * 100) / 100);
  $('#tapeDed').textContent = kept != null ? '−' + money(Math.floor((gross - net) * 100) / 100) : '—';
  $('#tapeDedPct').textContent = kept != null ? (100 - kept * 100).toFixed(1) + '%' : '';
  $('#tapeNet').textContent = kept != null ? money(Math.floor(net * 100) / 100) : '—';
  const u = L ? L.unpaid : settings.unpaid * 60;
  const day = settings.target * R.rate;
  const src = R.src === 'payslip'
    ? 'Rate from your ' + esc(shortDate(R.date)) + ' payslip. '
    : 'Using the rate from Settings. ';
  const ded = kept != null && P
    ? 'Deductions use that payslip\'s ' + esc((100 - kept * 100).toFixed(1)) + '% (CPP, EI and income tax); premiums and allowances aren\'t included. '
    : '';
  setHTML($('#moneyNote'), src + ded + (u > 0
    ? 'A full ' + esc(hm(settings.target * 60 + u)) + ' on the clock pays ' + esc(money(day)) + (kept != null ? ', about ' + esc(money(day * kept)) + ' take-home' : '') + '.'
    : 'A full ' + esc(settings.target) + '-hour day pays ' + esc(money(day)) + (kept != null ? ', about ' + esc(money(day * kept)) + ' take-home' : '') + '.'));
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-focus]');
  if (b) { const el = document.getElementById(b.dataset.focus); if (el) { el.focus(); el.scrollIntoView({block: 'center', behavior: reduceMotion ? 'auto' : 'smooth'}); } }
});

function weekHours(week, L) {
  let base = 0, todayH = 0;
  week.days.forEach(d => {
    if (L && d.date === L.now.date && (L.status === 'in' || L.status === 'break' || L.status === 'meal')) todayH = L.paid / 60;
    else base += d.total;
  });
  return {base, today: todayH, total: base + todayH};
}

function renderSummary(L) {
  const week = state.weeks[0];
  $('#wkTargetTxt').textContent = settings.weekTarget;
  if (week) {
    const w = weekHours(week, L);
    $('#wkHrs').textContent = hrs(w.total);
    $('#wkDone').style.width = Math.min(100, w.base / settings.weekTarget * 100) + '%';
    $('#wkLive').style.left = Math.min(100, w.base / settings.weekTarget * 100) + '%';
    $('#wkLive').style.width = Math.max(0, Math.min(100, w.total / settings.weekTarget * 100) - w.base / settings.weekTarget * 100) + '%';
    $('#wkSub').textContent = (week.title || 'This week') + ' · ' + (w.total >= settings.weekTarget ? 'target met' : hrs(settings.weekTarget - w.total) + ' h to go') + (w.today ? ' · includes today so far' : '');
  }
  const today = nowTZ().date;
  const payday = week && week.entries.find(e => e.kind === 'payday' && e.date >= today);
  const next = (state.pay && state.pay.nextPayDate) || (payday && payday.date) || null;
  $('#nextPayTxt').textContent = next ? shortDate(next, true) : '—';
  $('#payIn').textContent = next ? inDays(dayDiff(today, next)) + (payday && payday.note ? ' · covers ' + payday.note.replace(' - ', ' to ') : '') : (state.payLoading ? 'Loading…' : '');
  const last = state.pay && state.pay.payslips[0];
  $('#lastNetTxt').textContent = last ? money(last.net) : (state.payLoading ? '…' : '—');
  setHTML($('#lastNetSub'), last ? 'Paid ' + esc(shortDate(last.date)) + ' · <a href="#payslips">See payslips</a>' : (state.payError ? esc(state.payError) : '<a href="#payslips">See payslips</a>'));
}

/* settings inputs */
const SET_FIELDS = [['#setRate', 'rate', true], ['#setUnpaid', 'unpaid'], ['#setTarget', 'target'], ['#setWeek', 'weekTarget']];
SET_FIELDS.forEach(([sel, key, nullable]) => {
  const el = $(sel);
  el.value = settings[key] == null ? '' : settings[key];
  el.addEventListener('change', () => {
    const v = el.value.trim() === '' ? null : Number(el.value);
    if (v == null && nullable) settings[key] = null;
    else if (v != null && isFinite(v) && v >= Number(el.min) && v <= Number(el.max)) settings[key] = v;
    el.value = settings[key] == null ? '' : settings[key];
    saveSettings();
    tick();
    renderTimings();
  });
});

/* ---------------- timings ---------------- */
function pillFor(status) {
  if (status === 'approved') return '<span class="pill pill-approved"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3" fill="none" stroke="currentColor" stroke-width="2"/></svg>Approved</span>';
  if (status === 'saved') return '<span class="pill pill-saved"><svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 1.6"/></svg>Saved</span>';
  if (status === 'live') return '<span class="pill pill-live"><svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="currentColor"/></svg>On the clock</span>';
  return '<span class="pill pill-off">Off</span>';
}

function entryRow(e) {
  const pill = pillFor(e.status === 'saved' ? 'saved' : 'approved');
  if (e.kind === 'work') {
    return '<div class="entry"><span class="ty">Worked time' + (e.reason ? '<span class="brk">then ' + esc(e.reason.toLowerCase()) + '</span>' : '') + '</span><span class="rg">' + esc(fmtMin(e.start)) + ' – ' + esc(fmtEnd(e.end)) + '</span><span class="hh">' + (e.hours != null ? hrs(e.hours) + ' h' : '') + '</span>' + pill + '</div>';
  }
  if (e.kind === 'in') return '<div class="entry"><span class="ty">Check-in, no check-out</span><span class="rg">' + esc(fmtMin(e.start)) + '</span><span class="hh">—</span>' + pill + '</div>';
  if (e.kind === 'out') return '<div class="entry"><span class="ty">Check-out, no check-in</span><span class="rg">' + esc(fmtMin(e.end)) + '</span><span class="hh">—</span>' + pill + '</div>';
  if (e.kind === 'deduct') return '<div class="entry ded"><span class="ty">' + esc(e.type) + (e.paid ? ' (paid)' : '') + '</span><span class="rg">' + esc(hm(Math.abs(e.hours || 0) * 60)) + '</span><span class="hh">' + (e.paid ? '0.00' : '−' + hrs(Math.abs(e.hours || 0))) + ' h</span>' + pill + '</div>';
  if (e.kind === 'payday') return '<div class="entry ded"><span class="ty">Pay date</span><span class="rg">' + esc(e.note) + '</span><span class="hh"></span><span></span></div>';
  return '<div class="entry ded"><span class="ty">' + esc(e.type) + '</span><span class="rg">' + esc(e.note) + '</span><span class="hh">' + (e.hours != null ? hrs(e.hours) + ' h' : '') + '</span>' + pill + '</div>';
}

function computeFlags() {
  const today = nowTZ().date;
  const out = [];
  state.weeks.forEach((w, wi) => w.days.forEach(d => {
    if (d.date >= today) return;
    const m = dayModel(w, d.date);
    if (!m.es.some(e => e.kind !== 'payday')) return;
    const last = m.blocks[m.blocks.length - 1];
    m.outs.forEach(o => {
      const before = m.blocks.filter(b => b.end <= o.end).pop();
      const resumed = before && m.blocks.some(b => b.start >= before.end && b.start < o.end);
      const tail = before && !resumed && (isBreakReason(before.reason) || isMealReason(before.reason))
        ? ' Your ' + (isMealReason(before.reason) ? 'meal' : 'break') + ' started at ' + fmtMin(before.end) + ' and there\'s no check-in after it, so ' + hm(o.end - before.end) + ' isn\'t counted.'
        : '';
      out.push({sev: 'high', date: d.date, wi, what: 'Check-out with no check-in', why: 'Checked out at ' + fmtMin(o.end) + ' with no matching check-in.' + tail});
    });
    m.ins.forEach(i => out.push({sev: 'high', date: d.date, wi, what: 'Check-in with no check-out', why: 'Checked in at ' + fmtMin(i.start) + ' and never checked out. Add the clock-out in Workday.'}));
    m.blocks.filter(b => b.end - b.start > 720).forEach(b => out.push({sev: 'high', date: d.date, wi, what: b.end >= 1440 ? 'Punch runs overnight' : 'Punch over 12 hours', why: 'Worked time from ' + fmtMin(b.start) + ' to ' + fmtEnd(b.end) + ' (' + hm(b.end - b.start) + ') is on your card. A check-out is probably missing; fix it in Workday.'}));
    if (last && last.end - last.start <= 720 && (isBreakReason(last.reason) || isMealReason(last.reason)) && !m.outs.some(o => o.end >= last.end) && !m.ins.some(i => i.start >= last.end)) {
      out.push({sev: 'high', date: d.date, wi, what: 'No return from ' + (isMealReason(last.reason) ? 'meal' : 'break'), why: 'Went on ' + last.reason.toLowerCase() + ' at ' + fmtMin(last.end) + ' with no punch after it. Add the return and clock-out in Workday.'});
    }
    for (let i = 1; i < m.blocks.length; i++) {
      const gap = m.blocks[i].start - m.blocks[i - 1].end;
      if (gap > 60) out.push({sev: 'high', date: d.date, wi, what: 'Break longer than 1 hour', why: 'Off the clock ' + fmtMin(m.blocks[i - 1].end) + ' – ' + fmtMin(m.blocks[i].start) + ' (' + hm(gap) + ').'});
    }
    m.deduct.filter(x => Math.abs(x.hours || 0) > 1).forEach(x => out.push({sev: 'med', date: d.date, wi, what: x.type + ' over 1 hour', why: 'Workday deducted ' + hm(Math.abs(x.hours) * 60) + '.'}));
    if (m.total > 0 && m.total < settings.target - 0.005) out.push({sev: 'med', date: d.date, wi, what: 'Under ' + settings.target + ' hours', why: 'Workday counts ' + hrs(m.total) + ' h paid, ' + hm((settings.target - m.total) * 60) + ' short.'});
    if (m.onBlocks > 300 && !m.hasMeal) out.push({sev: 'med', date: d.date, wi, what: 'No meal break recorded', why: hm(m.onBlocks) + ' on the clock (' + fmtMin(m.blocks[0].start) + ' – ' + fmtMin(last.end) + ') with no meal entry.'});
    if (m.saved) out.push({sev: 'low', date: d.date, wi, what: m.saved + (m.saved > 1 ? ' entries' : ' entry') + ' still saved', why: 'Not approved yet, so ' + (m.saved > 1 ? 'they' : 'it') + ' may not be paid this period.'});
  }));
  const rank = {high: 0, med: 1, low: 2};
  return out.sort((a, b) => b.date.localeCompare(a.date) || rank[a.sev] - rank[b.sev]);
}

function renderTimings() {
  if (!state.user) return;
  const body = $('#wkBody');
  if (!state.weeks.length || (state.weeksLoading && state.weeksLoaded < 2 && state.wkIdx > 0)) {
    body.innerHTML = '<tr><td colspan="6" class="loading-cell">Loading your time cards from Workday…</td></tr>';
    $('#flags').innerHTML = '';
    return;
  }
  state.wkIdx = Math.min(state.wkIdx, state.weeks.length - 1);
  const W = state.weeks[state.wkIdx];
  const L = state.wkIdx === 0 ? liveToday() : null;
  const today = nowTZ().date;
  $('#wkName').textContent = W.title || shortDate(W.start);
  $('#wkPos').textContent = (state.wkIdx === 0 ? 'This week' : state.wkIdx === 1 ? 'Last week' : state.wkIdx + ' weeks ago') + (state.weeksLoading ? ' · loading more…' : '');
  $('#wkPrev').disabled = state.weeksLoading || (state.wkIdx >= state.weeks.length - 1 && state.noMoreWeeks);
  $('#wkNext').disabled = state.wkIdx <= 0;
  const wh = weekHours(W, L);
  $('#wkTotal').innerHTML = hrs(wh.total) + '<small> / ' + esc(settings.weekTarget) + ' h</small>';
  const models = W.days.map(d => dayModel(W, d.date));
  $('#wkDays').textContent = models.filter(m => m.total > 0 || m.blocks.length || m.open).length;
  const anySaved = models.some(m => m.saved);
  $('#wkStatus').innerHTML = anySaved ? pillFor('saved') + ' <span class="muted">some entries not approved</span>' : pillFor('approved');

  const flags = computeFlags();
  const flagsByDate = {};
  flags.forEach(f => { (flagsByDate[f.date] = flagsByDate[f.date] || []).push(f); });
  const openRows = new Set($$('#wkBody .exp[aria-expanded="true"]').map(b => b.getAttribute('aria-controls')));

  let html = '';
  W.days.forEach((d, i) => {
    const m = models[i];
    const isToday = d.date === today;
    const off = !m.es.some(e => e.kind !== 'payday');
    const id = 'det-' + d.date;
    const last = m.blocks[m.blocks.length - 1];
    const inMin = m.blocks.length ? m.blocks[0].start : (m.ins[0] ? m.ins[0].start : null);
    let outTxt = '—', outMiss = false;
    if (isToday && m.open) outTxt = 'on the clock';
    else if (m.outs.length) outTxt = fmtMin(m.outs[m.outs.length - 1].end);
    else if (last && (isBreakReason(last.reason) || isMealReason(last.reason)) && !m.ins.some(x => x.start >= last.end)) { outTxt = isToday ? 'on ' + last.reason.toLowerCase() : 'missing'; outMiss = !isToday; }
    else if (last) { outTxt = fmtEnd(last.end); outMiss = last.end >= 1440; }
    else if (m.ins.length) { outTxt = 'missing'; outMiss = true; }
    const paidH = isToday && L && (L.status === 'in' || L.status === 'break' || L.status === 'meal') ? L.paid / 60 : m.total;
    const short = paidH > 0 && paidH < settings.target && !isToday;
    const fl = (flagsByDate[d.date] || []).length;
    const status = isToday && m.open ? 'live' : off ? 'off' : m.saved ? 'saved' : 'approved';
    html += '<tr class="' + (off ? 'off' : '') + '" id="row-' + d.date + '">'
      + '<td class="day">' + esc(DAYS[isoParts(d.date).dow]) + '<small>' + esc(shortDate(d.date)) + '</small>' + (isToday ? '<span class="when-today">Today</span>' : '') + (fl ? '<span class="flagdot" title="' + fl + ' flag' + (fl > 1 ? 's' : '') + '">●<span class="sr"> ' + fl + ' flags</span></span>' : '') + '</td>'
      + '<td class="punch">' + (inMin != null ? fmtMin(inMin) : '—') + '</td>'
      + '<td class="punch' + (outMiss ? ' miss' : '') + '">' + esc(outTxt) + '</td>'
      + '<td><div class="hrs"><span class="bar" aria-hidden="true"><i class="' + (short ? 'short' : '') + '" style="width:' + Math.min(100, paidH / 10 * 100) + '%"></i></span><span class="n">' + (paidH ? hrs(paidH) : '0') + '</span></div></td>'
      + '<td>' + pillFor(status) + '</td>'
      + '<td>' + (off ? '' : '<button class="exp" type="button" aria-expanded="' + openRows.has(id) + '" aria-controls="' + id + '" aria-label="Show entries for ' + esc(shortDate(d.date, true)) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>') + '</td>'
      + '</tr>';
    if (!off) html += '<tr class="detail" id="' + id + '"' + (openRows.has(id) ? '' : ' hidden') + '><td colspan="6"><div class="entries">' + m.es.map(entryRow).join('') + '</div></td></tr>';
  });
  const diff = wh.total - settings.weekTarget;
  html += '<tr class="tfoot"><td colspan="3">Week total</td><td class="mono">' + hrs(wh.total) + ' h</td><td colspan="2" class="muted">' + (diff >= 0 ? '+' + hrs(diff) + ' h over target' : hrs(-diff) + ' h under target') + '</td></tr>';
  body.innerHTML = html;
  $$('#wkBody .exp').forEach(b => b.addEventListener('click', () => toggleRow(b)));
  renderFlags(flags);
}
function toggleRow(b, force) {
  const open = force !== undefined ? force : b.getAttribute('aria-expanded') !== 'true';
  b.setAttribute('aria-expanded', String(open));
  const row = document.getElementById(b.getAttribute('aria-controls'));
  if (row) row.hidden = !open;
}
$('#wkPrev').addEventListener('click', () => {
  if (state.wkIdx < state.weeks.length - 1) { state.wkIdx++; renderTimings(); }
  else if (!state.noMoreWeeks) { state.wkIdx++; ensureWeeks(Math.min(10, state.weeksLoaded + 3)); }
});
$('#wkNext').addEventListener('click', () => { if (state.wkIdx > 0) { state.wkIdx--; renderTimings(); } });

const SEVLABEL = {high: 'High', med: 'Medium', low: 'Low'};
function renderFlags(all) {
  const list = state.flagScope === 'all' ? all : all.filter(f => f.wi === state.wkIdx);
  $('#scopeAll').textContent = 'All ' + state.weeks.length + ' loaded week' + (state.weeks.length === 1 ? '' : 's');
  $('#flags').innerHTML = list.length ? list.map(f =>
    '<li class="flag stock sev-' + f.sev[0] + '">'
    + '<div class="sevcell"><span class="sev sev-' + f.sev + '">' + SEVLABEL[f.sev] + '</span></div>'
    + '<div><div class="when">' + esc(shortDate(f.date, true)) + ' · ' + esc(state.weeks[f.wi].title) + '</div><div class="what">' + esc(f.what) + '</div><div class="why">' + esc(f.why) + '</div></div>'
    + '<button type="button" class="link-btn" data-goto="' + f.date + '" data-wi="' + f.wi + '">Show day</button>'
    + '</li>').join('')
    : '<li class="flag stock ok"><div><div class="what">Nothing to check' + (state.flagScope === 'week' ? ' this week' : '') + '</div><div class="why">Every finished day has its punches matched, its breaks under an hour, a meal break and ' + esc(settings.target) + ' paid hours.</div></div></li>';
}
$('#flags').addEventListener('click', e => {
  const b = e.target.closest('[data-goto]');
  if (!b) return;
  state.wkIdx = +b.dataset.wi;
  renderTimings();
  const btn = $('#row-' + b.dataset.goto + ' .exp');
  if (btn) toggleRow(btn, true);
  const row = $('#row-' + b.dataset.goto);
  if (row) {
    row.scrollIntoView({behavior: reduceMotion ? 'auto' : 'smooth', block: 'center'});
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
    if (btn) btn.focus({preventScroll: true});
  }
});
$$('.filter button').forEach(b => b.addEventListener('click', () => {
  state.flagScope = b.dataset.scope;
  $$('.filter button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderFlags(computeFlags());
}));

/* ---------------- payslips ---------------- */
function renderPay() {
  if (!state.user) return;
  const P = state.pay;
  $('#payLoading').hidden = !!P;
  $('#payBody').hidden = !P;
  if (!P) {
    $('#payLoading').textContent = state.payError ? state.payError + ' ' : 'Loading your payslips from Workday…';
    if (state.payError && !$('#payRetry')) {
      $('#payLoading').insertAdjacentHTML('beforeend', '<button type="button" class="link-btn" id="payRetry">Try again</button>');
      $('#payRetry').addEventListener('click', ensurePay);
    }
    return;
  }
  const today = nowTZ().date;
  const week = state.weeks[0];
  const payday = week && week.entries.find(e => e.kind === 'payday' && e.date >= today);
  const next = P.nextPayDate || (payday && payday.date);
  $('#npDate').textContent = next ? shortDate(next, true) : 'Not set';
  $('#npIn').textContent = next ? isoParts(next).y + ' · ' + inDays(dayDiff(today, next)) : '';
  $('#npMeta').innerHTML = payday && payday.note ? '<span>Covers ' + esc(payday.note.replace(' - ', ' to ')) + '</span>' : '<span>Hourly Canada payroll</span>';

  const H = P.history;
  const sum = k => H.reduce((a, h) => a + h[k], 0);
  const E = sum('earnings'), D = sum('deductions'), N = sum('net');
  $('#ytdN').textContent = H.length;
  $('#ytdEarn').textContent = money(E); $('#ytdDed').textContent = money(D); $('#ytdNet').textContent = money(N);
  const kept = E > 0 ? N / E * 100 : 0;
  $('#splitN').style.width = kept.toFixed(2) + '%';
  $('#splitD').style.width = (E > 0 ? D / E * 100 : 0).toFixed(2) + '%';
  $('#splitKept').textContent = 'You kept ' + kept.toFixed(1) + '%';
  $('#splitDed').textContent = (E > 0 ? (D / E * 100).toFixed(1) : '0') + '% statutory deductions';

  $('#stubs').innerHTML = P.payslips.length ? P.payslips.map((p, i) =>
    '<article class="stub stock' + (i === 0 ? ' latest' : '') + '">'
    + '<div class="top"><b>' + esc(shortDate(p.date)) + '</b><span class="label">' + (i === 0 ? 'Latest' : esc(p.date.slice(0, 4))) + '</span></div>'
    + '<div class="perf" aria-hidden="true"></div>'
    + '<div class="body"><span>Gross</span><span>' + money(p.gross) + '</span>'
    + '<span>Deductions</span><span>−' + money((p.gross || 0) - (p.net || 0)) + '</span>'
    + '<span class="net-l">Net</span><span class="netv">' + money(p.net) + '</span></div>'
    + '</article>').join('') : '<p class="loading-line">No payslips in Workday yet.</p>';

  $('#histBody').innerHTML = H.slice().reverse().map(h =>
    '<tr><td>' + esc(shortDate(h.from)) + ' – ' + esc(shortDate(h.to)) + '</td><td>' + money(h.earnings) + '</td><td class="ded">−' + money(h.deductions) + '</td><td class="net">' + money(h.net) + '</td></tr>').join('');
  $('#histEarn').textContent = money(E); $('#histDed').textContent = '−' + money(D); $('#histNet').textContent = money(N);
  renderChart(H);
}

function renderChart(H) {
  if (!H.length) { $('#chart').innerHTML = ''; return; }
  const W = 440, Hh = 250, L = 44, R = 8, T = 22, B = 34;
  const top = Math.max(...H.map(h => h.earnings));
  const step = top > 2400 ? 1000 : 500;
  const max = Math.ceil(top / step) * step || step;
  const iw = W - L - R, ih = Hh - T - B, bw = iw / H.length;
  const y = v => T + ih - v / max * ih;
  let s = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-labelledby="chartT chartD"><title id="chartT">Net pay per pay period</title><desc id="chartD">' + esc(H.map(h => shortDate(h.to) + ': net ' + money(h.net) + ', deductions ' + money(h.deductions)).join('; ')) + '</desc>';
  s += '<defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="5" height="5"/><line class="hatch-ln" x1="0" y1="0" x2="0" y2="5"/></pattern></defs>';
  for (let v = 0; v <= max; v += step) s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 3.5) + '" text-anchor="end">' + (v ? '$' + (v / 1000) + 'k' : '$0') + '</text>';
  H.forEach((h, i) => {
    const x = L + i * bw + bw * .18, w = bw * .64, last = i === H.length - 1;
    s += '<rect class="bn' + (last ? ' last' : '') + '" x="' + x.toFixed(1) + '" y="' + y(h.net).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (y(0) - y(h.net)).toFixed(1) + '"/>';
    s += '<rect class="bd" x="' + x.toFixed(1) + '" y="' + y(h.earnings).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, y(h.net) - y(h.earnings)).toFixed(1) + '"/>';
    s += '<text class="v" x="' + (x + w / 2).toFixed(1) + '" y="' + (y(h.earnings) - 5).toFixed(1) + '" text-anchor="middle">' + Math.round(h.net).toLocaleString('en-CA') + '</text>';
    s += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (Hh - B + 15) + '" text-anchor="middle">' + esc(shortDate(h.to)) + '</text>';
  });
  s += '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
  s += '<text x="' + L + '" y="' + (Hh - 4) + '">Period end · solid net · hatched deductions</text></svg>';
  $('#chart').innerHTML = s;
}

/* ---------------- loops ---------------- */
(function loop() {
  setTimeout(() => { tick(); loop(); }, 1000 - (Date.now() % 1000) + 5);
})();
setInterval(() => {
  if (state.user && document.visibilityState === 'visible' && Date.now() - state.updatedAt > 55e3) refreshCurrent();
}, 15e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user && Date.now() - state.updatedAt > 30e3) refreshCurrent();
});
window.addEventListener('resize', () => tick());

/* ---------------- boot ---------------- */
(async function boot() {
  try {
    const s = await api('/api/session', {auth: true});
    state.user = s.user;
    route();
    refreshCurrent();
    ensurePay();
  } catch (e) {
    route('login');
    if (e.status !== 401) loginError(e.message);
  }
})();
})();
