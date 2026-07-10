/**
 * The `.claude/statusline.cjs` script body, lifted verbatim out of the
 * start() daemon closure (codebase-audit P1). A standalone Node CJS script
 * (run by Claude Code as `node .claude/statusline.cjs`) that renders the
 * boxed Errandd status line from `.claude/errandd/state.json`.
 *
 * Kept as an exported string (not a loose .cjs asset) so it is bundled into
 * binary builds and travels with the daemon. setupStatusline() writes it to
 * disk on start. Behaviour-identical to the former inline template literal.
 */
export const STATUSLINE_SCRIPT = `#!/usr/bin/env node
const { readFileSync } = require("fs");
const { join } = require("path");

const DIR = join(__dirname, "errandd");
const STATE_FILE = join(DIR, "state.json");
const PID_FILE = join(DIR, "daemon.pid");
const TOKEN_FILE = join(DIR, "web.token");

const R = "\\x1b[0m";
const DIM = "\\x1b[2m";
const RED = "\\x1b[31m";
const GREEN = "\\x1b[32m";

function stripAnsi(s) {
  return s
    .replace(/\\x1b\\]8;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/g, "")
    .replace(/\\x1b\\[[0-9;]*m/g, "");
}
function visibleLen(s) {
  var clean = stripAnsi(s);
  var len = 0;
  for (var i = 0; i < clean.length; i++) {
    var code = clean.codePointAt(i);
    if (code > 0xffff) { i++; len += 2; }
    else { len++; }
  }
  return len;
}

function fmt(ms) {
  if (ms <= 0) return GREEN + "now!" + R;
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return (s % 60) + "s";
}

function alive() {
  try {
    var pid = readFileSync(PID_FILE, "utf-8").trim();
    var parsedPid = Number(pid);
    if (!Number.isFinite(parsedPid) || !Number.isInteger(parsedPid) || parsedPid <= 0) {
      return false;
    }
    process.kill(parsedPid, 0);
    return true;
  } catch { return false; }
}

var B = DIM + "\\u2502" + R;
var TITLE = " \\ud83e\\udd9e Errandd \\ud83e\\udd9e ";
var PAD = 6;
var INNER_W = PAD + visibleLen(TITLE) + PAD;

function render(content) {
  var contentW = visibleLen(content);
  var w = Math.max(contentW, INNER_W);
  var titlePad = w - visibleLen(TITLE);
  var leftPad = Math.floor(titlePad / 2);
  var rightPad = titlePad - leftPad;
  var H = DIM + "\\u2500" + R;
  var header = DIM + "\\u256d" + R + H.repeat(leftPad) + TITLE + H.repeat(rightPad) + DIM + "\\u256e" + R;
  var footer = DIM + "\\u2570" + R + H.repeat(w) + DIM + "\\u256f" + R;
  var gap = w - contentW;
  var padded = gap > 0 ? content + " ".repeat(gap) : content;
  process.stdout.write(header + "\\n" + B + padded + B + "\\n" + footer);
}

if (!alive()) {
  render("        " + RED + "\\u25cb offline" + R);
  process.exit(0);
}

try {
  var state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  var now = Date.now();
  var info = [];

  if (state.heartbeat) {
    info.push("\\ud83d\\udc93 " + fmt(state.heartbeat.nextAt - now));
  }

  var jc = (state.jobs || []).length;
  info.push("\\ud83d\\udccb " + jc + " job" + (jc !== 1 ? "s" : ""));
  info.push(GREEN + "\\u25cf live" + R);

  if (state.web && state.web.enabled) {
    var webHost = state.web.host === "0.0.0.0" || state.web.host === "::" ? "localhost" : state.web.host;
    var webUrl = "http://" + webHost + ":" + state.web.port + "/v3/";
    try {
      var tok = readFileSync(TOKEN_FILE, "utf-8").trim();
      if (tok) {
        webUrl += "?token=" + encodeURIComponent(tok);
      }
    } catch {}
    info.push("\\x1b]8;;" + webUrl + "\\x1b\\\\\\ud83c\\udf10 " + state.web.port + "\\x1b]8;;\\x1b\\\\");
  }

  if (state.telegram) {
    info.push(GREEN + "\\ud83d\\udce1" + R);
  }

  if (state.discord) {
    info.push(GREEN + "\\ud83c\\udfae" + R);
  }

  render(" " + info.join(" " + B + " ") + " ");
} catch {
  render(DIM + "         waiting...         " + R);
}
`;
