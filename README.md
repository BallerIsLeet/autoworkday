# Shift Card

An unofficial, open-source companion for Workday time tracking. Sign in with your Workday account to see today's shift, a live countdown to your paid hours, your punches, pay estimates and payslips, and to check in, start a break or meal, or clock out.

Live at https://autoworkday.vercel.app

## Not affiliated with Workday or Bill Gosling

Shift Card is an independent project. It isn't made, endorsed or supported by Workday, Inc. or Bill Gosling Outsourcing. Workday stays the official record of your time and pay. If Shift Card and Workday disagree, Workday is right.

## We keep no data: 0 retention

- **No database, no accounts, no analytics.** The server forwards each request to Workday and keeps nothing afterward. It writes nothing to disk.
- **Your sign-in lives in your browser.** The Workday session is sealed with AES-GCM into an `HttpOnly`, `Secure`, `SameSite=Strict` cookie that page scripts can't read. Signing out deletes it.
- **"Keep me signed in" is optional.** It adds your Workday email and password to that same encrypted cookie for 30 days, so Shift Card can sign you back in when Workday's session ends. Turn it off and only the Workday session is kept, for up to 12 hours.
- **Settings stay local.** Your hourly-rate override, break settings and adjusted start times are kept in your browser's local storage and never sent anywhere.
- **Hosting logs.** Vercel, the host, keeps its own short-lived request logs (time, path, status code). Shift Card never logs passwords, hours or pay.

## How it works

- `public/` is the static front end (HTML, CSS, plain JavaScript).
- `src/workday.ts` talks to Workday the way its web app does: JSON task pages for timesheets and payslips, and its form flow for the time clock.
- `src/session.ts` handles the encrypted session cookie.
- `api/index.ts` is the Vercel function; `server.ts` runs the same API locally with Bun.

## Run it locally

```bash
bun install
SESSION_SECRET="any 32+ character secret" bun run dev
```

Then open http://localhost:3000.

## Deploy

Import the repo into Vercel with the "Other" preset and set `SESSION_SECRET` (32+ random characters) in the project's environment variables.
