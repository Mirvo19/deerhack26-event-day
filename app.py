"""deerhack live backend. runs on vercel as a stateless function,
so nothing lives in memory here — all real state is in supabase.
auth is a signed cookie holding supabase tokens, re-checked every request."""
import os
import re
import time
import uuid
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

import bleach
import requests
from flask import Flask, jsonify, redirect, render_template, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from supabase import create_client
from werkzeug.utils import secure_filename

ROOT = Path(__file__).resolve().parent

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-change-me")
ENV = os.environ.get("ENV", "development")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "")
PORT = int(os.environ.get("PORT", "5000"))

SESSION_MAX_AGE = 60 * 60 * 12
WRITE_DEBOUNCE_SECONDS = 1.5
LOGIN_DEBOUNCE_SECONDS = 3.0

signer = URLSafeTimedSerializer(SECRET_KEY, salt="dh-admin-v1")
rl_signer = URLSafeTimedSerializer(SECRET_KEY, salt="dh-debounce-v1")

app = Flask(
    __name__,
    template_folder=str(ROOT / "templates"),
    static_folder=str(ROOT / "static"),
    static_url_path="/static",
)
app.secret_key = SECRET_KEY

_svc_client = None


def svc():
    global _svc_client
    if _svc_client is None:
        _svc_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    return _svc_client


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: str, max_len: int) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = bleach.clean(value, tags=[], attributes={}, strip=True)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:max_len]


def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value.lower()).strip("-")
    return (value or "asset")[:60]


def _supabase_user(access_token: str):
    try:
        r = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"apikey": SUPABASE_ANON_KEY,
                     "Authorization": f"Bearer {access_token}"},
            timeout=8,
        )
        if r.status_code == 200:
            return r.json()
    except requests.RequestException:
        return None
    return None


def _refresh_access(refresh_token: str):
    try:
        r = requests.post(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"refresh_token": refresh_token},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        p = r.json()
        user = _supabase_user(p.get("access_token", ""))
        email = (user or {}).get("email") or ""
        return p.get("access_token"), p.get("refresh_token"), email
    except requests.RequestException:
        return None


def _session_cookie_value(email: str, access: str, refresh: str) -> str:
    return signer.dumps({"at": access, "rt": refresh, "em": email})


def _set_session_cookie(resp, value: str):
    resp.set_cookie(
        "dh_admin", value,
        max_age=SESSION_MAX_AGE, httponly=True, samesite="Lax",
        secure=(ENV == "production"), path="/",
    )
    return resp


def _clear_session_cookie(resp):
    resp.delete_cookie("dh_admin", path="/")
    return resp


def get_admin():
    # who dis — verify the cookie against supabase every single time
    raw = request.cookies.get("dh_admin", "")
    if not raw:
        return None, None, False
    try:
        payload = signer.loads(raw, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None, None, True
    user = _supabase_user(payload.get("at", ""))
    if user:
        return user.get("email") or payload.get("em"), None, False
    # access token died, try the refresh token once
    rotated = _refresh_access(payload.get("rt", "")) if payload.get("rt") else None
    if not rotated:
        return None, None, True
    access, refresh, email = rotated
    return email, _session_cookie_value(email, access, refresh), False


def page_login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        email, rotated, clear = get_admin()
        if not email:
            resp = redirect("/login")
            if clear:
                _clear_session_cookie(resp)
            return resp
        resp = fn(*args, **kwargs, admin_email=email)
        if rotated:
            _set_session_cookie(resp, rotated)
        return resp
    return wrapper


def api_login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        email, rotated, clear = get_admin()
        if not email:
            resp = jsonify({"error": "unauthorized"})
            resp.status_code = 401
            if clear:
                _clear_session_cookie(resp)
            return resp
        request.admin_email = email
        result = fn(*args, **kwargs)
        if rotated:
            if isinstance(result, tuple):
                body, status = result[0], result[1] if len(result) > 1 else 200
                resp = app.make_response((body, status))
            else:
                resp = app.make_response(result)
            _set_session_cookie(resp, rotated)
            return resp
        return result
    return wrapper


def check_debounce(cookie_name: str, window_s: float):
    # tiny chill cooldown so double-clicks dont spam writes
    raw = request.cookies.get(cookie_name, "")
    now = time.time()
    if raw:
        try:
            payload = rl_signer.loads(raw, max_age=3600)
            if now - float(payload.get("t", 0)) < window_s:
                return False, None
        except Exception:
            pass
    return True, rl_signer.dumps({"t": now})


def _bump_debounce(resp, cookie_value: str, cookie_name: str = "dh_w"):
    resp.set_cookie(cookie_name, cookie_value, max_age=3600,
                    httponly=True, samesite="Lax",
                    secure=(ENV == "production"), path="/")
    return resp


@app.after_request
def _headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["X-Frame-Options"] = "SAMEORIGIN"
    origin = request.headers.get("Origin")
    allowed = [o.strip() for o in ALLOWED_ORIGIN.split(",") if o.strip()]
    if origin and origin in allowed:
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Credentials"] = "true"
    return resp


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "time": utcnow_iso()})


