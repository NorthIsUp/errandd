export const pageScript = String.raw`    // --- Token management ---
    (function() {
      var stored = sessionStorage.getItem("__claw_tok");
      var fromUrl = new URL(location.href).searchParams.get("token");
      if (fromUrl) {
        stored = fromUrl;
        sessionStorage.setItem("__claw_tok", stored);
        var clean = new URL(location.href);
        clean.searchParams.delete("token");
        history.replaceState(null, "", clean.toString());
      }
      if (!stored) {
        document.addEventListener("DOMContentLoaded", function() {
          document.body.innerHTML = '<div style="font-family:monospace;padding:2rem;max-width:480px;margin:4rem auto">' +
            '<h2 style="margin-bottom:1rem">ClaudeClaw — Auth Required</h2>' +
            '<p style="margin-bottom:1rem">Paste the token from the daemon log to continue.</p>' +
            '<input id="tok-input" type="text" placeholder="Token" style="width:100%;padding:.5rem;margin-bottom:.75rem;font-family:monospace;box-sizing:border-box">' +
            '<button onclick="var t=document.getElementById(\'tok-input\').value.trim();if(t){sessionStorage.setItem(\'__claw_tok\',t);location.reload();}" ' +
            'style="padding:.5rem 1.25rem;cursor:pointer">Continue</button></div>';
        });
        return;
      }
      var _origFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        var url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
        if (typeof url === "string" && url.startsWith("/api/")) {
          init = Object.assign({}, init);
          init.headers = Object.assign({ "Authorization": "Bearer " + stored }, init.headers);
        }
        return _origFetch(input, init);
      };
    })();

    var $ = function(id) { return document.getElementById(id); };

    // --- Utility functions ---
    function esc(s) {
      return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function escAttr(s) {
      return esc(String(s)).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function fmtDur(ms) {
      if (ms == null) return "n/a";
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400);
      if (d > 0) {
        var h2 = Math.floor((s % 86400) / 3600);
        return d + "d " + h2 + "h";
      }
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var ss = s % 60;
      if (h > 0) return h + "h " + m + "m";
      if (m > 0) return m + "m " + ss + "s";
      return ss + "s";
    }

    function fmtRelative(iso) {
      if (!iso) return "—";
      var delta = Date.now() - new Date(iso).getTime();
      var s = Math.floor(delta / 1000);
      if (s < 60) return s + "s ago";
      var m = Math.floor(s / 60);
      if (m < 60) return m + "m ago";
      var h = Math.floor(m / 60);
      if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }

    function fmtTokens(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "K";
      return String(n);
    }

    function fmtCost(usd) {
      if (usd <= 0) return "$0.00";
      if (usd < 0.01) return "<$0.01";
      return "$" + usd.toFixed(2);
    }

    function cap(s) {
      if (!s) return "";
      return s.slice(0, 1).toUpperCase() + s.slice(1);
    }

    function formatSessionTime(isoStr) {
      if (!isoStr) return "";
      try {
        var d = new Date(isoStr);
        var now = new Date();
        var tz = clockTimezone;
        var dateStr = d.toLocaleDateString([], { timeZone: tz });
        var nowStr = now.toLocaleDateString([], { timeZone: tz });
        if (dateStr === nowStr) {
          return formatClockTime(d);
        }
        return d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: tz });
      } catch (e) { return ""; }
    }

    // --- Clock and time ---
    var use12Hour = localStorage.getItem("clock.format") === "12";
    var heartbeatTimezoneOffsetMinutes = 0;
    var clockTimezone = "UTC";

    function formatClockTime(isoOrMs) {
      try {
        var d = new Date(isoOrMs);
        if (isNaN(d.getTime())) return "";
        return d.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          hour12: use12Hour,
          timeZone: clockTimezone
        });
      } catch (e) { return ""; }
    }

    function clampTimezoneOffsetMinutes(value) {
      var n = Number(value);
      if (!Number.isFinite(n)) return 0;
      return Math.max(-720, Math.min(840, Math.round(n)));
    }

    function toOffsetDate(baseDate) {
      var base = baseDate instanceof Date ? baseDate : new Date(baseDate);
      return new Date(base.getTime() + heartbeatTimezoneOffsetMinutes * 60000);
    }

    function formatOffsetDate(baseDate, options) {
      return new Intl.DateTimeFormat(undefined, Object.assign({}, options, { timeZone: "UTC" })).format(toOffsetDate(baseDate));
    }

    function matchCronField(field, value) {
      var parts = String(field || "").split(",");
      for (var pi = 0; pi < parts.length; pi++) {
        var part = String(parts[pi] || "").trim();
        if (!part) continue;
        var pair = part.split("/");
        var range = pair[0];
        var stepStr = pair[1];
        var step = stepStr ? parseInt(stepStr, 10) : 1;
        if (!Number.isInteger(step) || step <= 0) continue;
        if (range === "*") {
          if (value % step === 0) return true;
          continue;
        }
        if (range.indexOf("-") !== -1) {
          var bounds = range.split("-");
          var lo = parseInt(bounds[0], 10);
          var hi = parseInt(bounds[1], 10);
          if (!Number.isInteger(lo) || !Number.isInteger(hi)) continue;
          if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
          continue;
        }
        if (parseInt(range, 10) === value) return true;
      }
      return false;
    }

    function cronMatchesAt(schedule, date) {
      var parts = String(schedule || "").trim().split(/\s+/);
      if (parts.length !== 5) return false;
      var shifted = toOffsetDate(date);
      var d = {
        minute: shifted.getUTCMinutes(),
        hour: shifted.getUTCHours(),
        dayOfMonth: shifted.getUTCDate(),
        month: shifted.getUTCMonth() + 1,
        dayOfWeek: shifted.getUTCDay()
      };
      return matchCronField(parts[0], d.minute) &&
        matchCronField(parts[1], d.hour) &&
        matchCronField(parts[2], d.dayOfMonth) &&
        matchCronField(parts[3], d.month) &&
        matchCronField(parts[4], d.dayOfWeek);
    }

    function nextRunAt(schedule, now) {
      var probe = new Date(now);
      probe.setSeconds(0, 0);
      probe.setMinutes(probe.getMinutes() + 1);
      for (var i = 0; i < 2880; i++) {
        if (cronMatchesAt(schedule, probe)) return new Date(probe);
        probe.setMinutes(probe.getMinutes() + 1);
      }
      return null;
    }

    // --- Section router ---
    var SECTIONS = ["home", "chats", "jobs", "settings"];

    // Resolve the section from the URL #fragment, falling back to "home".
    function sectionFromHash() {
      var h = (location.hash || "").replace(/^#/, "");
      return SECTIONS.indexOf(h) !== -1 ? h : "home";
    }

    function showSection(name) {
      if (SECTIONS.indexOf(name) === -1) name = "home";
      document.querySelectorAll(".section").forEach(function(s) {
        s.hidden = s.id !== "section-" + name;
        s.classList.toggle("section-active", s.id === "section-" + name);
      });
      document.querySelectorAll(".rail-btn").forEach(function(b) {
        b.classList.toggle("rail-btn-active", b.dataset.section === name);
      });
      var rail = $("rail");
      var scrim = $("rail-scrim");
      if (rail) rail.classList.remove("rail-open");
      if (scrim) scrim.hidden = true;
      // Track the active section in the URL #fragment so a refresh stays put.
      if (location.hash.replace(/^#/, "") !== name) location.hash = name;
      if (name === "home") loadHome();
      if (name === "chats") loadSessions();
      if (name === "jobs") loadJobsSection();
      if (name === "settings") loadSettingsSection();
    }

    // Browser back/forward or a manual hash edit re-syncs the visible section.
    window.addEventListener("hashchange", function() {
      showSection(sectionFromHash());
    });

    document.querySelectorAll(".rail-btn").forEach(function(b) {
      b.addEventListener("click", function() { showSection(b.dataset.section); });
    });

    var railToggle = $("rail-toggle");
    var railScrim = $("rail-scrim");
    if (railToggle) {
      railToggle.addEventListener("click", function() {
        var rail = $("rail");
        if (!rail) return;
        var open = rail.classList.toggle("rail-open");
        if (railScrim) railScrim.hidden = !open;
      });
    }
    if (railScrim) {
      railScrim.addEventListener("click", function() {
        var rail = $("rail");
        if (rail) rail.classList.remove("rail-open");
        railScrim.hidden = true;
      });
    }

    // --- Home section ---
    function renderUsageTable(sessions, wrapId) {
      var usageWrap = $(wrapId || "home-usage-wrap");
      if (!usageWrap) return;
      if (!sessions || sessions.length === 0) {
        usageWrap.innerHTML = '<div class="usage-loading">No active sessions found.</div>';
        return;
      }
      var maxCost = sessions.reduce(function(m, s) { return Math.max(m, s.estimatedCostUsd || 0); }, 0);
      var rows = sessions.map(function(s) {
        var barPct = maxCost > 0 ? Math.round(((s.estimatedCostUsd || 0) / maxCost) * 100) : 0;
        var channelIcon = s.channel === "discord" ? "🎮" : s.channel === "web" ? "🌐" : "❓";
        return "<tr>" +
          "<td class='usage-td usage-td-label'>" + channelIcon + " " + esc(s.label) + "</td>" +
          "<td class='usage-td usage-td-num'>" + fmtTokens(s.inputTokens || 0) + "</td>" +
          "<td class='usage-td usage-td-num'>" + fmtTokens(s.outputTokens || 0) + "</td>" +
          "<td class='usage-td usage-td-num'>" + fmtTokens(s.cacheReadTokens || 0) + "</td>" +
          "<td class='usage-td usage-td-num'>" + (s.cacheHitPct || 0) + "%</td>" +
          "<td class='usage-td usage-td-cost'>" +
            "<div class='usage-cost-wrap'>" +
              "<div class='usage-cost-bar' style='width:" + barPct + "%'></div>" +
              "<span class='usage-cost-label'>~" + fmtCost(s.estimatedCostUsd || 0) + "</span>" +
            "</div>" +
          "</td>" +
          "<td class='usage-td usage-td-num usage-td-turns'>" + (s.turnCount || 0) + "</td>" +
          "<td class='usage-td usage-td-age'>" + fmtRelative(s.lastUsedAt) + "</td>" +
          "</tr>";
      }).join("");
      usageWrap.innerHTML =
        "<table class='usage-table'>" +
        "<thead><tr>" +
        "<th class='usage-th'>Session</th>" +
        "<th class='usage-th usage-th-num'>Input</th>" +
        "<th class='usage-th usage-th-num'>Output</th>" +
        "<th class='usage-th usage-th-num'>Cache Read</th>" +
        "<th class='usage-th usage-th-num'>Cache Hit</th>" +
        "<th class='usage-th'>Est. Cost</th>" +
        "<th class='usage-th usage-th-num'>Turns</th>" +
        "<th class='usage-th'>Last Active</th>" +
        "</tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
        "</table>";
    }

    function setCardBody(cardId, html) {
      var card = $(cardId);
      if (!card) return;
      var body = card.querySelector(".card-body");
      if (body) body.innerHTML = html;
    }

    async function loadHome() {
      try {
        var homeData = await fetch("/api/home").then(function(r) { return r.json(); });
        var usageData = await fetch("/api/usage").then(function(r) { return r.json(); });

        // Server card
        var srv = homeData.server || {};
        var daemon = srv.daemon || {};
        setCardBody("home-server",
          '<div class="card-row"><span class="card-row-label">Status</span><span class="card-row-value ' + (daemon.pid ? "ok" : "bad") + '">' + (daemon.pid ? "Running" : "Offline") + '</span></div>' +
          '<div class="card-row"><span class="card-row-label">Uptime</span><span class="card-row-value">' + esc(fmtDur(daemon.uptimeMs)) + '</span></div>' +
          '<div class="card-row"><span class="card-row-label">Model</span><span class="card-row-value">' + esc(srv.model || "—") + '</span></div>' +
          '<div class="card-row"><span class="card-row-label">Security</span><span class="card-row-value ' + (srv.security && srv.security.level === "unrestricted" ? "warn" : "ok") + '">' + esc(cap(srv.security && srv.security.level || "—")) + '</span></div>'
        );

        // Upcoming jobs card
        var jobs = Array.isArray(homeData.jobs) ? homeData.jobs : [];
        if (jobs.length === 0) {
          setCardBody("home-upcoming", '<div class="card-empty">No jobs configured.</div>');
        } else {
          var now = new Date();
          var jobItems = jobs.slice(0, 8).map(function(j) {
            var next = nextRunAt(j.schedule, now);
            var nextLabel = next ? fmtDur(next.getTime() - now.getTime()) : "n/a";
            return '<div class="card-list-item"><span class="card-list-name">' + esc(j.name) + '</span><span class="card-list-meta">' + esc(nextLabel) + '</span></div>';
          }).join("");
          setCardBody("home-upcoming", '<div class="card-list">' + jobItems + '</div>');
        }

        // Git sync card
        var repo = homeData.repo || {};
        var gitHtml = "";
        if (!repo.configured) {
          gitHtml = '<div class="card-row"><span class="card-row-label">Status</span><span class="card-row-value warn">Not configured</span></div>';
        } else if (!repo.cloned) {
          gitHtml = '<div class="card-row"><span class="card-row-label">Status</span><span class="card-row-value warn">Not cloned</span></div>';
        } else {
          gitHtml =
            '<div class="card-row"><span class="card-row-label">Branch</span><span class="card-row-value">' + esc(repo.branch || "main") + '</span></div>' +
            '<div class="card-row"><span class="card-row-label">Status</span><span class="card-row-value ' + (repo.dirty ? "warn" : "ok") + '">' + (repo.dirty ? "Dirty" : "Clean") + '</span></div>' +
            (repo.ahead || repo.behind ? '<div class="card-row"><span class="card-row-label">Ahead/Behind</span><span class="card-row-value">' + (repo.ahead || 0) + '↑ ' + (repo.behind || 0) + '↓</span></div>' : "") +
            '<div class="card-row"><span class="card-row-label">Last Pull</span><span class="card-row-value">' + esc(repo.lastPullAt ? fmtRelative(repo.lastPullAt) : "Never") + '</span></div>' +
            (repo.lastError ? '<div class="card-row"><span class="card-row-label">Error</span><span class="card-row-value bad">' + esc(repo.lastError) + '</span></div>' : "");
        }
        gitHtml += '<button class="card-link-btn" onclick="showSection(\'jobs\')">Open Jobs →</button>';
        setCardBody("home-git", gitHtml);

        // Recent activity card
        var logs = homeData.logs || {};
        var runs = Array.isArray(logs.runs) ? logs.runs : [];
        if (runs.length === 0) {
          setCardBody("home-recent", '<div class="card-empty">No recent activity.</div>');
        } else {
          var recentItems = runs.slice(0, 8).map(function(r) {
            var runName = r.file ? r.file.replace(/\.log$/, "").replace(/-\d{4}-\d{2}-\d{2}T[\dZ:\-\.]+$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "") : "run";
            var timeStr = r.mtime ? formatSessionTime(new Date(r.mtime).toISOString()) : "";
            var lastLine = "";
            if (Array.isArray(r.lines)) {
              for (var li = r.lines.length - 1; li >= 0; li--) {
                var ln = r.lines[li].trim();
                if (ln && !ln.startsWith("#") && !ln.startsWith("Date:") && !ln.startsWith("Session:") && !ln.startsWith("Model") && !ln.startsWith("Prompt:") && !ln.startsWith("Exit code:")) {
                  lastLine = ln.length > 60 ? ln.slice(0, 57) + "…" : ln;
                  break;
                }
              }
            }
            return '<div class="card-list-item">' +
              '<span class="card-list-name">' + esc(runName) + '</span>' +
              '<span class="card-list-meta">' + esc(timeStr) + '</span>' +
              (lastLine ? '<span class="card-list-sub">' + esc(lastLine) + '</span>' : '') +
              '</div>';
          }).join("");
          setCardBody("home-recent", '<div class="card-list">' + recentItems + '</div>');
        }

        // Usage card
        renderUsageTable(Array.isArray(usageData) ? usageData : [], "home-usage-wrap");

      } catch (err) {
        setCardBody("home-server", '<div class="card-loading">Failed to load.</div>');
      }
    }

    // --- Chats section ---
    var activeBrowseSessionId = null;
    var browseOffset = 0;
    var browseTotalCount = 0;
    var BROWSE_PAGE = 10;
    var THREAD_PAGE = 10;

    // Persistent disclosure state: Map<threadKey, boolean>
    var threadExpanded = {};
    // Per-thread page index: Map<threadKey, number>
    var threadPage = {};

    function groupSessionsIntoThreads(sessions) {
      var map = {};
      var order = [];
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        var key, label, kind;
        if (s.jobName) {
          key = "job:" + s.jobName;
          label = s.jobName;
          kind = "job";
        } else if (s.channel === "agent") {
          key = "agent:" + (s.agent || "agent");
          label = s.agent || "agent";
          kind = "agent";
        } else if (s.channel === "discord") {
          key = "discord";
          label = "Discord";
          kind = "discord";
        } else {
          key = "web";
          label = "Web";
          kind = "web";
        }
        if (!map[key]) {
          map[key] = { key: key, label: label, kind: kind, sessions: [] };
          order.push(key);
        }
        map[key].sessions.push(s);
      }
      // Sort sessions within each thread newest-first
      var threads = order.map(function(k) {
        var t = map[k];
        t.sessions.sort(function(a, b) {
          var ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
          var tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
          return tb - ta;
        });
        return t;
      });
      // Sort threads by their newest session newest-first
      threads.sort(function(a, b) {
        var ta = a.sessions[0] && a.sessions[0].lastUsedAt ? new Date(a.sessions[0].lastUsedAt).getTime() : 0;
        var tb = b.sessions[0] && b.sessions[0].lastUsedAt ? new Date(b.sessions[0].lastUsedAt).getTime() : 0;
        return tb - ta;
      });
      return threads;
    }

    function buildSessionItem(s) {
      var item = document.createElement("div");
      item.className = "session-item" + (s.id === activeBrowseSessionId ? " active" : "") + (s.closed ? " closed" : "");
      item.dataset.sid = s.id;
      var previewText = s.channel === "job" ? (s.title || "") : (s.title || s.lastMessage || s.firstMessage || "");
      var preview = previewText ? esc(previewText) : "";
      var channel = s.channel && s.channel !== "web" ? s.channel : "";
      var displayName = esc(s.title || s.agent || "global");
      item.innerHTML =
        '<div class="session-item-header">' +
          '<span class="session-agent">' + displayName + '</span>' +
          (channel ? '<span class="session-channel">' + esc(channel) + '</span>' : '') +
        '</div>' +
        (s.jobName
          ? '<div class="session-job"><button class="session-job-link" type="button" data-job="' + escAttr(s.jobName) + '" title="Open job file">🗂 ' + esc(s.jobName) + '</button></div>'
          : '') +
        (preview ? '<div class="session-preview">' + preview + '</div>' : '') +
        '<div class="session-time">' + esc(formatSessionTime(s.lastUsedAt)) + " · " + (s.turnCount || 0) + ' turns</div>' +
        '<div class="session-actions">' +
          '<button class="session-rename" data-sid="' + escAttr(s.id) + '" title="Rename">✎</button>' +
          '<button class="session-close" data-sid="' + escAttr(s.id) + '" data-closed="' + (s.closed ? '1' : '0') + '" title="' + (s.closed ? 'Reopen' : 'Close') + '">' + (s.closed ? '↺' : '×') + '</button>' +
        '</div>';
      item.addEventListener("click", function(e) {
        if (e.target.closest(".session-rename, .session-close, .session-title-input, .session-job-link")) return;
        browseSession(s.id);
      });
      var jobLink = item.querySelector(".session-job-link");
      if (jobLink) {
        jobLink.addEventListener("click", function(e) {
          e.stopPropagation();
          openJobFromSession(jobLink.dataset.job);
        });
      }
      return item;
    }

    function buildThreadEl(thread) {
      var key = thread.key;
      var sessions = thread.sessions;
      var isExpanded = threadExpanded[key] || false;
      var pageIdx = threadPage[key] || 0;
      var pageCount = Math.ceil(sessions.length / THREAD_PAGE);
      if (pageIdx >= pageCount) { pageIdx = 0; threadPage[key] = 0; }

      var threadEl = document.createElement("div");
      threadEl.className = "thread" + (isExpanded ? " expanded" : "");
      threadEl.dataset.threadKey = key;

      // Header
      var newest = sessions[0] || {};
      var newestPreview = thread.kind === "job" ? (newest.title || "") : (newest.title || newest.lastMessage || newest.firstMessage || "");
      var newestTime = newest.lastUsedAt ? formatSessionTime(newest.lastUsedAt) : "";
      var countText = sessions.length > 1 ? " · " + sessions.length : "";

      var hdr = document.createElement("div");
      hdr.className = "thread-header";

      var caretBtn = document.createElement("button");
      caretBtn.className = "thread-caret";
      caretBtn.type = "button";
      caretBtn.textContent = "▶";
      caretBtn.addEventListener("click", function(e) {
        e.stopPropagation();
        var nowExpanded = threadEl.classList.toggle("expanded");
        threadExpanded[key] = nowExpanded;
        if (!nowExpanded) {
          threadPage[key] = 0;
          rebuildThreadBody(threadEl, thread);
        }
      });

      var labelSpan = document.createElement("span");
      labelSpan.className = "thread-label";
      labelSpan.textContent = thread.label;

      var badge = document.createElement("span");
      badge.className = "thread-badge thread-badge-" + thread.kind;
      badge.textContent = thread.kind;

      var summary = document.createElement("div");
      summary.className = "thread-summary";

      var summaryRow = document.createElement("div");
      summaryRow.className = "thread-summary-row";
      var metaSpan = document.createElement("span");
      metaSpan.className = "thread-summary-meta";
      metaSpan.textContent = newestTime + (countText ? " " + countText : "");
      if (newestPreview) {
        var previewSpan = document.createElement("span");
        previewSpan.className = "thread-summary-preview";
        previewSpan.textContent = newestPreview;
        summaryRow.appendChild(previewSpan);
      }
      summaryRow.appendChild(metaSpan);
      summary.appendChild(summaryRow);

      hdr.appendChild(caretBtn);
      hdr.appendChild(labelSpan);
      hdr.appendChild(badge);
      hdr.appendChild(summary);

      // Clicking the header body (not the caret) browses the most-recent session
      hdr.addEventListener("click", function(e) {
        if (e.target === caretBtn) return;
        if (sessions[0]) browseSession(sessions[0].id);
      });

      threadEl.appendChild(hdr);

      // Body
      var body = document.createElement("div");
      body.className = "thread-body";
      threadEl.appendChild(body);

      rebuildThreadBody(threadEl, thread);

      return threadEl;
    }

    function rebuildThreadBody(threadEl, thread) {
      var key = thread.key;
      var sessions = thread.sessions;
      var pageIdx = threadPage[key] || 0;
      var pageCount = Math.ceil(sessions.length / THREAD_PAGE);
      if (pageIdx >= pageCount) { pageIdx = 0; threadPage[key] = 0; }
      var body = threadEl.querySelector(".thread-body");
      if (!body) return;
      body.innerHTML = "";

      var pageSessions = sessions.length > THREAD_PAGE
        ? sessions.slice(pageIdx * THREAD_PAGE, (pageIdx + 1) * THREAD_PAGE)
        : sessions;

      for (var i = 0; i < pageSessions.length; i++) {
        body.appendChild(buildSessionItem(pageSessions[i]));
      }

      if (sessions.length > THREAD_PAGE) {
        var pager = document.createElement("div");
        pager.className = "thread-paginator";
        var prevBtn = document.createElement("button");
        prevBtn.className = "thread-page-btn";
        prevBtn.type = "button";
        prevBtn.textContent = "‹ prev";
        prevBtn.disabled = pageIdx === 0;
        var pageInfo = document.createElement("span");
        pageInfo.className = "thread-page-info";
        pageInfo.textContent = (pageIdx + 1) + " / " + pageCount;
        var nextBtn = document.createElement("button");
        nextBtn.className = "thread-page-btn";
        nextBtn.type = "button";
        nextBtn.textContent = "next ›";
        nextBtn.disabled = pageIdx >= pageCount - 1;
        (function(k, thr, tEl) {
          prevBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            threadPage[k] = Math.max(0, (threadPage[k] || 0) - 1);
            rebuildThreadBody(tEl, thr);
          });
          nextBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            threadPage[k] = Math.min(pageCount - 1, (threadPage[k] || 0) + 1);
            rebuildThreadBody(tEl, thr);
          });
        })(key, thread, threadEl);
        pager.appendChild(prevBtn);
        pager.appendChild(pageInfo);
        pager.appendChild(nextBtn);
        body.appendChild(pager);
      }
    }

    async function loadSessions() {
      var listEl = $("session-list");
      if (!listEl) return;
      var showClosed = $("show-closed");
      var includeClosed = showClosed && showClosed.checked;
      try {
        // Always fetch the full list so the closed count is accurate even
        // when the toggle is off; filter client-side for display.
        var res = await fetch("/api/sessions?includeClosed=1");
        var allSessions = await res.json();
        if (!Array.isArray(allSessions)) allSessions = [];

        // Count closed from the full list and update the toggle label.
        var closedCount = allSessions.filter(function(s) { return s.closed; }).length;
        if (showClosed) {
          showClosed.parentElement.title = "Show closed (" + closedCount + ")";
          var showClosedText = showClosed.parentElement.lastChild;
          if (showClosedText && showClosedText.nodeType === 3) {
            showClosedText.textContent = " Show closed (" + closedCount + ")";
          }
        }

        var sessions = includeClosed
          ? allSessions
          : allSessions.filter(function(s) { return !s.closed; });

        if (sessions.length === 0) {
          listEl.innerHTML = '<div class="session-loading">No sessions yet</div>';
          return;
        }

        // Pre-expand the thread containing the active session
        if (activeBrowseSessionId) {
          for (var pi = 0; pi < sessions.length; pi++) {
            var ps = sessions[pi];
            if (ps.id === activeBrowseSessionId) {
              var pKey;
              if (ps.jobName) pKey = "job:" + ps.jobName;
              else if (ps.channel === "agent") pKey = "agent:" + (ps.agent || "agent");
              else if (ps.channel === "discord") pKey = "discord";
              else pKey = "web";
              if (!(pKey in threadExpanded)) threadExpanded[pKey] = true;
              break;
            }
          }
        }

        var threads = groupSessionsIntoThreads(sessions);

        listEl.innerHTML = "";
        for (var ti = 0; ti < threads.length; ti++) {
          listEl.appendChild(buildThreadEl(threads[ti]));
        }
      } catch (e) {
        listEl.innerHTML = '<div class="session-loading">Failed to load</div>';
      }
    }

    // Session rename/close delegation
    var sessionListEl = $("session-list");
    if (sessionListEl) {
      sessionListEl.addEventListener("click", async function(event) {
        var target = event.target;
        if (!(target instanceof HTMLElement)) return;

        var renameBtn = target.closest(".session-rename");
        if (renameBtn && renameBtn instanceof HTMLElement) {
          event.stopPropagation();
          var sid = renameBtn.dataset.sid;
          var item = renameBtn.closest(".session-item");
          if (!item) return;
          var agentEl = item.querySelector(".session-agent");
          if (!agentEl) return;
          var currentTitle = agentEl.textContent || "";
          var input = document.createElement("input");
          input.className = "session-title-input";
          input.value = currentTitle;
          agentEl.replaceWith(input);
          input.focus();
          input.select();
          var saving = false;
          async function saveTitle() {
            if (saving) return;
            saving = true;
            var newTitle = input.value.trim();
            try {
              await fetch("/api/sessions/" + encodeURIComponent(sid) + "/title", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: newTitle })
              });
            } catch (e) {}
            loadSessions();
          }
          input.addEventListener("keydown", function(e) {
            if (e.key === "Enter") { e.preventDefault(); saveTitle(); }
            if (e.key === "Escape") { loadSessions(); }
          });
          input.addEventListener("blur", saveTitle);
          return;
        }

        var closeBtn = target.closest(".session-close");
        if (closeBtn && closeBtn instanceof HTMLElement) {
          event.stopPropagation();
          var sid2 = closeBtn.dataset.sid;
          var isClosed = closeBtn.dataset.closed === "1";
          var action = isClosed ? "reopen" : "close";
          try {
            await fetch("/api/sessions/" + encodeURIComponent(sid2) + "/" + action, { method: "POST" });
          } catch (e) {}
          loadSessions();
          return;
        }
      });
    }

    var showClosedEl = $("show-closed");
    if (showClosedEl) {
      showClosedEl.addEventListener("change", function() { loadSessions(); });
    }

    async function browseSession(sessionId) {
      activeBrowseSessionId = sessionId;
      browseOffset = 0;
      browseTotalCount = 0;
      loadSessions();
      var banner = $("chat-history-banner");
      if (banner) banner.hidden = false;
      chatHistory = [];
      renderChatHistory();
      await loadBrowseMessages(sessionId, false);
      // On mobile, show chat pane
      var chatsSection = $("section-chats");
      if (chatsSection && window.innerWidth <= 760) {
        chatsSection.classList.add("section-chats-detail");
        var backBtn = $("chat-back");
        if (backBtn) backBtn.hidden = false;
      }
    }

    async function loadBrowseMessages(sessionId, loadMore) {
      var loadMoreContainer = $("load-more-container");
      var loadMoreBtn = $("load-more-btn");
      if (!loadMore) {
        try {
          var res = await fetch("/api/sessions/" + sessionId + "/messages?limit=" + BROWSE_PAGE + "&offset=-1");
          var data = await res.json();
          var msgs = data.messages;
          if (!Array.isArray(msgs)) return;
          browseTotalCount = typeof data.total === "number" ? data.total : msgs.length;
          browseOffset = Math.max(0, browseTotalCount - BROWSE_PAGE);
          chatHistory = msgs.map(function(m) { return { role: m.role, text: m.text, timestamp: m.timestamp || null }; });
          renderChatHistory();
          if (loadMoreContainer) loadMoreContainer.hidden = browseOffset <= 0;
          if (loadMoreBtn && browseOffset > 0) loadMoreBtn.textContent = "Load older (" + browseOffset + " more)";
        } catch (e) {}
      } else {
        var newOffset = Math.max(0, browseOffset - BROWSE_PAGE);
        var limit = browseOffset - newOffset;
        if (limit <= 0) return;
        try {
          var res2 = await fetch("/api/sessions/" + sessionId + "/messages?limit=" + limit + "&offset=" + newOffset);
          var data2 = await res2.json();
          var older = data2.messages;
          if (!Array.isArray(older)) return;
          var chatMsgsEl = $("chat-messages");
          var scrollHeightBefore = chatMsgsEl ? chatMsgsEl.scrollHeight : 0;
          chatHistory = older.map(function(m) { return { role: m.role, text: m.text, timestamp: m.timestamp || null }; }).concat(chatHistory);
          browseOffset = newOffset;
          renderChatHistory();
          if (chatMsgsEl) chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight - scrollHeightBefore;
          if (loadMoreContainer) loadMoreContainer.hidden = browseOffset <= 0;
          if (loadMoreBtn && browseOffset > 0) loadMoreBtn.textContent = "Load older (" + browseOffset + " more)";
        } catch (e) {}
      }
    }

    var newSessionBtn = $("new-session-btn");
    if (newSessionBtn) {
      newSessionBtn.addEventListener("click", function() {
        activeBrowseSessionId = null;
        chatHistory = [];
        renderChatHistory();
        var banner = $("chat-history-banner");
        if (banner) banner.hidden = true;
        var loadMoreContainer = $("load-more-container");
        if (loadMoreContainer) loadMoreContainer.hidden = true;
        document.querySelectorAll(".session-item").forEach(function(el) { el.classList.remove("active"); });
        var chatInput2 = $("chat-input");
        if (chatInput2) chatInput2.focus();
      });
    }

    var loadMoreBtn = $("load-more-btn");
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", function() {
        if (activeBrowseSessionId) loadBrowseMessages(activeBrowseSessionId, true);
      });
    }

    var chatBackBtn = $("chat-back");
    if (chatBackBtn) {
      chatBackBtn.addEventListener("click", function() {
        var chatsSection = $("section-chats");
        if (chatsSection) chatsSection.classList.remove("section-chats-detail");
        chatBackBtn.hidden = true;
      });
    }

    // --- Jobs section ---
    var currentJobFile = null;
    var jobEditorDirty = false;

    async function loadJobsSection() {
      await Promise.all([loadJobFiles(), loadJobsRepoStatus()]);
    }

    // Jump from a job's chat session to its job file in the Jobs editor.
    function openJobFromSession(jobName) {
      if (!jobName) return;
      showSection("jobs");
      loadJobFile(jobName + ".md");
    }

    async function loadJobFiles() {
      var listEl = $("job-file-list");
      if (!listEl) return;
      try {
        var files = await fetch("/api/jobs/files").then(function(r) { return r.json(); });
        if (!Array.isArray(files) || files.length === 0) {
          listEl.innerHTML = '<div class="job-file-empty">No job files yet. Click + New to create one.</div>';
          return;
        }
        listEl.innerHTML = files.map(function(f) {
          var isActive = f.path === currentJobFile;
          return '<div class="job-file-item' + (isActive ? ' active' : '') + '" data-path="' + escAttr(f.path) + '">' +
            (f.isJob ? '<span class="job-file-is-job">job</span>' : '') +
            esc(f.path) +
            '</div>';
        }).join("");
        listEl.querySelectorAll(".job-file-item").forEach(function(item) {
          item.addEventListener("click", function() {
            loadJobFile(item.dataset.path);
          });
        });
      } catch (e) {
        listEl.innerHTML = '<div class="job-file-empty">Failed to load files.</div>';
      }
    }

    async function loadJobFile(path) {
      if (jobEditorDirty && currentJobFile) {
        if (!confirm("Discard unsaved changes?")) return;
      }
      var editor = $("job-editor");
      var currentFileEl = $("jobs-current-file");
      var deleteBtn = $("jobs-delete-btn");
      var saveBtn = $("jobs-save-btn");
      if (!editor) return;
      currentJobFile = path;
      jobEditorDirty = false;
      updateJobsDirtyIndicator();
      if (currentFileEl) currentFileEl.textContent = path;
      editor.disabled = true;
      if (deleteBtn) deleteBtn.disabled = false;
      if (saveBtn) saveBtn.disabled = true;
      try {
        var data = await fetch("/api/jobs/file?path=" + encodeURIComponent(path)).then(function(r) { return r.json(); });
        if (data && data.error) throw new Error(data.error);
        editor.value = data.content || "";
        editor.disabled = false;
        if (saveBtn) saveBtn.disabled = false;
      } catch (e) {
        editor.value = "";
        editor.disabled = true;
        setJobsStatus("Failed to load file: " + String(e instanceof Error ? e.message : e));
      }
      // Update active class
      document.querySelectorAll(".job-file-item").forEach(function(el) {
        el.classList.toggle("active", el.dataset.path === path);
      });
      // On mobile, show editor pane
      var jobsSection = $("section-jobs");
      if (jobsSection && window.innerWidth <= 760) {
        jobsSection.classList.add("section-jobs-detail");
        var backBtn = $("jobs-back-btn");
        if (backBtn) backBtn.hidden = false;
      }
    }

    async function loadJobsRepoStatus() {
      var statusEl = $("jobs-repo-status");
      if (!statusEl) return;
      try {
        var repo = await fetch("/api/jobs/repo/status").then(function(r) { return r.json(); });
        var syncBtn = $("jobs-sync-btn");
        if (!repo.configured) {
          statusEl.textContent = "No git repo configured";
          if (syncBtn) { syncBtn.disabled = true; syncBtn.title = "Configure jobsRepo in Settings to enable"; }
        } else if (!repo.cloned) {
          statusEl.textContent = "Git repo not yet cloned";
          if (syncBtn) syncBtn.disabled = false;
        } else {
          var parts = ["Branch: " + (repo.branch || "main")];
          if (repo.dirty) parts.push("● dirty");
          else parts.push("✓ clean");
          if (repo.ahead) parts.push(repo.ahead + "↑");
          if (repo.behind) parts.push(repo.behind + "↓");
          if (repo.lastPullAt) parts.push("pulled " + fmtRelative(repo.lastPullAt));
          statusEl.textContent = parts.join(" · ");
          if (syncBtn) syncBtn.disabled = false;
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = "Repo status unavailable";
      }
    }

    function updateJobsDirtyIndicator() {
      var dirtyEl = $("jobs-dirty");
      if (dirtyEl) dirtyEl.hidden = !jobEditorDirty;
    }

    function setJobsStatus(msg) {
      var statusEl = $("jobs-status");
      if (statusEl) statusEl.textContent = msg;
    }

    var jobEditor = $("job-editor");
    if (jobEditor) {
      jobEditor.addEventListener("input", function() {
        jobEditorDirty = true;
        updateJobsDirtyIndicator();
      });
      // Tab key inserts spaces
      jobEditor.addEventListener("keydown", function(e) {
        if (e.key === "Tab") {
          e.preventDefault();
          var start = jobEditor.selectionStart;
          var end = jobEditor.selectionEnd;
          jobEditor.value = jobEditor.value.substring(0, start) + "  " + jobEditor.value.substring(end);
          jobEditor.selectionStart = jobEditor.selectionEnd = start + 2;
          jobEditorDirty = true;
          updateJobsDirtyIndicator();
        }
      });
    }

    var jobsSaveBtn = $("jobs-save-btn");
    if (jobsSaveBtn) {
      jobsSaveBtn.addEventListener("click", async function() {
        if (!currentJobFile || !jobEditor) return;
        jobsSaveBtn.disabled = true;
        setJobsStatus("Saving…");
        try {
          var res = await fetch("/api/jobs/file", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: currentJobFile, content: jobEditor.value })
          });
          var out = await res.json();
          if (!out.ok) throw new Error(out.error || "save failed");
          jobEditorDirty = false;
          updateJobsDirtyIndicator();
          setJobsStatus("Saved.");
          await loadJobFiles();
        } catch (e) {
          setJobsStatus("Failed: " + String(e instanceof Error ? e.message : e));
        } finally {
          jobsSaveBtn.disabled = false;
        }
      });
    }

    var jobsNewBtn = $("jobs-new-btn");
    if (jobsNewBtn) {
      jobsNewBtn.addEventListener("click", async function() {
        var name = prompt("New job file name (e.g. daily.md):");
        if (!name) return;
        name = name.trim();
        if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
          alert("Invalid filename. Use only letters, numbers, dots, hyphens, underscores, slashes.");
          return;
        }
        if (!name.endsWith(".md")) name = name + ".md";
        try {
          var res = await fetch("/api/jobs/file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: name })
          });
          var out = await res.json();
          if (!out.ok) throw new Error(out.error || "create failed");
          await loadJobFiles();
          await loadJobFile(name);
        } catch (e) {
          setJobsStatus("Failed: " + String(e instanceof Error ? e.message : e));
        }
      });
    }

    var jobsDeleteBtn = $("jobs-delete-btn");
    if (jobsDeleteBtn) {
      jobsDeleteBtn.addEventListener("click", async function() {
        if (!currentJobFile) return;
        if (!confirm("Delete " + currentJobFile + "? This cannot be undone.")) return;
        try {
          var res = await fetch("/api/jobs/file?path=" + encodeURIComponent(currentJobFile), { method: "DELETE" });
          var out = await res.json();
          if (!out.ok) throw new Error(out.error || "delete failed");
          currentJobFile = null;
          jobEditorDirty = false;
          updateJobsDirtyIndicator();
          var editor2 = $("job-editor");
          if (editor2) { editor2.value = ""; editor2.disabled = true; }
          var currentFileEl2 = $("jobs-current-file");
          if (currentFileEl2) currentFileEl2.textContent = "No file selected";
          if (jobsDeleteBtn) jobsDeleteBtn.disabled = true;
          var saveBtn2 = $("jobs-save-btn");
          if (saveBtn2) saveBtn2.disabled = true;
          setJobsStatus("Deleted.");
          await loadJobFiles();
        } catch (e) {
          setJobsStatus("Failed: " + String(e instanceof Error ? e.message : e));
        }
      });
    }

    var jobsSyncBtn = $("jobs-sync-btn");
    if (jobsSyncBtn) {
      jobsSyncBtn.addEventListener("click", async function() {
        jobsSyncBtn.disabled = true;
        setJobsStatus("Syncing to git…");
        try {
          var res = await fetch("/api/jobs/repo/sync", { method: "POST" });
          var out = await res.json();
          if (out.ok) {
            setJobsStatus(out.committed ? "Committed and pushed." : "Nothing to commit — pushed.");
          } else {
            setJobsStatus("Sync failed: " + (out.error || "unknown error"));
          }
          await loadJobsRepoStatus();
        } catch (e) {
          setJobsStatus("Failed: " + String(e instanceof Error ? e.message : e));
        } finally {
          jobsSyncBtn.disabled = false;
        }
      });
    }

    var jobsBackBtn = $("jobs-back-btn");
    if (jobsBackBtn) {
      jobsBackBtn.addEventListener("click", function() {
        var jobsSection = $("section-jobs");
        if (jobsSection) jobsSection.classList.remove("section-jobs-detail");
        jobsBackBtn.hidden = true;
      });
    }

    // --- Settings section ---
    var settingsDirty = false;

    async function loadSettingsSection() {
      try {
        var state = await fetch("/api/state").then(function(r) { return r.json(); });
        var hb = await fetch("/api/settings/heartbeat").then(function(r) { return r.json(); });

        // Model
        var modelInput = $("s-model");
        var fallbackInput = $("s-fallback-model");
        if (modelInput) modelInput.value = state.model || "";
        if (fallbackInput) fallbackInput.value = (state.fallback && state.fallback.model) || "";

        // Heartbeat
        var hbEnabled = $("s-hb-enabled");
        var hbInterval = $("s-hb-interval");
        var hbPrompt = $("s-hb-prompt");
        var hbData = hb.heartbeat || {};
        if (hbEnabled) hbEnabled.checked = Boolean(hbData.enabled);
        if (hbInterval) hbInterval.value = String(Number(hbData.interval) || 15);
        if (hbPrompt) hbPrompt.value = typeof hbData.prompt === "string" ? hbData.prompt : "";

        // Security
        var securitySelect = $("s-security");
        if (securitySelect && state.security) securitySelect.value = state.security.level || "moderate";

        // Clock
        var clockFormat = $("s-clock-format");
        if (clockFormat) clockFormat.value = use12Hour ? "12" : "24";

        // Timezone
        var tzSelect = $("s-timezone");
        if (tzSelect && state.timezone) {
          var tz = String(state.timezone);
          // Add the timezone as an option if it's not already in the list
          var tzExists = false;
          for (var ti = 0; ti < tzSelect.options.length; ti++) {
            if (tzSelect.options[ti].value === tz) { tzExists = true; break; }
          }
          if (!tzExists) {
            var opt = document.createElement("option");
            opt.value = tz;
            opt.textContent = tz;
            tzSelect.insertBefore(opt, tzSelect.firstChild);
          }
          tzSelect.value = tz;
          clockTimezone = tz;
        }

        // Jobs repo
        var repoUrl = $("s-repo-url");
        var repoBranch = $("s-repo-branch");
        var repoInterval = $("s-repo-interval");
        var jr = state.jobsRepo || {};
        if (repoUrl) repoUrl.value = jr.url || "";
        if (repoBranch) repoBranch.value = jr.branch || "main";
        if (repoInterval) repoInterval.value = String(jr.intervalSeconds != null ? jr.intervalSeconds : 300);

        // Track changes
        heartbeatTimezoneOffsetMinutes = clampTimezoneOffsetMinutes(state.timezoneOffsetMinutes);
        settingsDirty = false;
        var saveBtn3 = $("settings-save-btn");
        if (saveBtn3) saveBtn3.disabled = true;
        var statusEl2 = $("settings-section-status");
        if (statusEl2) statusEl2.textContent = "";
      } catch (e) {
        var statusEl3 = $("settings-section-status");
        if (statusEl3) statusEl3.textContent = "Failed to load settings.";
      }
    }

    function markSettingsDirty() {
      settingsDirty = true;
      var saveBtn4 = $("settings-save-btn");
      if (saveBtn4) saveBtn4.disabled = false;
    }

    ["s-model","s-fallback-model","s-hb-enabled","s-hb-interval","s-hb-prompt","s-security","s-clock-format","s-timezone","s-repo-url","s-repo-branch","s-repo-interval"].forEach(function(id) {
      var el = $(id);
      if (el) {
        el.addEventListener("change", markSettingsDirty);
        el.addEventListener("input", markSettingsDirty);
      }
    });

    var settingsSaveBtn = $("settings-save-btn");
    if (settingsSaveBtn) {
      settingsSaveBtn.addEventListener("click", async function() {
        settingsSaveBtn.disabled = true;
        var statusEl4 = $("settings-section-status");
        if (statusEl4) statusEl4.textContent = "Saving…";

        // Clock format is local only
        var clockFormatEl = $("s-clock-format");
        if (clockFormatEl) {
          use12Hour = clockFormatEl.value === "12";
          localStorage.setItem("clock.format", use12Hour ? "12" : "24");
        }

        // Timezone — update local cache immediately
        var tzSaveEl = $("s-timezone");
        if (tzSaveEl && tzSaveEl.value) {
          clockTimezone = tzSaveEl.value;
        }

        // Heartbeat
        var hbEnabled2 = $("s-hb-enabled");
        var hbInterval2 = $("s-hb-interval");
        var hbPrompt2 = $("s-hb-prompt");
        if (hbEnabled2 && hbInterval2 && hbPrompt2) {
          try {
            await fetch("/api/settings/heartbeat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                enabled: hbEnabled2.checked,
                interval: Number(hbInterval2.value) || 15,
                prompt: hbPrompt2.value
              })
            });
          } catch (e) {}
        }

        // Other settings via PUT /api/settings
        var modelEl = $("s-model");
        var fallbackEl = $("s-fallback-model");
        var securityEl = $("s-security");
        var repoUrlEl = $("s-repo-url");
        var repoBranchEl = $("s-repo-branch");
        var repoIntervalEl = $("s-repo-interval");
        var tzPayloadEl = $("s-timezone");

        var payload = {
          model: modelEl ? modelEl.value.trim() : undefined,
          fallback: fallbackEl ? { model: fallbackEl.value.trim() } : undefined,
          security: securityEl ? { level: securityEl.value } : undefined,
          timezone: tzPayloadEl ? tzPayloadEl.value : undefined,
          jobsRepo: {
            url: repoUrlEl ? repoUrlEl.value.trim() : undefined,
            branch: repoBranchEl ? (repoBranchEl.value.trim() || "main") : undefined,
            intervalSeconds: repoIntervalEl ? (Number(repoIntervalEl.value) || 300) : undefined
          }
        };

        try {
          var res = await fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          var out = await res.json();
          if (!out.ok) throw new Error(out.error || "save failed");
          if (statusEl4) statusEl4.textContent = "Saved.";
          settingsDirty = false;
        } catch (e) {
          if (statusEl4) statusEl4.textContent = "Partial save (heartbeat may be updated). Error: " + String(e instanceof Error ? e.message : e);
          settingsSaveBtn.disabled = false;
          return;
        }

        setTimeout(function() {
          if (statusEl4) statusEl4.textContent = "";
        }, 2000);
      });
    }

    // ── Chat engine (preserved from original) ──
    var chatMessages = $("chat-messages");
    var chatForm = $("chat-form");
    var chatInput = $("chat-input");
    var chatSend = $("chat-send");
    var chatAttachBtn = $("chat-attach");
    var chatFileInput = $("chat-file-input");
    var chatAttachmentsEl = $("chat-attachments");

    var pendingAttachments = [];

    function renderAttachmentChips() {
      if (!chatAttachmentsEl) return;
      if (pendingAttachments.length === 0) {
        chatAttachmentsEl.hidden = true;
        chatAttachmentsEl.innerHTML = "";
        return;
      }
      chatAttachmentsEl.hidden = false;
      chatAttachmentsEl.innerHTML = pendingAttachments.map(function(att, idx) {
        return (
          '<span class="attach-chip">' +
            '<span class="attach-chip-name" title="' + escAttr(att.name) + '">' + esc(att.name) + '</span>' +
            '<button class="attach-chip-remove" type="button" data-attach-index="' + idx + '" aria-label="Remove ' + escAttr(att.name) + '">×</button>' +
          '</span>'
        );
      }).join("");
    }

    function readFileAsBase64(file) {
      return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onload = function(e) {
          var result = e.target.result;
          var base64 = typeof result === "string" ? result.split(",")[1] || "" : "";
          resolve(base64);
        };
        reader.onerror = function() { reject(new Error("Failed to read file")); };
        reader.readAsDataURL(file);
      });
    }

    if (chatAttachBtn && chatFileInput) {
      chatAttachBtn.addEventListener("click", function() {
        if (chatBusy) return;
        chatFileInput.click();
      });
    }

    if (chatFileInput) {
      chatFileInput.addEventListener("change", async function() {
        var files = chatFileInput.files;
        if (!files || !files.length) return;
        var warnEl = $("chat-attach-warn");
        if (warnEl) warnEl.remove();
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (pendingAttachments.length >= 5) {
            var warn = document.createElement("div");
            warn.id = "chat-attach-warn";
            warn.className = "attach-warn";
            warn.textContent = "Max 5 attachments allowed.";
            if (chatAttachmentsEl && chatAttachmentsEl.parentNode) {
              chatAttachmentsEl.parentNode.insertBefore(warn, chatAttachmentsEl.nextSibling);
            }
            break;
          }
          if (file.size > 10 * 1024 * 1024) {
            var warnSize = document.createElement("div");
            warnSize.id = "chat-attach-warn";
            warnSize.className = "attach-warn";
            warnSize.textContent = '"' + file.name + '" exceeds 10 MB limit.';
            if (chatAttachmentsEl && chatAttachmentsEl.parentNode) {
              chatAttachmentsEl.parentNode.insertBefore(warnSize, chatAttachmentsEl.nextSibling);
            }
            continue;
          }
          try {
            var base64 = await readFileAsBase64(file);
            pendingAttachments.push({ name: file.name, type: file.type || "application/octet-stream", data: base64 });
          } catch (_) {}
        }
        chatFileInput.value = "";
        renderAttachmentChips();
      });
    }

    if (chatAttachmentsEl) {
      chatAttachmentsEl.addEventListener("click", function(event) {
        var target = event.target;
        if (!(target instanceof HTMLElement)) return;
        var btn = target.closest("[data-attach-index]");
        if (!btn || !(btn instanceof HTMLElement)) return;
        var idx = parseInt(btn.getAttribute("data-attach-index") || "-1", 10);
        if (idx >= 0 && idx < pendingAttachments.length) {
          pendingAttachments.splice(idx, 1);
          renderAttachmentChips();
        }
      });
    }

    var CHAT_STORAGE_KEY = "claudeclaw.chat.history";
    var chatBusy = false;
    var chatAbortController = null;
    var chatElapsedTimer = null;
    var chatStartedAt = 0;
    var chatHistory = (function() {
      try {
        var saved = localStorage.getItem(CHAT_STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
      } catch (_) { return []; }
    })();

    function saveChatHistory() {
      try {
        var toSave = chatHistory.filter(function(m) { return !m.streaming && m.agentStatus !== "running"; });
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(toSave));
      } catch (_) {}
    }

    function fmtElapsed(ms) {
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + "s";
      return Math.floor(s / 60) + "m " + (s % 60) + "s";
    }

    function setChatBusy(busy) {
      chatBusy = busy;
      var cancelBtn = $("chat-cancel");
      if (chatSend) chatSend.disabled = busy;
      if (cancelBtn) cancelBtn.hidden = !busy;
      if (chatAttachBtn) chatAttachBtn.disabled = busy;
      if (busy) {
        chatStartedAt = Date.now();
        chatElapsedTimer = setInterval(function() {
          var el = document.querySelector(".chat-msg-elapsed");
          if (el) el.textContent = fmtElapsed(Date.now() - chatStartedAt);
        }, 1000);
      } else {
        if (chatElapsedTimer) { clearInterval(chatElapsedTimer); chatElapsedTimer = null; }
        chatAbortController = null;
      }
    }

    function cancelChat() {
      if (chatAbortController) chatAbortController.abort();
    }

    function createChatEmptyState() {
      var empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = "Send a message to start chatting with the daemon.";
      return empty;
    }

    function createChatMessageEl() {
      var msgEl2 = document.createElement("div");
      var roleEl = document.createElement("div");
      roleEl.className = "chat-msg-role";
      var textEl = document.createElement("div");
      textEl.className = "chat-msg-text";
      var timeEl = document.createElement("div");
      timeEl.className = "chat-msg-time";
      msgEl2.appendChild(roleEl);
      msgEl2.appendChild(textEl);
      msgEl2.appendChild(timeEl);
      return msgEl2;
    }

    function syncChatMessageEl(msgEl3, msg, elapsedMs) {
      if (msg.role === "agent") {
        var agentCls = "chat-msg chat-msg-agent" + (msg.agentStatus === "running" ? " chat-msg-agent-running" : " chat-msg-agent-done");
        if (msgEl3.className !== agentCls) msgEl3.className = agentCls;
        var agentPlainText = msg.text || "";
        if (msgEl3.dataset.agentText !== agentPlainText || msgEl3.dataset.agentStatus !== msg.agentStatus) {
          msgEl3.textContent = agentPlainText;
          msgEl3.dataset.agentText = agentPlainText;
          msgEl3.dataset.agentStatus = msg.agentStatus || "";
          if (msg.agentStatus === "running") {
            var spinner = document.createElement("span");
            spinner.className = "chat-agent-spinner";
            spinner.textContent = "…";
            msgEl3.appendChild(spinner);
          }
        }
        return;
      }

      var roleEl2 = msgEl3.querySelector(".chat-msg-role");
      var textEl2 = msgEl3.querySelector(".chat-msg-text");
      var timeEl2 = msgEl3.querySelector(".chat-msg-time");
      if (!roleEl2 || !textEl2) {
        msgEl3.textContent = "";
        roleEl2 = document.createElement("div");
        roleEl2.className = "chat-msg-role";
        textEl2 = document.createElement("div");
        textEl2.className = "chat-msg-text";
        timeEl2 = document.createElement("div");
        timeEl2.className = "chat-msg-time";
        msgEl3.appendChild(roleEl2);
        msgEl3.appendChild(textEl2);
        msgEl3.appendChild(timeEl2);
      }
      if (!timeEl2) {
        timeEl2 = document.createElement("div");
        timeEl2.className = "chat-msg-time";
        msgEl3.appendChild(timeEl2);
      }
      var cls2 = "chat-msg " + (msg.role === "user" ? "chat-msg-user" : "chat-msg-assistant");
      if (msg.streaming) cls2 += " chat-msg-streaming";
      msgEl3.className = cls2;
      roleEl2.textContent = msg.role === "user" ? "You" : "Claude";
      textEl2.textContent = msg.text || "";
      var msgTimestamp = msg.timestamp || null;
      timeEl2.textContent = msgTimestamp ? formatClockTime(msgTimestamp) : "";

      var metaEl = msgEl3.querySelector(".chat-msg-elapsed, .chat-msg-background");
      if (msg.streaming && chatBusy) {
        if (!metaEl || !metaEl.classList.contains("chat-msg-elapsed")) {
          if (metaEl) metaEl.remove();
          metaEl = document.createElement("div");
          metaEl.className = "chat-msg-elapsed";
          msgEl3.appendChild(metaEl);
        }
        metaEl.textContent = fmtElapsed(elapsedMs);
      } else if (msg.background) {
        if (!metaEl || !metaEl.classList.contains("chat-msg-background")) {
          if (metaEl) metaEl.remove();
          metaEl = document.createElement("div");
          metaEl.className = "chat-msg-background";
          msgEl3.appendChild(metaEl);
        }
        metaEl.textContent = "⚙ working in background...";
      } else if (metaEl) {
        metaEl.remove();
      }
    }

    function renderChatHistory() {
      if (!chatMessages) return;
      if (!chatHistory.length) {
        if (
          chatMessages.children.length !== 1 ||
          !chatMessages.firstElementChild ||
          !chatMessages.firstElementChild.classList.contains("chat-empty")
        ) {
          chatMessages.textContent = "";
          chatMessages.appendChild(createChatEmptyState());
        }
        return;
      }
      if (chatMessages.firstElementChild && chatMessages.firstElementChild.classList.contains("chat-empty")) {
        chatMessages.textContent = "";
      }
      var elapsedMs2 = Date.now() - chatStartedAt;
      for (var i2 = 0; i2 < chatHistory.length; i2++) {
        var msgEl4 = chatMessages.children[i2];
        if (!msgEl4 || !msgEl4.classList.contains("chat-msg")) {
          msgEl4 = createChatMessageEl();
          if (i2 >= chatMessages.children.length) {
            chatMessages.appendChild(msgEl4);
          } else {
            chatMessages.insertBefore(msgEl4, chatMessages.children[i2]);
          }
        }
        syncChatMessageEl(msgEl4, chatHistory[i2], elapsedMs2);
      }
      while (chatMessages.children.length > chatHistory.length) {
        chatMessages.removeChild(chatMessages.lastElementChild);
      }
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function autoResizeChatInput() {
      if (!chatInput) return;
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
    }

    async function sendChat() {
      if (chatBusy || !chatInput) return;
      var message = (chatInput.value || "").trim();
      var attachmentsToSend = pendingAttachments.slice();
      if (!message && attachmentsToSend.length === 0) return;
      chatInput.value = "";
      autoResizeChatInput();
      pendingAttachments = [];
      renderAttachmentChips();
      setChatBusy(true);
      var userText = message || ("(" + attachmentsToSend.length + " attachment" + (attachmentsToSend.length !== 1 ? "s" : "") + ")");
      chatHistory.push({ role: "user", text: userText, timestamp: new Date().toISOString() });
      var assistantIdx = chatHistory.length;
      chatHistory.push({ role: "assistant", text: "", streaming: true, timestamp: new Date().toISOString() });
      renderChatHistory();
      chatAbortController = new AbortController();
      try {
        var res3 = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: message, attachments: attachmentsToSend }),
          signal: chatAbortController.signal
        });
        if (!res3.body) throw new Error("No response body");
        var reader = res3.body.getReader();
        var dec = new TextDecoder();
        var buf = "";
        while (true) {
          var read = await reader.read();
          if (read.done) break;
          buf += dec.decode(read.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop() || "";
          for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            if (!line.startsWith("data: ")) continue;
            try {
              var ev = JSON.parse(line.slice(6));
              if (ev.type === "chunk") {
                chatHistory[assistantIdx].text += ev.text;
                renderChatHistory();
              } else if (ev.type === "unblock") {
                setChatBusy(false);
                chatHistory[assistantIdx].background = true;
                renderChatHistory();
              } else if (ev.type === "agent_spawn") {
                chatHistory.push({ role: "agent", agentId: ev.id, text: "🤖 Sub-agent started: " + ev.description, agentStatus: "running" });
                renderChatHistory();
              } else if (ev.type === "agent_done") {
                var agentBubble = null;
                for (var k2 = chatHistory.length - 1; k2 >= 0; k2--) {
                  if (chatHistory[k2].role === "agent" && chatHistory[k2].agentId === ev.id) {
                    agentBubble = chatHistory[k2];
                    break;
                  }
                }
                if (agentBubble) {
                  agentBubble.agentStatus = "done";
                  agentBubble.text = "✅ Sub-agent done: " + ev.description;
                } else {
                  chatHistory.push({ role: "agent", agentId: ev.id, text: "✅ Sub-agent done: " + ev.description, agentStatus: "done" });
                }
                renderChatHistory();
                saveChatHistory();
              } else if (ev.type === "done") {
                chatHistory[assistantIdx].streaming = false;
                chatHistory[assistantIdx].background = false;
                renderChatHistory();
                saveChatHistory();
              } else if (ev.type === "error") {
                chatHistory[assistantIdx].text = chatHistory[assistantIdx].text
                  ? chatHistory[assistantIdx].text + "\n\n[Error: " + ev.message + "]"
                  : "[Error: " + ev.message + "]";
                chatHistory[assistantIdx].streaming = false;
                chatHistory[assistantIdx].background = false;
                renderChatHistory();
                saveChatHistory();
              }
            } catch (_) {}
          }
        }
        chatHistory[assistantIdx].streaming = false;
        renderChatHistory();
        saveChatHistory();
      } catch (err) {
        var cancelled = err && err.name === "AbortError";
        chatHistory[assistantIdx].text = cancelled
          ? (chatHistory[assistantIdx].text || "[Cancelled]")
          : "[Failed: " + String(err) + "]";
        chatHistory[assistantIdx].streaming = false;
        renderChatHistory();
        saveChatHistory();
      } finally {
        setChatBusy(false);
        if (chatInput) chatInput.focus();
      }
    }

    if (chatForm) {
      chatForm.addEventListener("submit", function(e) {
        e.preventDefault();
        sendChat();
      });
    }

    if (chatInput) {
      chatInput.addEventListener("input", autoResizeChatInput);
      chatInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendChat();
        }
      });
    }

    var chatCancelBtn = $("chat-cancel");
    if (chatCancelBtn) {
      chatCancelBtn.addEventListener("click", cancelChat);
    }

    setInterval(function() {
      if (chatBusy && chatMessages) {
        var elapsedEl = chatMessages.querySelector(".chat-msg-elapsed");
        if (elapsedEl) elapsedEl.textContent = fmtElapsed(Date.now() - chatStartedAt);
      }
    }, 1000);

    // --- Initial load ---
    renderChatHistory();
    loadSessions();

    showSection(sectionFromHash());
    setInterval(function() {
      // Refresh home (including usage card) when it's visible
      var homeSection = $("section-home");
      if (homeSection && !homeSection.hidden) loadHome();
    }, 30000);
`;
