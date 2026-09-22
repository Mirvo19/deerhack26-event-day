# DeerHack Live — SETUP (Vercel deployment)

## 1. Environment variables

| Var | Exposed to | Notes |
|---|---|---|
| `SUPABASE_URL` | server + display (public) | e.g. `https://xyzcompany.supabase.co` |
| `SUPABASE_ANON_KEY` | server + display (public) | Read-only. RLS restricts it to SELECT on state tables + storage reads |
| `SUPABASE_SERVICE_ROLE_KEY` | **server-only (Vercel env vars)** | Never in templates/JS. Flask writes + Storage uploads |
| `SECRET_KEY` | server-only | Long random string. Signs the stateless `dh_admin` session cookie + debounce cookies |
| `ALLOWED_ORIGIN` | server-only | Comma-separated deploy origins for credentialed admin API calls, e.g. `https://deerhack-live.vercel.app` |
| `ENV` | server-only | `production` enables `Secure` cookies |

Local dev: copy `.env.example` to `.env`. On Vercel: Project → Settings →
Environment Variables (all of the above; `SUPABASE_SERVICE_ROLE_KEY` and
`SECRET_KEY` must NOT have any client-side exposure — they don't; only
`SUPABASE_URL`/`SUPABASE_ANON_KEY` are rendered into the display template).

## 2. Supabase: schema + RLS + Storage + Realtime

1. Create a Supabase project.
2. SQL Editor → paste and run **`schema.sql`** (run in full):
   - tables: `announcements`, `timer_state` (singleton `id = 1`), `teams`,
     `motifs`, `alert_sounds` (+ `updated_at` triggers + DeerHack sample rows)
   - RLS enabled with **SELECT-only policies for `anon`** on all five tables.
     There are deliberately NO insert/update/delete policies for `anon` or
     `authenticated` → display browsers can never write, even via devtools.
     Flask's `service_role` client bypasses RLS server-side.
   - Storage buckets `motifs` and `alert-sounds` (public reads; no anon
     writes — uploads go through Flask with the service key).
3. Database → Replication: confirm all five tables are in the
   `supabase_realtime` publication (the SQL file adds them; the dashboard
   shows the switches).
4. Auth → disable public sign-ups (no signup UI exists in the app).

## 3. `vercel.json` (already in the repo)

```json
{
  "version": 2,
  "builds": [{ "src": "app.py", "use": "@vercel/python" }],
  "routes": [
    { "src": "/static/(.*)", "dest": "/static/$1" },
    { "src": "/(.*)", "dest": "/app.py" }
  ]
}
```

Single-file backend: `app.py` at the repo root is the whole Flask app —
it runs locally with `python app.py` and Vercel builds it straight from the
root (no `api/` folder, no shim). Static assets and `templates/` live at the
root next to it. No build step (vanilla HTML/CSS/JS).

## 4. Local dev

```bash
python -m venv .venv
# windows: .venv\Scripts\activate  |  mac/linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env   # then fill in real keys
python app.py
```

- Display: http://localhost:5000/
- Login: http://localhost:5000/login → redirects to http://localhost:5000/admin

## 5. Deploy to Vercel

```bash
npm i -g vercel
vercel            # preview deploy
vercel --prod     # production
```

Or: import the repo in the Vercel dashboard as-is (framework preset: Other,
no root-directory override needed — `vercel.json`, `app.py`, `api/` and
`requirements.txt` sit at the repo root), add the env vars from §1, deploy.
Set `ALLOWED_ORIGIN` to the production URL after the first deploy.

## 6. Create the admin account (one-off — no signup exists)

```bash
python seed_admin.py organizer@example.com 'Strong-Pass-123!'
```

(one account per organizer), then sign in at `/login`.

## 7. Realtime smoke test

1. Open two displays + `/admin`; push an announcement → both update in ~1s
   with the active chime (after clicking **Enable live sound** once).
2. Timer start/pause/reset → all screens agree (they count from the DB
   `ends_at`, re-synced on every event).
3. Kill wifi ~10s, restore → indicator flips live → syncing → live and full
   state re-fetches with no manual refresh.