@app.get("/")
def display():
    return render_template("display.html",
                           supabase_url=SUPABASE_URL, anon_key=SUPABASE_ANON_KEY)


@app.get("/api/public-config")
def public_config():
    return jsonify({"supabaseUrl": SUPABASE_URL, "anonKey": SUPABASE_ANON_KEY})


@app.get("/login")
def login_page():
    email, rotated, _ = get_admin()
    if email:
        resp = redirect("/admin")
        if rotated:
            _set_session_cookie(resp, rotated)
        return resp
    return render_template("login.html")


@app.get("/admin")
@page_login_required
def admin_page(admin_email=None):
    return render_template("admin.html", admin_email=admin_email)


@app.post("/api/auth/login")
def auth_login():
    ok, rl_cookie = check_debounce("dh_l", LOGIN_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "slow down — try again in a moment"}), 429
    data = request.get_json(force=True, silent=True) or {}
    email = str(data.get("email", "")).strip().lower()[:254]
    password = str(data.get("password", ""))
    if not email or not password:
        return jsonify({"error": "email and password required"}), 400
    try:
        r = requests.post(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"email": email, "password": password},
            timeout=10,
        )
    except requests.RequestException:
        return jsonify({"error": "auth service unreachable"}), 502
    if r.status_code != 200:
        return jsonify({"error": "invalid credentials"}), 401
    payload = r.json()
    user_email = (payload.get("user") or {}).get("email", email)
    resp = jsonify({"ok": True, "email": user_email})
    _set_session_cookie(resp, _session_cookie_value(
        user_email, payload.get("access_token", ""), payload.get("refresh_token", "")))
    _bump_debounce(resp, rl_cookie, "dh_l")
    return resp


@app.post("/api/auth/logout")
def auth_logout():
    resp = jsonify({"ok": True})
    _clear_session_cookie(resp)
    return resp


@app.get("/api/auth/me")
def auth_me():
    email, rotated, clear = get_admin()
    if not email:
        resp = jsonify({"authenticated": False})
        resp.status_code = 401
        if clear:
            _clear_session_cookie(resp)
        return resp
    resp = jsonify({"authenticated": True, "email": email})
    if rotated:
        _set_session_cookie(resp, rotated)
    return resp


@app.get("/api/announcement")
@api_login_required
def announcement_list():
    res = svc().table("announcements").select("*").order(
        "created_at", desc=True).limit(10).execute()
    return jsonify(res.data or [])


@app.post("/api/announcement")
@api_login_required
def announcement_push():
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    data = request.get_json(force=True, silent=True) or {}
    text = clean_text(data.get("text", ""), 500)
    if not text:
        return jsonify({"error": "announcement text required (max 500 chars)"}), 400
    row = svc().table("announcements").insert(
        {"text": text, "is_current": True}).execute()
    new_id = row.data[0]["id"]
    svc().table("announcements").update({"is_current": False}).neq("id", new_id).execute()
    resp = jsonify(row.data[0])
    resp.status_code = 201
    return _bump_debounce(resp, rl_cookie)


