#!/usr/bin/env node
// Jira — your ticket queue, and one click from a ticket to an agent working it.
//
// Sidecar: runs a JQL search against Jira Cloud on a poll, serves the pane +
// widget UI from ./ui, and turns "start an agent on this" into the two bus
// calls it actually takes (agents.spawn, then agents.sendMessage with a brief
// built from the issue). Notifies on issues that ENTER the search after the
// first poll — never on the backlog that was already there when it started.
//
// Auth is Basic email:apiToken (Jira Cloud's REST scheme). Zero dependencies —
// Node >= 22.
//
// Layout mirrors shiplight: pure helpers first, exported for `node test.js`,
// then `require.main` guards the runtime so importing this file never opens a
// socket or starts a poll.
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));

const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const FIELDS = 'summary,status,issuetype,priority,assignee,updated,description';

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Atlassian Document Format → plain text. The v3 API returns descriptions as an
 * ADF node tree, not a string, and the whole point of the brief is that an
 * agent can read it. Walks for `text` nodes and breaks on block boundaries;
 * anything exotic (media, panels) degrades to its text content rather than
 * throwing, and the depth cap means a cyclic/nested document can't hang the poll.
 */
function adfToText(node, depth = 0) {
  if (!node || depth > 20) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => adfToText(n, depth + 1)).join('');
  if (node.type === 'text') return String(node.text || '');
  if (node.type === 'hardBreak') return '\n';
  const inner = adfToText(node.content, depth + 1);
  if (node.type === 'listItem') return '- ' + inner.trim() + '\n';
  const BLOCK = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'rule']);
  return BLOCK.has(node.type) ? inner.trimEnd() + '\n\n' : inner;
}

/** One Jira issue → the flat shape the pane, the widget and the brief all use. */
function normalize(issue, baseUrl) {
  const f = (issue && issue.fields) || {};
  const status = f.status || {};
  return {
    key: issue.key,
    summary: String(f.summary || '').trim(),
    status: status.name || '',
    statusCategory: (status.statusCategory && status.statusCategory.key) || '',
    type: (f.issuetype && f.issuetype.name) || '',
    priority: (f.priority && f.priority.name) || '',
    assignee: (f.assignee && f.assignee.displayName) || '',
    updated: f.updated || '',
    // Bounded: a description rides into a prompt, and Jira tickets can carry
    // whole design docs.
    description: adfToText(f.description).trim().slice(0, 4000),
    url: (baseUrl || '') + '/browse/' + issue.key,
  };
}

/**
 * The prompt a spawned agent starts from. Deliberately states the ticket's
 * identity and asks for a read-back BEFORE code: the agent has the repo, the
 * human has the context, and a ticket summary is not a spec. Handing an agent
 * "implement PROJ-123" and walking away is how you get confident nonsense.
 */
function briefFor(issue) {
  const lines = [
    'You are picking up ' + issue.key + ' from Jira.',
    '',
    'Title:    ' + issue.summary,
    'Type:     ' + (issue.type || 'unknown'),
    'Status:   ' + (issue.status || 'unknown'),
    'Priority: ' + (issue.priority || 'unset'),
    'Link:     ' + issue.url,
  ];
  if (issue.description) lines.push('', 'Ticket description:', '', issue.description);
  else lines.push('', '(The ticket has no description.)');
  lines.push(
    '',
    'Start by orienting yourself in this repo and telling me how you read the',
    'ticket — what you think needs to change and where — before writing code.',
    'If the ticket is ambiguous or underspecified, say so and ask.',
  );
  return lines.join('\n');
}

/** Settings → the resolved config, with a code default behind every key. */
function resolveConf(s) {
  const st = s || {};
  return {
    baseUrl: String(st.baseUrl || '').trim().replace(/\/+$/, ''),
    email: String(st.email || '').trim(),
    apiToken: String(st.apiToken || '').trim(),
    jql: String(st.jql || '').trim() || DEFAULT_JQL,
    provider: String(st.provider || 'claude'),
    // Floored: a 5s poll against Jira Cloud earns a 429 for everyone.
    pollSeconds: Math.max(20, Number(st.pollSeconds) || 120),
    notifyNew: st.notifyNew !== false,
  };
}

/** Every field needed to talk to Jira is present. */
function isConfigured(c) {
  return Boolean(c.baseUrl && c.email && c.apiToken);
}

/** Which issues are new relative to the previous poll. `prev === null` (the
 *  first successful poll) is a BASELINE and yields nothing: the backlog that
 *  already existed is not news, and notifying on it would mean a wall of toasts
 *  on every app restart. */
function newlyArrived(prev, issues) {
  if (prev === null) return [];
  return issues.filter((i) => !prev.has(i.key));
}

module.exports = { adfToText, normalize, briefFor, resolveConf, isConfigured, newlyArrived, DEFAULT_JQL };
if (require.main !== module) return;

