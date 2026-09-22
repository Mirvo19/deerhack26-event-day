(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var toastEl = $("toast");
  var toastT = null;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove("show"); }, 2200);
  }

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    opts.headers = opts.headers || {};
    if (opts.body && !(opts.body instanceof FormData) && !opts.headers["Content-Type"]) {
      opts.headers["Content-Type"] = "application/json";
    }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { window.location.href = "/login"; throw new Error("signed out"); }
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
        return j;
      });
    });
  }

  function esc(s) { return String(s == null ? "" : s); }

  $("logout-btn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).finally(function () {
      window.location.href = "/login";
    });
  });

  function loadAnn() {
    api("/api/announcement").then(function (rows) {
      var box = $("ann-history"); box.innerHTML = "";
      rows.slice(0, 5).forEach(function (a) {
        var d = document.createElement("div"); d.className = "list-item";
        var m = document.createElement("div"); m.className = "meta";
        var b = document.createElement("b"); b.textContent = a.text;
        var s = document.createElement("span");
        s.textContent = new Date(a.created_at).toLocaleString() + (a.is_current ? " · LIVE NOW" : "");
        m.appendChild(b); m.appendChild(s); d.appendChild(m);
        var act = document.createElement("div"); act.className = "actions";
        if (a.is_current) {
          var tag = document.createElement("span"); tag.className = "active-tag"; tag.textContent = "LIVE";
          act.appendChild(tag);
        } else {
          var btn = document.createElement("button"); btn.className = "ghost small"; btn.textContent = "Re-push";
          btn.onclick = function () {
            api("/api/announcement/" + a.id + "/repush", { method: "POST" })
              .then(function () { toast("Re-pushed"); loadAnn(); })
              .catch(function (e) { toast(e.message); });
          };
          act.appendChild(btn);
        }
        d.appendChild(act); box.appendChild(d);
      });
      if (!rows.length) box.textContent = "No announcements yet.";
    }).catch(function (e) { if (e.message !== "signed out") toast(e.message); });
  }
  $("ann-push").addEventListener("click", function () {
    var t = $("ann-text").value.trim();
    if (!t) return toast("Type an announcement first");

    api("/api/announcement", { method: "POST", body: JSON.stringify({ text: t.slice(0, 500) }) })
      .then(function () { $("ann-text").value = ""; toast("Pushed live"); loadAnn(); })
      .catch(function (e) { toast(e.message); });
  });
  $("ann-reload").addEventListener("click", loadAnn);

  function durSecs() {
    var h = Math.max(0, Math.min(24, +$("t-h").value || 0));
    var m = Math.max(0, Math.min(59, +$("t-m").value || 0));
    var s = Math.max(0, Math.min(59, +$("t-s").value || 0));
    return h * 3600 + m * 60 + s;
  }
  function loadTimer() {
    api("/api/timer").then(function (t) {
      $("timer-state-line").textContent =
        "status: " + esc(t.status) + " · label: " + esc(t.label || "") +
        " · remaining: " + esc(t.remaining_seconds) + "s · duration: " + esc(t.duration_seconds) + "s";
    }).catch(function () {});
  }
  function timerCmd(action) {
    var body = { action: action, label: $("t-label").value };
    if (action === "start" || action === "set") body.duration_seconds = durSecs() || 60;
    api("/api/timer", { method: "POST", body: JSON.stringify(body) })
      .then(function () { toast("Timer: " + action); loadTimer(); })
      .catch(function (e) { toast(e.message); });
  }
  $("timer-start").onclick = function () { timerCmd("start"); };
  $("timer-pause").onclick = function () { timerCmd("pause"); };
  $("timer-reset").onclick = function () { timerCmd("reset"); };
  $("timer-set").onclick = function () { timerCmd("set"); };

  function loadTeams() {
    api("/api/teams").then(function (rows) {
      var box = $("team-list"); box.innerHTML = "";
      rows.forEach(function (t, i) {
        var d = document.createElement("div"); d.className = "list-item";
        var m = document.createElement("div"); m.className = "meta";
        var b = document.createElement("b"); b.textContent = (i + 1) + ". " + t.name;
        var s = document.createElement("span");
        s.textContent = [t.tagline, t.track].filter(Boolean).join(" · ");
        m.appendChild(b); m.appendChild(s); d.appendChild(m);
        var act = document.createElement("div"); act.className = "actions";
        var up = document.createElement("button"); up.className = "ghost small"; up.textContent = "↑";
        up.title = "Move up";
        up.onclick = function () { moveTeam(rows, i, -1); };
        var dn = document.createElement("button"); dn.className = "ghost small"; dn.textContent = "↓";
        dn.title = "Move down";
        dn.onclick = function () { moveTeam(rows, i, 1); };
        var del = document.createElement("button"); del.className = "danger small"; del.textContent = "Remove";
        del.onclick = function () {
          if (!confirm("Remove " + t.name + "?")) return;
          api("/api/teams/" + t.id, { method: "DELETE" }).then(loadTeams).catch(function (e) { toast(e.message); });
        };
        act.appendChild(up); act.appendChild(dn); act.appendChild(del);
        d.appendChild(act); box.appendChild(d);
      });
      if (!rows.length) box.textContent = "No teams yet.";
    }).catch(function () {});
  }
  function moveTeam(rows, i, dir) {
    var j = i + dir;
    if (j < 0 || j >= rows.length) return;
    var ids = rows.map(function (r) { return r.id; });
    var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    api("/api/teams/reorder", { method: "PUT", body: JSON.stringify({ ordered_ids: ids }) })
      .then(loadTeams).catch(function (e) { toast(e.message); });
  }
  $("team-add").addEventListener("click", function () {
    var name = $("team-name").value.trim();
    if (!name) return toast("Team name required");
    api("/api/teams", { method: "POST", body: JSON.stringify({
      name: name.slice(0, 80), tagline: $("team-tag").value.slice(0, 140),
      track: $("team-track").value.slice(0, 40) }) })
      .then(function () {
        $("team-name").value = ""; $("team-tag").value = ""; $("team-track").value = "";
        toast("Team added"); loadTeams();
      }).catch(function (e) { toast(e.message); });
  });

  function loadMotifs() {
    api("/api/motifs").then(function (rows) {
      var box = $("motif-list"); box.innerHTML = "";
      rows.forEach(function (m) {
        var d = document.createElement("div"); d.className = "list-item";
        var mta = document.createElement("div"); mta.className = "meta";
        var b = document.createElement("b"); b.textContent = m.name;
        var s = document.createElement("span"); s.textContent = m.slug + " · " + new Date(m.created_at).toLocaleString();
        mta.appendChild(b); mta.appendChild(s); d.appendChild(mta);
        var act = document.createElement("div"); act.className = "actions";
        var prev = document.createElement("a"); prev.href = m.public_url; prev.target = "_blank";
        prev.className = "btn ghost small"; prev.textContent = "View"; prev.style.textDecoration = "none";
        var tg = document.createElement("button");
        tg.className = "ghost small"; tg.textContent = m.is_active ? "Deactivate" : "Activate";
        tg.onclick = function () {
          api("/api/motifs/" + m.id, { method: "PATCH",
            body: JSON.stringify({ is_active: !m.is_active }) }).then(loadMotifs).catch(function (e) { toast(e.message); });
        };
        var del = document.createElement("button"); del.className = "danger small"; del.textContent = "Delete";
        del.onclick = function () {
          if (!confirm("Delete motif " + m.name + "?")) return;
          api("/api/motifs/" + m.id, { method: "DELETE" }).then(loadMotifs).catch(function (e) { toast(e.message); });
        };
        act.appendChild(prev); act.appendChild(tg); act.appendChild(del);
        d.appendChild(act); box.appendChild(d);
      });
      if (!rows.length) box.textContent = "No motifs yet.";
    }).catch(function () {});
  }
  $("motif-upload").addEventListener("click", function () {
    var f = $("motif-file").files[0];
    if (!f) return toast("Choose an image first");
    if (f.size > 5 * 1024 * 1024) return toast("Max 5MB");
    var fd = new FormData();
    fd.append("file", f); fd.append("name", $("motif-name").value || f.name);
    api("/api/motifs/upload", { method: "POST", body: fd })
      .then(function () { toast("Motif uploaded"); $("motif-file").value = ""; loadMotifs(); })
      .catch(function (e) { toast(e.message); });
  });

  function loadSounds() {
    api("/api/sounds").then(function (rows) {
      var box = $("sound-list"); box.innerHTML = "";
      rows.forEach(function (s) {
        var d = document.createElement("div"); d.className = "list-item";
        var mta = document.createElement("div"); mta.className = "meta";
        var b = document.createElement("b"); b.textContent = s.name;
        var sp = document.createElement("span");
        sp.textContent = (s.file_size ? Math.round(s.file_size / 1024) + " KB · " : "") +
          new Date(s.created_at).toLocaleString();
        mta.appendChild(b); mta.appendChild(sp); d.appendChild(mta);
        var act = document.createElement("div"); act.className = "actions";
        var play = document.createElement("button"); play.className = "ghost small"; play.textContent = "Preview";
        play.onclick = function () { new Audio(s.public_url).play().catch(function () {}); };
        if (s.is_active) {
          var tag = document.createElement("span"); tag.className = "active-tag"; tag.textContent = "ACTIVE";
          act.appendChild(tag);
        } else {
          var set = document.createElement("button"); set.className = "small"; set.textContent = "Set active";
          set.onclick = function () {
            api("/api/sounds/" + s.id + "/activate", { method: "POST" })
              .then(function () { toast("Alert sound set"); loadSounds(); })
              .catch(function (e) { toast(e.message); });
          };
          act.appendChild(set);
        }
        var del = document.createElement("button"); del.className = "danger small"; del.textContent = "Delete";
        del.onclick = function () {
          if (!confirm("Delete sound " + s.name + "?")) return;
          api("/api/sounds/" + s.id, { method: "DELETE" }).then(loadSounds).catch(function (e) { toast(e.message); });
        };
        act.appendChild(play); act.appendChild(del);
        d.appendChild(act); box.appendChild(d);
      });
      if (!rows.length) box.textContent = "No sounds yet.";
    }).catch(function () {});
  }
  $("sound-upload").addEventListener("click", function () {
    var f = $("sound-file").files[0];
    if (!f) return toast("Choose an MP3 first");
    if (!/\.mp3$/i.test(f.name)) return toast("MP3 only");
    if (f.size > 5 * 1024 * 1024) return toast("Max 5MB");
    var fd = new FormData();
    fd.append("file", f); fd.append("name", $("sound-name").value || f.name);
    api("/api/sounds/upload", { method: "POST", body: fd })
      .then(function () { toast("Sound uploaded"); $("sound-file").value = ""; loadSounds(); })
      .catch(function (e) { toast(e.message); });
  });

  function loadStatus() {
    api("/api/status").then(function (s) {
      var g = $("status-grid"); g.innerHTML = "";
      Object.entries(s.last_updated || {}).forEach(function (kv) {
        var c = document.createElement("div"); c.className = "status-cell";
        var b = document.createElement("b"); b.textContent = kv[0];
        var v = document.createElement("div");
        v.textContent = kv[1] ? new Date(kv[1]).toLocaleString() : "never";
        c.appendChild(b); c.appendChild(v); g.appendChild(c);
      });
    }).catch(function () {});
  }
  $("status-reload").addEventListener("click", function () { loadStatus(); loadTimer(); });
  $("force-resync").addEventListener("click", function () {
    api("/api/refresh", { method: "POST" })
      .then(function () { toast("Refresh pushed — displays re-sync"); })
      .catch(function (e) { toast(e.message); });
  });

  loadAnn(); loadTimer(); loadTeams(); loadMotifs(); loadSounds(); loadStatus();
})();