@app.post("/api/announcement/<aid>/repush")
@api_login_required
def announcement_repush(aid):
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    svc().table("announcements").update({"is_current": False}).eq("is_current", True).execute()
    res = svc().table("announcements").update({"is_current": True}).eq("id", aid).execute()
    if not res.data:
        return jsonify({"error": "not found"}), 404
    return _bump_debounce(jsonify(res.data[0]), rl_cookie)


@app.get("/api/timer")
@api_login_required
def timer_get():
    res = svc().table("timer_state").select("*").eq("id", 1).execute()
    return jsonify(res.data[0] if res.data else {})


@app.post("/api/timer")
@api_login_required
def timer_post():
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    data = request.get_json(force=True, silent=True) or {}
    action = str(data.get("action", "")).lower()
    cur = svc().table("timer_state").select("*").eq("id", 1).execute()
    state = cur.data[0] if cur.data else {
        "id": 1, "status": "idle", "label": "Hacking Period",
        "duration_seconds": 3600, "remaining_seconds": 3600, "ends_at": None,
    }

    if action == "set":
        try:
            dur = int(data.get("duration_seconds", state["duration_seconds"]))
        except (TypeError, ValueError):
            return jsonify({"error": "duration_seconds must be a number"}), 400
        dur = max(1, min(86400, dur))
        label = clean_text(data.get("label", state.get("label", "Hacking Period")), 60) or "Hacking Period"
        patch = {"duration_seconds": dur, "remaining_seconds": dur,
                 "label": label, "status": "idle", "ends_at": None}
    elif action == "start":
        remaining = int(state.get("remaining_seconds") or state.get("duration_seconds") or 60)
        if state.get("status") == "running":
            return _bump_debounce(jsonify(state), rl_cookie)
        if data.get("duration_seconds"):
            try:
                remaining = max(1, min(86400, int(data["duration_seconds"])))
            except (TypeError, ValueError):
                return jsonify({"error": "duration_seconds must be a number"}), 400
        label = clean_text(data.get("label", state.get("label", "")), 60) or state.get("label")
        ends_at = datetime.now(timezone.utc).timestamp() + remaining
        patch = {"status": "running", "remaining_seconds": remaining, "label": label,
                 "ends_at": datetime.fromtimestamp(ends_at, tz=timezone.utc).isoformat()}
    elif action == "pause":
        remaining = int(state.get("remaining_seconds", 0))
        if state.get("status") == "running" and state.get("ends_at"):
            try:
                ends = datetime.fromisoformat(str(state["ends_at"]).replace("Z", "+00:00"))
                remaining = max(0, int((ends - datetime.now(timezone.utc)).total_seconds()))
            except ValueError:
                pass
        patch = {"status": "paused", "remaining_seconds": remaining, "ends_at": None}
    elif action in ("reset", "stop"):
        patch = {"status": "idle",
                 "remaining_seconds": int(state.get("duration_seconds", 3600)),
                 "ends_at": None}
    elif action == "touch":
        patch = {}
    else:
        return jsonify({"error": "action must be set|start|pause|reset|touch"}), 400

    if patch:
        res = svc().table("timer_state").update(patch).eq("id", 1).execute()
        if not res.data:
            row = {"id": 1, **{**state, **patch}}
            res = svc().table("timer_state").upsert(row).execute()
        return _bump_debounce(jsonify(res.data[0]), rl_cookie)
    res = svc().table("timer_state").update(
        {"remaining_seconds": int(state.get("remaining_seconds", 0))}).eq("id", 1).execute()
    return _bump_debounce(jsonify(res.data[0] if res.data else state), rl_cookie)


@app.get("/api/teams")
@api_login_required
def teams_list():
    res = svc().table("teams").select("*").order("sort_order").execute()
    return jsonify(res.data or [])


