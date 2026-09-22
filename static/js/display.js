(function () {
  "use strict";

  var cfg = window.__DH_CONFIG__ || {};
  if (!cfg.supabaseUrl || !cfg.anonKey || cfg.supabaseUrl.indexOf("xyzcompany") !== -1) {

    bootDemo();
    return;
  }

  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.anonKey, {
    realtime: { params: { eventsPerSecond: 10 } },
  });

  var state = {
    announcement: null,
    timer: null,
    teams: [],
    motifs: [],
    soundUrl: null,
  };
  var ready = false;

  var LOCAL_GLYPHS = [
    "/static/motifs/glyph-deer.svg",
    "/static/motifs/glyph-bridge.svg",
    "/static/motifs/glyph-cross.svg",
    "/static/motifs/glyph-weave.svg",
    "/static/motifs/glyph-fin.svg",
    "/static/motifs/glyph-zig.svg",
  ];

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    announceCard: $("announce-card"),
    annText: $("announcement-text"), annMeta: $("announcement-meta"),
    timerCard: $("timer-card"), timerKicker: $("timer-kicker"),
    timerLabel: $("timer-label"), timerDigits: $("timer-digits"),
    timerSub: $("timer-sub"), timerBar: $("timer-bar"),
    timerDuration: $("timer-duration"), timerEnds: $("timer-ends"),
    marquee: $("marquee-track"), teamCount: $("team-count"),
    motifLayer: $("motif-layer"), audio: $("alert-audio"),
    liveInd: $("live-ind"), liveNote: $("live-note"), clock: $("clock"),
    gate: $("sound-gate"),
  };

  function setText(el, v) { if (el) el.textContent = v; }

  function tickClock() {
    var d = new Date();
    setText(els.clock,
      String(d.getHours()).padStart(2, "0") + ":" +
      String(d.getMinutes()).padStart(2, "0"));
  }
  tickClock();
  setInterval(tickClock, 5000);

  var soundBtn = $("sound-enable");
  if (soundBtn && els.audio) soundBtn.addEventListener("click", function () {
    try {
      els.audio.muted = true;
      var p = els.audio.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
    els.audio.muted = false;
    if (els.gate) els.gate.hidden = true;
    try { localStorage.setItem("dh-sound-ok", "1"); } catch (e) {}
  });
  try { if (els.gate && localStorage.getItem("dh-sound-ok") === "1") els.gate.hidden = true; } catch (e) {}
  document.addEventListener("click", function once() {
    if (els.gate && !els.gate.hidden && soundBtn) { soundBtn.click(); }
    document.removeEventListener("click", once);
  });

  function playAlert() {

    if (!ready || !state.soundUrl || !els.audio) return;
    if (els.gate && !els.gate.hidden) return;
    try {
      els.audio.src = state.soundUrl;
      var p = els.audio.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function motionAnimate(el, keyframes, opts) {
    try {
      if (window.Motion && window.Motion.animate) return window.Motion.animate(el, keyframes, opts);
    } catch (e) {}
    return null;
  }

  function fitAnnouncement() {
    var card = els.announceCard, el = els.annText;
    if (!card || !el) return;
    var head = card.querySelector(".kicker");
    var foot = card.querySelector(".announce-foot");
    var reserve = 48 + (head ? head.offsetHeight + 14 : 30) + (foot ? foot.offsetHeight + 16 : 30);
    var avail = Math.max(80, card.clientHeight - reserve);
    el.style.fontSize = "";
    var size = parseFloat(getComputedStyle(el).fontSize) || 34;
    el.style.fontSize = size + "px";
    var guard = 40;
    while (guard-- > 0 && size > 18 &&
        (el.scrollHeight > avail || el.scrollWidth > el.clientWidth)) {
      size -= 2;
      el.style.fontSize = size + "px";
    }
  }

  function fitTimer() {
    var el = els.timerDigits;
    if (!el) return;
    el.style.fontSize = "";
    var size = parseFloat(getComputedStyle(el).fontSize) || 120;
    el.style.fontSize = size + "px";
    var guard = 30;
    while (guard-- > 0 && size > 26 && el.scrollWidth > el.clientWidth) {
      size -= 4;
      el.style.fontSize = size + "px";
    }
  }
  window.addEventListener("resize", function () { fitAnnouncement(); fitTimer(); });

  function renderAnnouncement(animate) {
    var t = (state.announcement && state.announcement.text) || "Welcome to DeerHack.";
    setText(els.annText, t);
    var when = state.announcement && state.announcement.updated_at
      ? new Date(state.announcement.updated_at).toLocaleTimeString() : "stand by";
    setText(els.annMeta, "updated " + when + " · live");
    fitAnnouncement();
    if (animate) {
      motionAnimate(els.annText, [{ opacity: 0, y: 14 }, { opacity: 1, y: 0 }],
        { duration: 0.45, easing: "ease-out" });
    }
  }

  function fmtHMS(total) {
    total = Math.max(0, Math.floor(total));
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return [h, m, s].map(function (n) { return String(n).padStart(2, "0"); }).join(":");
  }
  function fmtDur(total) {
    total = Math.max(0, Math.floor(total));
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
    return h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
  }

  function currentRemaining() {
    var t = state.timer;
    if (!t) return 0;
    if (t.status === "running" && t.ends_at) {
      return Math.max(0, (new Date(t.ends_at).getTime() - Date.now()) / 1000);
    }
    return Math.max(0, Number(t.remaining_seconds || 0));
  }

  function renderTimer(animate) {
    var t = state.timer;
    if (!t) return;
    var status = t.status === "running" && currentRemaining() <= 0 ? "ended" : t.status;
    if (els.timerCard) els.timerCard.dataset.state = status;
    setText(els.timerKicker, status === "ended" ? "time" : (t.label || "Hacking Period"));
    setText(els.timerLabel, t.label || "Hacking Period");
    setText(els.timerSub,
      status === "running" ? "live · stay in sync" :
      status === "paused" ? "paused" :
      status === "ended" ? "time — great work" : "standby");
    setText(els.timerDuration, "session " + fmtDur(t.duration_seconds || 0));
    setText(els.timerEnds,
      (status === "running" && t.ends_at)
        ? "ends " + new Date(t.ends_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "");
    if (t.duration_seconds > 0 && els.timerBar) {
      var pct = 100 * (1 - currentRemaining() / t.duration_seconds);
      els.timerBar.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + "%";
    }
    tickTimerDigits();
    fitTimer();
    if (animate) {
      motionAnimate(els.timerCard, [{ scale: 0.985 }, { scale: 1 }], { duration: 0.3 });
    }
  }

  function tickTimerDigits() {

    setText(els.timerDigits, fmtHMS(currentRemaining()));
    var t = state.timer;
    var cardState = els.timerCard && els.timerCard.dataset.state;
    if (t && t.status === "running" && currentRemaining() <= 0 && cardState !== "ended") {
      renderTimer(false);
      playAlert();
    }
  }
  setInterval(tickTimerDigits, 250);

  function renderTeams(animate) {
    var chips = [];
    state.teams.forEach(function (tm, i) {
      var chip = document.createElement("span");
      chip.className = "team-chip";
      var idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = String(i + 1).padStart(2, "0");
      var nm = document.createElement("span");
      nm.textContent = tm.name;
      chip.appendChild(idx); chip.appendChild(nm);
      if (tm.tagline) {
        var tg = document.createElement("small");
        tg.textContent = "· " + tm.tagline;
        chip.appendChild(tg);
      }
      if (tm.track) {
        var tr = document.createElement("span");
        tr.className = "track-tag";
        tr.textContent = tm.track;
        chip.appendChild(tr);
      }
      chips.push(chip);
    });
    if (!chips.length) {
      var empty = document.createElement("span");
      empty.className = "team-chip";
      empty.textContent = "Teams will appear here once registration closes";
      chips.push(empty);
    }
    var track = document.createElement("div");
    track.className = "marquee-track";
    chips.forEach(function (c) { track.appendChild(c.cloneNode(true)); });
    chips.forEach(function (c) { track.appendChild(c.cloneNode(true)); });
    if (els.marquee) {
      els.marquee.replaceWith(track);
      track.id = "marquee-track";
      els.marquee = track;
    }
    requestAnimationFrame(function () {
      var half = track.scrollWidth / 2 || 800;
      var secs = Math.min(120, Math.max(18, half / 60));
      track.style.setProperty("--marquee-dur", secs + "s");
    });
    setText(els.teamCount, state.teams.length ? state.teams.length + " teams" : "");
    if (animate) motionAnimate(track, [{ opacity: 0.2 }, { opacity: 1 }], { duration: 0.4 });
  }

  var MOTIF_SPOTS = [
    { left: "1%", top: "14%", w: 120 }, { right: "1.5%", top: "10%", w: 150 },
    { left: "2%", bottom: "20%", w: 170 }, { right: "2%", bottom: "24%", w: 120 },
    { left: "44%", top: "1%", w: 90 }, { right: "38%", bottom: "3%", w: 70 },
  ];

  function renderMotifs() {
    if (!els.motifLayer) return;
    els.motifLayer.innerHTML = "";
    var urls = state.motifs.filter(function (m) { return m.is_active !== false; })
      .map(function (m) { return m.public_url; })
      .filter(Boolean)
      .slice(0, 6);
    if (!urls.length) urls = LOCAL_GLYPHS.slice();
    urls.forEach(function (url, i) {
      var img = document.createElement("img");
      img.className = "motif";
      img.src = url;
      img.alt = "";
      img.loading = "eager";

      img.onerror = function () { img.remove(); };
      var s = MOTIF_SPOTS[i % MOTIF_SPOTS.length];
      img.style.width = s.w + "px";
      if (s.left) img.style.left = s.left;
      if (s.right) img.style.right = s.right;
      if (s.top) img.style.top = s.top;
      if (s.bottom) img.style.bottom = s.bottom;
      els.motifLayer.appendChild(img);

      motionAnimate(img,
        [{ y: 0, x: 0, opacity: 0.09 }, { y: -18, x: 8, opacity: 0.16 }, { y: 0, x: 0, opacity: 0.09 }],
        { duration: 8 + i * 1.7, repeat: Infinity, easing: "ease-in-out" });
    });
  }

  function fetchTable(promise, fallback) {
    return promise.then(function (r) { return r; }, function () { return { data: fallback }; });
  }

  function fetchAll() {
    return Promise.all([
      fetchTable(sb.from("announcements").select("text,updated_at").eq("is_current", true)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle(), null),
      fetchTable(sb.from("timer_state").select("*").eq("id", 1).maybeSingle(), null),
      fetchTable(sb.from("teams").select("id,name,tagline,track,sort_order").order("sort_order"), []),
      fetchTable(sb.from("motifs").select("id,public_url,is_active").eq("is_active", true), []),
      fetchTable(sb.from("alert_sounds").select("public_url").eq("is_active", true).limit(1).maybeSingle(), null),
    ]).then(function (rs) {
      var ok = 0;
      if (rs[0].data) { state.announcement = rs[0].data; ok++; }
      if (rs[1].data) { state.timer = rs[1].data; ok++; }
      if (rs[2].data) { state.teams = rs[2].data; ok++; }
      if (rs[3].data) { state.motifs = rs[3].data; ok++; }
      var snd = rs[4].data && rs[4].data.public_url;
      if (snd) { state.soundUrl = snd; if (els.audio) els.audio.src = snd; ok++; }
      if (!ok) { setConn("offline", "link lost — retrying…"); return 0; }
      renderAnnouncement(false); renderTimer(false); renderTeams(false); renderMotifs();
      return ok;
    });
  }

  function setConn(connState, note) {

    if (els.liveInd) els.liveInd.dataset.state = connState;
    setText(els.liveNote, note ? note : connState === "live" ? "realtime linked"
      : connState === "syncing" ? "linking realtime…" : "reconnecting…");
  }

  function onChange(table) {

    var q;
    if (table === "announcements") {
      q = sb.from("announcements").select("text,updated_at").eq("is_current", true)
        .order("updated_at", { ascending: false }).limit(1).maybeSingle()
        .then(function (r) {
          if (r.data && (!state.announcement || r.data.updated_at !== state.announcement.updated_at ||
              r.data.text !== state.announcement.text)) {
            state.announcement = r.data;
            renderAnnouncement(true);
            return true;
          }
          return false;
        });
    } else if (table === "timer_state") {
      q = sb.from("timer_state").select("*").eq("id", 1).maybeSingle()
        .then(function (r) {
          if (r.data) { state.timer = r.data; renderTimer(true); return true; }
          return false;
        });
    } else if (table === "teams") {
      q = sb.from("teams").select("id,name,tagline,track,sort_order").order("sort_order")
        .then(function (r) { state.teams = r.data || []; renderTeams(true); return true; });
    } else if (table === "motifs") {
      q = sb.from("motifs").select("id,public_url,is_active").eq("is_active", true)
        .then(function (r) { state.motifs = r.data || []; renderMotifs(); return true; });
    } else if (table === "alert_sounds") {
      q = sb.from("alert_sounds").select("public_url").eq("is_active", true).limit(1).maybeSingle()
        .then(function (r) {
          state.soundUrl = (r.data && r.data.public_url) || null;
          if (state.soundUrl && els.audio) els.audio.src = state.soundUrl;
          return true;
        });
    }
    if (q) q.then(function (changed) { if (changed) playAlert(); }, function () { fetchAll(); });
  }

  var channel = sb.channel("display-live");
  ["announcements", "timer_state", "teams", "motifs", "alert_sounds"].forEach(function (t) {
    channel.on("postgres_changes", { event: "*", schema: "public", table: t },
      function () { onChange(t); });
  });
  channel.subscribe(function (status) {
    if (status === "SUBSCRIBED") {
      setConn("live");
      fetchAll().then(function (ok) { ready = true; if (ok) setConn("live"); });
    } else if (status === "CLOSED" || status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
      setConn("offline");
    } else {
      setConn("syncing");
    }
  });

  window.addEventListener("online", function () { fetchAll(); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) fetchAll().then(function (ok) { ready = true; if (ok) setConn("live"); });
  });

  setInterval(function () {
    if (!ready || document.hidden) return;
    sb.from("timer_state").select("updated_at").eq("id", 1).maybeSingle().then(function (r) {
      if (r.data && state.timer && r.data.updated_at !== state.timer.updated_at) onChange("timer_state");
    }).catch(function () {});
    sb.from("announcements").select("text,updated_at").eq("is_current", true)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle().then(function (r) {
        if (r.data && state.announcement &&
          (r.data.updated_at !== state.announcement.updated_at || r.data.text !== state.announcement.text)) {
          onChange("announcements");
        }
      }).catch(function () {});
  }, 15000);

  setConn("syncing");
  fetchAll().then(function (ok) { ready = true; if (ok) setConn("live"); });

  function bootDemo() {
    state.announcement = { text: "Go to Sagarmatha Hall for the opening ceremony.", updated_at: new Date().toISOString() };
    state.timer = { status: "running", label: "Hacking Period", duration_seconds: 7200,
      remaining_seconds: 5400, ends_at: new Date(Date.now() + 5400000).toISOString() };
    state.teams = [
      { name: "YakByte Collective", tagline: "AI attendance for rural schools", track: "AI for Good" },
      { name: "MomoCoders", tagline: "Nepali recipe finder", track: "Web" },
      { name: "Himalayan Ping", tagline: "Offline mesh chat", track: "Hardware" },
    ];
    state.motifs = [];
    ready = true;
    renderAnnouncement(false); renderTimer(false); renderTeams(false); renderMotifs();
    setText(document.getElementById("live-note"), "demo — add keys");
    var demoInd = document.getElementById("live-ind");
    if (demoInd) demoInd.dataset.state = "syncing";
  }
})();