// ── Runtime ──────────────────────────────────────────────────────────────────
// Any startup throw must leave a readable line in the sidecar log — a bare
// "exit status 1" in the plugins manager is undebuggable.
process.on('uncaughtException', (err) => {
  console.error('[' + manifest.id + '] fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});

const { connect } = require('./wks.js');

const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9214);

// Settings: WKS_SETTINGS (manifest defaults merged by the hub) over the raw
// overlay the SDK reads.
let envSettings = {};
try {
  envSettings = JSON.parse(process.env.WKS_SETTINGS || '{}');
} catch {}

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
}

const wks = connect({ source: 'plugin:' + manifest.id });
let settings = Object.assign({}, wks.settings, envSettings);
if (wks.onSettings) wks.onSettings((s) => { settings = Object.assign({}, settings, s); });

const conf = () => resolveConf(settings);

// ── Jira REST ────────────────────────────────────────────────────────────────

async function jiraGet(c, pathAndQuery) {
  const res = await fetch(c.baseUrl + pathAndQuery, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(c.email + ':' + c.apiToken).toString('base64'),
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(
      'Jira ' + res.status + ' ' + res.statusText + (body ? ': ' + body.slice(0, 200) : ''),
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Run the JQL search. Jira Cloud replaced GET /rest/api/3/search with
 * /rest/api/3/search/jql; older and Server instances only have the former, so
 * try the current endpoint and fall back once on 404/410 rather than making the
 * user care which one their instance is.
 */
async function search(c) {
  const q = 'jql=' + encodeURIComponent(c.jql) + '&fields=' + FIELDS + '&maxResults=50';
  try {
    return await jiraGet(c, '/rest/api/3/search/jql?' + q);
  } catch (e) {
    if (e.status !== 404 && e.status !== 410) throw e;
    return await jiraGet(c, '/rest/api/3/search?' + q);
  }
}

// ── Poll ─────────────────────────────────────────────────────────────────────

let state = { issues: [], error: '', configured: false, updatedAt: 0 };
let seen = null; // null until the first successful poll — see newlyArrived.

const NOTIFY_SOURCE = 'plugin:' + manifest.id;

async function notify(issue) {
  try {
    await wks.call('notifications.post', {
      level: 'info',
      source: NOTIFY_SOURCE,
      // One slot per issue: a re-notified key replaces its entry rather than
      // stacking a second copy.
      key: 'jira:' + issue.key,
      title: issue.key + ' assigned to you',
      body: issue.summary,
      url: issue.url,
    });
  } catch (e) {
    log('notifications.post failed: ' + e.message);
  }
}

async function pollNow() {
  const c = conf();
  if (!isConfigured(c)) {
    state = { issues: [], error: '', configured: false, updatedAt: Date.now() };
    return;
  }
  try {
    const data = await search(c);
    const issues = (data.issues || []).map((i) => normalize(i, c.baseUrl));
    state = { issues, error: '', configured: true, updatedAt: Date.now() };
    const fresh = newlyArrived(seen, issues);
    seen = new Set(issues.map((i) => i.key));
    if (c.notifyNew) for (const i of fresh) notify(i);
  } catch (e) {
    // Keep the last good issues on screen — a transient 500 or a dropped VPN
    // should not blank the pane.
    state = { issues: state.issues, error: e.message, configured: true, updatedAt: Date.now() };
    log('poll failed: ' + e.message);
  }
}

// ── Ticket → agent ───────────────────────────────────────────────────────────

/** Spawn an agent in `cwd` and hand it the brief. Returns the session id. */
async function startAgent(issue, cwd) {
  const c = conf();
  const spawned = await wks.call('agents.spawn', { provider: c.provider, cwd, label: issue.key });
  const sessionId = spawned && spawned.sessionId;
  if (!sessionId) throw new Error('agents.spawn returned no sessionId');

  // A fresh session needs a moment before it accepts input, and
  // agents.sendMessage throws while it doesn't — retry briefly rather than
  // dropping the brief and leaving the user an empty agent they didn't ask for.
  const text = briefFor(issue);
  let lastErr = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await wks.call('agents.sendMessage', { sessionId, text });
      return sessionId;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    'spawned ' + sessionId + ' but it never accepted the brief: ' + (lastErr && lastErr.message),
  );
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > 1e6) buf = buf.slice(0, 1e6);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveUi(res, file) {
  fs.readFile(path.join(DIR, 'ui', file), (err, buf) => {
    if (err) {
      res.writeHead(500);
      return res.end('ui missing');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x').pathname;

  if (url === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }
  if (url === '/state') {
    return sendJson(res, 200, Object.assign({ provider: conf().provider }, state));
  }
  if (url === '/refresh' && req.method === 'POST') {
    pollNow();
    res.writeHead(202);
    return res.end('ok');
  }
  if (url === '/start' && req.method === 'POST') {
    const body = await readBody(req);
    // Resolved from server state, not from the request body: the brief is built
    // from the issue this sidecar fetched, so a pane cannot hand an arbitrary
    // description to a spawned agent.
    const issue = state.issues.find((i) => i.key === body.key);
    if (!issue) return sendJson(res, 404, { error: 'unknown issue ' + body.key });
    // Refused rather than defaulted: agents.spawn with no cwd lands in $HOME,
    // which is never where the ticket's code is.
    if (!body.cwd) return sendJson(res, 400, { error: 'no project directory for this pane' });
    try {
      return sendJson(res, 200, { sessionId: await startAgent(issue, body.cwd) });
    } catch (e) {
      log('start failed: ' + e.message);
      return sendJson(res, 500, { error: e.message });
    }
  }
  // One widget file, branching on the last path segment — matched before the
  // catch-all, which would otherwise hand a small tile the whole pane UI.
  if (url === '/widget' || url.startsWith('/widget/')) return serveUi(res, 'widget.html');
  return serveUi(res, 'index.html');
});

server.on('error', (e) => {
  log(
    'http server error: ' + e.message +
      (e && e.code === 'EADDRINUSE'
        ? ' — port ' + PORT + ' is already in use (a previous Jira instance still running?)'
        : ''),
  );
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));

pollNow();
setInterval(() => pollNow(), conf().pollSeconds * 1000);