@app.post("/api/teams")
@api_login_required
def teams_add():
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    data = request.get_json(force=True, silent=True) or {}
    name = clean_text(data.get("name", ""), 80)
    tagline = clean_text(data.get("tagline", ""), 140)
    track = clean_text(data.get("track", ""), 40)
    if not name:
        return jsonify({"error": "team name required"}), 400
    existing = svc().table("teams").select("sort_order").order(
        "sort_order", desc=True).limit(1).execute()
    nxt = (existing.data[0]["sort_order"] + 1) if existing.data else 1
    res = svc().table("teams").insert(
        {"name": name, "tagline": tagline, "track": track, "sort_order": nxt}).execute()
    resp = jsonify(res.data[0])
    resp.status_code = 201
    return _bump_debounce(resp, rl_cookie)


@app.delete("/api/teams/<tid>")
@api_login_required
def teams_delete(tid):
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    svc().table("teams").delete().eq("id", tid).execute()
    return _bump_debounce(jsonify({"ok": True}), rl_cookie)


@app.put("/api/teams/reorder")
@api_login_required
def teams_reorder():
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    data = request.get_json(force=True, silent=True) or {}
    ids = data.get("ordered_ids", [])
    if not isinstance(ids, list) or len(ids) > 200:
        return jsonify({"error": "ordered_ids must be a list"}), 400
    for i, tid in enumerate(ids):
        try:
            uuid.UUID(str(tid))
        except ValueError:
            continue
        svc().table("teams").update({"sort_order": i + 1}).eq("id", str(tid)).execute()
    return _bump_debounce(jsonify({"ok": True}), rl_cookie)


ALLOWED_IMG = {"png", "jpg", "jpeg", "svg", "webp", "gif"}
ALLOWED_SND = {"mp3"}
MAX_UPLOAD = 5 * 1024 * 1024


def _validate_upload(file, allowed_exts, allowed_prefix):
    if not file or not file.filename:
        return "no file provided"
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in allowed_exts:
        return f"invalid file type .{ext} — allowed: {sorted(allowed_exts)}"
    mt = (file.mimetype or "")
    if not mt.startswith(allowed_prefix) and not (ext == "svg"):
        return f"invalid mimetype {mt}"
    file.seek(0, os.SEEK_END)
    size = file.tell()
    file.seek(0)
    if size <= 0 or size > MAX_UPLOAD:
        return "file must be 1 byte – 5MB"
    return None


@app.get("/api/motifs")
@api_login_required
def motifs_list():
    res = svc().table("motifs").select("*").order("created_at", desc=True).execute()
    return jsonify(res.data or [])


@app.post("/api/motifs/upload")
@api_login_required
def motifs_upload():
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    f = request.files.get("file")
    err = _validate_upload(f, ALLOWED_IMG, "image/")
    if err:
        return jsonify({"error": err}), 400
    blob = f.read()
    ext = f.filename.rsplit(".", 1)[-1].lower()
    if ext == "svg":
        head = blob.lstrip()[:512].lower()
        if b"<svg" not in head:
            return jsonify({"error": "file does not look like an SVG"}), 400
    name = clean_text(request.form.get("name", f.filename), 80) or "motif"
    fname = f"{uuid.uuid4().hex}_{secure_filename(f.filename)}"
    ctype = "image/svg+xml" if ext == "svg" else (f.mimetype or "image/png")
    svc().storage.from_("motifs").upload(fname, blob, {"content-type": ctype})
    url = svc().storage.from_("motifs").get_public_url(fname)
    row = svc().table("motifs").insert({
        "name": name, "slug": slugify(name), "storage_path": fname,
        "public_url": url, "is_active": True}).execute()
    resp = jsonify(row.data[0])
    resp.status_code = 201
    return _bump_debounce(resp, rl_cookie)


@app.patch("/api/motifs/<mid>")
@api_login_required
def motifs_toggle(mid):
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    data = request.get_json(force=True, silent=True) or {}
    res = svc().table("motifs").update(
        {"is_active": bool(data.get("is_active", True))}).eq("id", mid).execute()
    if not res.data:
        return jsonify({"error": "not found"}), 404
    return _bump_debounce(jsonify(res.data[0]), rl_cookie)


@app.delete("/api/motifs/<mid>")
@api_login_required
def motifs_delete(mid):
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    cur = svc().table("motifs").select("*").eq("id", mid).execute()
    if cur.data:
        try:
            svc().storage.from_("motifs").remove([cur.data[0]["storage_path"]])
        except Exception:
            pass
    svc().table("motifs").delete().eq("id", mid).execute()
    return _bump_debounce(jsonify({"ok": True}), rl_cookie)


@app.get("/api/sounds")
@api_login_required
def sounds_list():
    res = svc().table("alert_sounds").select("*").order("created_at", desc=True).execute()
    return jsonify(res.data or [])


@app.post("/api/sounds/upload")
@api_login_required
def sounds_upload():
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    f = request.files.get("file")
    err = _validate_upload(f, ALLOWED_SND, "audio/")
    if err:
        return jsonify({"error": err}), 400
    head = f.read(3)
    f.seek(0)
    if not (head[:3] == b"ID3" or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)):
        return jsonify({"error": "file does not look like an MP3"}), 400
    name = clean_text(request.form.get("name", f.filename), 80) or "alert"
    blob = f.read()
    fname = f"{uuid.uuid4().hex}_{secure_filename(f.filename)}"
    if not fname.lower().endswith(".mp3"):
        fname += ".mp3"
    svc().storage.from_("alert-sounds").upload(fname, blob, {"content-type": "audio/mpeg"})
    url = svc().storage.from_("alert-sounds").get_public_url(fname)
    row = svc().table("alert_sounds").insert({
        "name": name, "storage_path": fname, "public_url": url,
        "is_active": False, "file_size": len(blob)}).execute()
    resp = jsonify(row.data[0])
    resp.status_code = 201
    return _bump_debounce(resp, rl_cookie)


@app.post("/api/sounds/<sid>/activate")
@api_login_required
def sounds_activate(sid):
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    svc().table("alert_sounds").update({"is_active": False}).eq("is_active", True).execute()
    res = svc().table("alert_sounds").update({"is_active": True}).eq("id", sid).execute()
    if not res.data:
        return jsonify({"error": "not found"}), 404
    return _bump_debounce(jsonify(res.data[0]), rl_cookie)


@app.delete("/api/sounds/<sid>")
@api_login_required
def sounds_delete(sid):
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    cur = svc().table("alert_sounds").select("*").eq("id", sid).execute()
    if cur.data:
        try:
            svc().storage.from_("alert-sounds").remove([cur.data[0]["storage_path"]])
        except Exception:
            pass
    svc().table("alert_sounds").delete().eq("id", sid).execute()
    return _bump_debounce(jsonify({"ok": True}), rl_cookie)


@app.get("/api/status")
@api_login_required
def status():
    def last(table):
        try:
            r = svc().table(table).select("updated_at").order(
                "updated_at", desc=True).limit(1).execute()
            return r.data[0]["updated_at"] if r.data else None
        except Exception:
            return None

    def count(table):
        try:
            r = svc().table(table).select("id", count="exact").limit(1).execute()
            return r.count
        except Exception:
            return None

    return jsonify({
        "last_updated": {
            "announcements": last("announcements"),
            "timer_state": last("timer_state"),
            "teams": last("teams"),
            "motifs": last("motifs"),
            "alert_sounds": last("alert_sounds"),
        },
        "counts": {
            "teams": count("teams"),
            "announcements": count("announcements"),
        },
        "server_time": utcnow_iso(),
    })


@app.post("/api/refresh")
@api_login_required
def refresh_touch():
    # manual "hey everyone re-sync" button, changes nothing real
    ok, rl_cookie = check_debounce("dh_w", WRITE_DEBOUNCE_SECONDS)
    if not ok:
        return jsonify({"error": "debounced — wait a second and retry"}), 429
    cur = svc().table("timer_state").select("*").eq("id", 1).execute()
    state = cur.data[0] if cur.data else {"remaining_seconds": 60}
    res = svc().table("timer_state").update(
        {"remaining_seconds": int(state.get("remaining_seconds", 60))}).eq("id", 1).execute()
    return _bump_debounce(
        jsonify({"ok": True, "timer": res.data[0] if res.data else state}), rl_cookie)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=(ENV != "production"))
