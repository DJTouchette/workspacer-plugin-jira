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
 * The prompt a spawned agent starts from, as a template.
 *
 * It deliberately does not say "implement this": it states the ticket and asks
 * for a read-back BEFORE code, because the agent has the repo, the human has
 * the context, and a ticket summary is not a spec. Handing an agent
 * "implement PROJ-123" and walking away is how you get confident nonsense.
 *
 * This is only the DEFAULT — teams whose tickets are more precise than that
 * (or who want a house style, a definition of done, a "always run the linter")
 * edit it in the pane, and the edit is stored per install. See loadTemplate.
 */
const DEFAULT_BRIEF = [
  'You are picking up {{key}} from Jira.',
  '',
  'Title:    {{summary}}',
  'Type:     {{type}}',
  'Status:   {{status}}',
  'Priority: {{priority}}',
  'Link:     {{url}}',
  '',
  'Ticket description:',
  '',
  '{{description}}',
  '',
  'Start by orienting yourself in this repo and telling me how you read the',
  'ticket — what you think needs to change and where — before writing code.',
  'If the ticket is ambiguous or underspecified, say so and ask.',
].join('\n');

/** The substitutions a template may use, in the order the editor lists them. */
const BRIEF_TOKENS = [
  { token: 'key', help: 'PROJ-123' },
  { token: 'summary', help: 'the ticket title' },
  { token: 'description', help: 'body text, flattened from ADF' },
  { token: 'type', help: 'Bug / Story / Task…' },
  { token: 'status', help: 'In Review, To Do…' },
  { token: 'priority', help: 'Highest, High…' },
  { token: 'assignee', help: 'display name' },
  { token: 'url', help: 'link back to Jira' },
  // Fetching comments is a per-issue API call, so it is NOT part of the poll.
  // A brief that uses this token is what triggers the fetch — which means the
  // template IS the setting: a triage brief asks for the discussion, a fix
  // brief doesn't, and neither needs a toggle to say so.
  { token: 'comments', help: 'recent discussion (fetched only if used)' },
];

/** Whether a template wants the discussion, and so whether to go and get it. */
function wantsComments(template) {
  return /\{\{\s*comments\s*\}\}/i.test(String(template || ''));
}

/** Jira comments → the flat text a brief embeds. Newest last, so the prompt
 *  reads chronologically the way a human would scroll it. */
function formatComments(comments) {
  const list = Array.isArray(comments) ? comments : [];
  if (!list.length) return '(No comments on this ticket.)';
  return list
    .map((c) => '— ' + (c.author || 'someone') + (c.created ? ' (' + c.created + ')' : '') +
                ':\n' + (c.body || '').trim())
    .join('\n\n');
}

/**
 * Fill a template from one issue.
 *
 * An UNKNOWN token is left standing rather than blanked: `{{summry}}` should
 * show up in the preview as itself so the typo is visible, instead of silently
 * deleting the line the user cared about. Absent values get an explicit stand-in
 * ("unset", "(The ticket has no description.)") for the same reason — a prompt
 * with a blank where the priority goes reads as a bug to the model too.
 */
function renderBrief(template, issue) {
  const i = issue || {};
  const vals = {
    key: i.key || '',
    summary: i.summary || '(no summary)',
    description: i.description || '(The ticket has no description.)',
    type: i.type || 'unknown',
    status: i.status || 'unknown',
    priority: i.priority || 'unset',
    assignee: i.assignee || 'unassigned',
    url: i.url || '',
    comments: formatComments(i.comments),
  };
  return String(template == null ? '' : template).replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (whole, name) => {
      const k = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : whole;
    },
  );
}

/** The brief for an issue using the DEFAULT template. */
function briefFor(issue) {
  return renderBrief(DEFAULT_BRIEF, issue);
}

/**
 * The briefs shipped out of the box. One prompt was never enough: picking up a
 * ticket is not one job. Triaging an unclear bug, implementing an agreed fix
 * and reproducing something are different asks and want different framing —
 * and only the first of them wants the comment thread.
 */
const DEFAULT_BRIEFS = [
  { id: 'understand', title: 'Understand first', template: DEFAULT_BRIEF },
  {
    id: 'triage',
    title: 'Triage',
    template: [
      'Triage {{key}} — do not fix it yet.',
      '',
      'Title:    {{summary}}',
      'Type:     {{type}}',
      'Priority: {{priority}}',
      'Link:     {{url}}',
      '',
      'Ticket description:',
      '',
      '{{description}}',
      '',
      'Discussion so far:',
      '',
      '{{comments}}',
      '',
      'Work out what is actually going on: reproduce it if you can, find the code',
      'responsible, and say how big the change looks. Come back with a diagnosis and',
      'a recommendation — not a patch. If the ticket is missing something you need,',
      'say exactly what to ask for.',
    ].join('\n'),
  },
  {
    id: 'fix',
    title: 'Fix',
    template: [
      'Implement {{key}}.',
      '',
      'Title:    {{summary}}',
      'Link:     {{url}}',
      '',
      '{{description}}',
      '',
      'The diagnosis is settled; this is the implementation pass. Make the change,',
      'cover it with a test that fails without it, and run the suite. Keep the diff',
      'to the ticket — anything else you notice goes in your summary, not the patch.',
      'If the ticket turns out to be wrong about the cause, stop and say so.',
    ].join('\n'),
  },
];

/** A stable, filename-safe id from a title. */
function slugId(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brief';
}

/**
 * Coerce whatever is on disk into a usable brief list. Tolerant on purpose:
 * this file is hand-editable, and a malformed entry should cost that entry, not
 * the ability to start an agent. An empty result falls back to the shipped set,
 * so there is never a state with no briefs at all.
 */
function normalizeBriefs(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const b of list) {
    if (!b || typeof b.template !== 'string' || !b.template.trim()) continue;
    const title = String(b.title || '').trim() || 'Untitled';
    let id = String(b.id || '').trim() || slugId(title);
    while (seen.has(id)) id += '-2';
    seen.add(id);
    out.push({ id, title, template: b.template });
  }
  return out.length ? out : DEFAULT_BRIEFS.map((b) => ({ ...b }));
}

// ── Directory ↔ project mapping ──────────────────────────────────────────────

/**
 * The project prefix of an issue key: HVMS-142 → HVMS. Jira keys are
 * `<PROJECT>-<number>` with the project part uppercase alphanumeric.
 */
function prefixOf(key) {
  const m = /^([A-Z][A-Z0-9_]*)-\d+$/.exec(String(key || '').trim().toUpperCase());
  return m ? m[1] : '';
}

/**
 * Coerce the stored mapping into a usable list. Same tolerance as the briefs:
 * a malformed row costs that row, not the feature. `jql` is the escape hatch
 * for what a prefix can't say — a monorepo holding two projects, or one project
 * split across repos by component — and is ANDed with the base JQL, never
 * instead of it.
 */
function normalizeProjects(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const e of list) {
    if (!e) continue;
    const dir = String(e.dir || '').trim().replace(/\/+$/, '');
    const prefix = String(e.prefix || '').trim().toUpperCase();
    if (!dir || !prefix) continue;
    out.push({ dir, prefix, jql: String(e.jql || '').trim() });
  }
  return out;
}

/**
 * Which directories an issue could be worked in. Usually one; a prefix mapped
 * to several directories (a project split across repos) legitimately yields
 * more, and the caller asks rather than guessing.
 */
function dirsForIssue(key, projects) {
  const p = prefixOf(key);
  if (!p) return [];
  return normalizeProjects(projects).filter((e) => e.prefix === p).map((e) => e.dir);
}

/**
 * The issues a pane in `cwd` should show. An UNMAPPED cwd shows everything —
 * that is today's behaviour and the right default: a pane that silently hides
 * your queue because you never filled in a table is worse than one that shows
 * too much. Only a directory you explicitly mapped gets filtered.
 */
function issuesForCwd(issues, cwd, projects) {
  const all = Array.isArray(issues) ? issues : [];
  if (!cwd) return all;
  const here = normalizeProjects(projects).filter((e) => e.dir === String(cwd).replace(/\/+$/, ''));
  if (!here.length) return all;
  const prefixes = new Set(here.map((e) => e.prefix));
  return all.filter((i) => prefixes.has(prefixOf(i.key)));
}

// ── Host project identity ────────────────────────────────────────────────────
// A MIRROR of workspacer's own resolution:
//   apps/desktop/src/renderer/src/lib/projectIdentity.ts
//   apps/desktop/src/renderer/src/lib/projectKey.ts
// The palette, the FNV-1a hash and the initials rules are ported exactly and
// MUST stay in agreement with that file. A pane that invents its own colour or
// its own initials for a directory is worse than one that shows no mark at all:
// the same project would carry two different identities inside one window, and
// the disagreement would look deliberate. If the host changes its palette or its
// hash, this changes with it.
//
// Nothing here is Jira-specific — the point is that a plugin pane draws a
// project the way the app draws it.

/** The host's fixed palette. Hues are spread and mid-saturation so a derived
 *  tint never reads as a status colour. */
const PROJECT_PALETTE = [
  '#6b8afd', // indigo
  '#c084fc', // violet
  '#f472b6', // pink
  '#fb923c', // orange
  '#2dd4bf', // teal
  '#38bdf8', // sky
  '#a3a3f5', // periwinkle
  '#e879a6', // rose
];

/** A stable 32-bit hash of a string (FNV-1a) — same path, same colour, on every
 *  machine and across restarts. */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The last path segment — the name a human calls the project. */
function basenameOf(dir) {
  const parts = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

/**
 * One or two characters for a name. A hyphenated or underscored name gives up
 * its word initials (`work-spacer` → `WS`), which keeps sibling repos that share
 * a prefix distinct (`api-gateway` and `api-worker` are `AG` and `AW`).
 */
function initialsOf(name) {
  const words = String(name || '').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) {
    const w = words[0];
    // A camelCase single word still has a second word inside it.
    const camel = w.match(/^([a-z]+)([A-Z][a-z]*)/);
    if (camel) return (camel[1][0] + camel[2][0]).toUpperCase();
    return w.slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** The host's config key for a directory: separators normalized, trailing ones
 *  dropped. Normalization, not canonicalization — no symlink or `..` resolution. */
function projectKey(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/** The key to read for `cwd`, honouring an existing entry that differs only by
 *  case — but only where the filesystem is case-insensitive, or `~/Repo` and
 *  `~/repo` would be merged on Linux. The host infers this from
 *  navigator.platform; a sidecar has the real thing. */
function resolveProjectKey(map, cwd) {
  const key = projectKey(cwd);
  if (!map || Object.prototype.hasOwnProperty.call(map, key)) return key;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return key;
  const lowered = key.toLowerCase();
  for (const existing of Object.keys(map)) {
    if (existing.toLowerCase() === lowered) return existing;
  }
  return key;
}

/**
 * Resolve a directory to what the pane should draw for it, from the host's
 * `config.projects`. A missing entry is normal and fully supported — an
 * unconfigured project still gets stable initials and a stable colour.
 *
 * One deliberate divergence from projectIdentity.ts: a DOWNLOADED icon is not
 * offered. The host serves those as `workspacer-icon://<file>`, a scheme
 * registered on Electron's default session, while a plugin pane's <webview>
 * lives in the `persist:browser` partition — so that URL cannot resolve here and
 * would draw a broken image. An http(s) favicon is an ordinary subresource and
 * does load, so it is the one image source passed through; anything else falls
 * back to the emoji, then to the initials, which is the whole reason the derived
 * mark exists.
 */
function resolveProjectIdentity(dir, projects) {
  if (!dir) return null;
  const map = projects && typeof projects === 'object' ? projects : {};
  const key = resolveProjectKey(map, dir);
  const raw = map[key];
  const entry = raw && typeof raw === 'object' ? raw : {};
  const label = String(entry.label || '').trim() || basenameOf(dir);
  const favicon = String(entry.favicon || '').trim();
  const out = {
    label,
    // Initials follow the LABEL, so renaming a project renames its mark too.
    initials: initialsOf(label),
    // Derived from the KEY, not the label: renaming must not re-colour.
    color: String(entry.color || '').trim() || PROJECT_PALETTE[fnv1a(key) % PROJECT_PALETTE.length],
  };
  const icon = String(entry.icon || '').trim();
  if (icon) out.icon = icon;
  if (/^https?:\/\//i.test(favicon)) out.iconSrc = favicon;
  return out;
}

/**
 * The directory ↔ project mapping as the HOST now holds it: a `prefix` (and
 * optional `jql`) declared `"scope": "project"` in the manifest and stored by
 * workspacer under `projects[<dir>].plugins[<pluginId>]`.
 *
 * This plugin invented that mapping privately, in its own `.projects.json`, and
 * so did shiplight and ci-watcher — each with its own storage and its own
 * editor. The host grew the concept, so the private file becomes a fallback:
 * an existing install keeps working, and the shared page is where new mappings
 * are made. Host wins on conflict, since that is the one a user can see.
 */
function projectsFromHostConfig(hostProjects, pluginId) {
  const out = [];
  for (const [dir, entry] of Object.entries(hostProjects || {})) {
    const mine = ((entry && entry.plugins) || {})[pluginId] || {};
    const prefix = String(mine.prefix || '').trim();
    if (!prefix) continue;
    // projectJql is the current setting key; `jql` is the pre-1.4.0 name it
    // clashed with (duplicate of the global setting key — the manifest never
    // validated), kept as a read fallback for rows written before the rename.
    out.push({ dir, prefix, jql: String(mine.projectJql || mine.jql || '').trim() });
  }
  return normalizeProjects(out);
}

/**
 * Host mappings layered over the legacy file. A directory present in both takes
 * the host's, so editing it on the Projects page actually changes behaviour
 * rather than being silently shadowed by a file nobody remembers.
 */
function mergeProjectSources(hostList, legacyList) {
  const byDir = new Map();
  for (const e of normalizeProjects(legacyList)) byDir.set(e.dir, e);
  for (const e of normalizeProjects(hostList)) byDir.set(e.dir, e);
  return [...byDir.values()];
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

module.exports = {
  projectsFromHostConfig, mergeProjectSources,
  adfToText, normalize, briefFor, renderBrief, resolveConf, isConfigured,
  newlyArrived, DEFAULT_JQL, DEFAULT_BRIEF, BRIEF_TOKENS,
  wantsComments, formatComments, DEFAULT_BRIEFS, normalizeBriefs, slugId,
  prefixOf, normalizeProjects, dirsForIssue, issuesForCwd,
  basenameOf, initialsOf, projectKey, resolveProjectKey, resolveProjectIdentity,
  PROJECT_PALETTE,
};
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

// ── The host's project identities ────────────────────────────────────────────
// `config.get` hands back the whole config document; only `projects` is kept.
//
// Fetched HERE, in the sidecar, rather than in the webview: the pane already
// polls /state, and a widget board can hold several surfaces reading the same
// endpoint, so one bus call serves all of them instead of one per surface —
// and the pane keeps its single source of truth. It also means the pane still
// draws a mark when it is opened without a bus token (standalone
// `workspacer plugin dev`), where `window.workspacer` does not exist.
//
// Refreshed on a TTL because the config has no change event on the bus; the
// host's own config.get is mtime-gated, so a poll costs a stat in the steady
// state.
const PROJECTS_TTL_MS = 60_000;
let hostProjects = {};
let hostProjectsAt = 0;
let hostProjectsInFlight = false;
let hostProjectsWarned = false;

function refreshHostProjects() {
  if (hostProjectsInFlight) return;
  hostProjectsInFlight = true;
  wks.call('config.get', {})
    .then((cfg) => {
      const p = cfg && cfg.projects;
      hostProjects = p && typeof p === 'object' ? p : {};
      hostProjectsAt = Date.now();
      hostProjectsWarned = false;
    })
    .catch((e) => {
      // Once, not every minute: a missing capability grant would otherwise
      // fill the sidecar log for the life of the process.
      if (!hostProjectsWarned) {
        hostProjectsWarned = true;
        log('config.get failed, panes will show no project mark: ' + e.message);
      }
      // Back off like a success so a dead bus is polled at the same cadence.
      hostProjectsAt = Date.now();
    })
    .finally(() => { hostProjectsInFlight = false; });
}

/** The identities, never awaited by a request: a bus call that never answers
 *  must not hang /state. A cold cache costs one poll tick of a missing mark. */
function projectsNow() {
  if (Date.now() - hostProjectsAt > PROJECTS_TTL_MS) refreshHostProjects();
  return hostProjects;
}
wks.ready.then(refreshHostProjects).catch(() => {});

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

// ── The brief template ───────────────────────────────────────────────────────
// Stored per install, in the plugin's own directory — which is the one place a
// sandboxed sidecar may write (bwrap/sandbox-exec bind exactly this dir). It is
// deliberately NOT a plugin setting: settings render as a 160px single-line
// input, which is no place to compose a prompt, and a plugin cannot write its
// own settings anyway (/plugins/settings is guarded to the host token).
//
// Dot-prefixed and gitignored, like the other per-install state the host keeps
// here (.settings.json, .bus-token), so a reinstall of the package doesn't
// carry someone's edited prompt into the repo.
const TEMPLATE_FILE = path.join(DIR, '.brief-template');   // legacy single template
const BRIEFS_FILE = path.join(DIR, '.briefs.json');
const PROJECTS_FILE = path.join(DIR, '.projects.json');

// A prompt, not a payload: enough for a long house style, small enough that a
// mistake can't fill the disk or the model's context.
const MAX_TEMPLATE_CHARS = 20000;

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The brief list. Migrates the single `.brief-template` this plugin shipped
 * with first: someone who edited their one prompt must not lose it to an
 * update that introduced the list, so it becomes the first entry and the old
 * file is left alone as a backstop.
 */
function loadBriefs() {
  const stored = readJsonFile(BRIEFS_FILE);
  if (stored) return normalizeBriefs(stored);
  const legacy = (() => {
    try {
      const raw = fs.readFileSync(TEMPLATE_FILE, 'utf8');
      return raw.trim() && raw.trim() !== DEFAULT_BRIEF.trim() ? raw : '';
    } catch {
      return '';
    }
  })();
  if (legacy) {
    return normalizeBriefs([
      { id: 'custom', title: 'My brief', template: legacy },
      ...DEFAULT_BRIEFS.filter((b) => b.id !== 'understand'),
    ]);
  }
  return DEFAULT_BRIEFS.map((b) => ({ ...b }));
}

function saveBriefs(list) {
  const clean = normalizeBriefs(
    (Array.isArray(list) ? list : []).map((b) => ({
      ...b,
      template: String((b && b.template) || '').slice(0, MAX_TEMPLATE_CHARS),
    })),
  );
  fs.writeFileSync(BRIEFS_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** Reset to the shipped set by removing the override, so a later, better
 *  default actually reaches the user instead of being shadowed by a stale copy. */
function resetBriefs() {
  try { fs.unlinkSync(BRIEFS_FILE); } catch {}
  return DEFAULT_BRIEFS.map((b) => ({ ...b }));
}

function loadProjects() {
  return mergeProjectSources(
    projectsFromHostConfig(hostProjects, manifest.id),
    readJsonFile(PROJECTS_FILE) || [],
  );
}

/** Where each active mapping came from, so the pane can say so instead of
 *  presenting two sources as one. */
function projectSources() {
  const host = new Set(projectsFromHostConfig(hostProjects, manifest.id).map((e) => e.dir));
  return loadProjects().map((e) => ({ ...e, source: host.has(e.dir) ? 'host' : 'legacy' }));
}

function saveProjects(list) {
  const clean = normalizeProjects(list);
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

// ── Issue detail (description + comments), fetched on demand ─────────────────
// NOT part of the poll: comments are a per-issue call, and pulling them for
// fifty tickets a minute is how you earn a 429 for the whole org. The pane asks
// when a row is expanded; a brief asks when its template uses {{comments}}.
const MAX_COMMENTS = 20;
const detailCache = new Map(); // key -> { at, comments }
const DETAIL_TTL_MS = 60_000;

async function fetchComments(key) {
  const cached = detailCache.get(key);
  if (cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.comments;
  const c = conf();
  if (!isConfigured(c)) return [];
  const data = await jiraGet(
    c,
    '/rest/api/3/issue/' + encodeURIComponent(key) +
      '/comment?orderBy=-created&maxResults=' + MAX_COMMENTS,
  );
  // orderBy=-created selects the most RECENT maxResults; the display order is
  // then sorted here rather than assumed. Blind-reversing the response trusts
  // the server to have honoured orderBy, and a thread rendered newest-first
  // reads backwards in a prompt — the model sees the conclusion before the
  // question. Sorting on the raw timestamp is correct either way.
  const comments = (data.comments || [])
    .map((x) => ({
      author: (x.author && x.author.displayName) || '',
      createdAt: String(x.created || ''),
      body: adfToText(x.body).trim().slice(0, 2000),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((x) => ({ author: x.author, created: x.createdAt.slice(0, 10), body: x.body }));
  detailCache.set(key, { at: Date.now(), comments });
  return comments;
}

// ── Ticket → agent ───────────────────────────────────────────────────────────

/** Spawn an agent in `cwd` and hand it the brief. Returns the session id. */
async function startAgent(issue, cwd, briefId) {
  const c = conf();
  const briefs = loadBriefs();
  const brief = briefs.find((b) => b.id === briefId) || briefs[0];

  // Only now, and only if this brief actually asks for the discussion.
  let enriched = issue;
  if (wantsComments(brief.template)) {
    try {
      enriched = { ...issue, comments: await fetchComments(issue.key) };
    } catch (e) {
      // A brief is still worth sending without its comments — better a slightly
      // thinner prompt than no agent.
      log('comments for ' + issue.key + ' failed, sending brief without them: ' + e.message);
    }
  }

  const spawned = await wks.call('agents.spawn', { provider: c.provider, cwd, label: issue.key });
  const sessionId = spawned && spawned.sessionId;
  if (!sessionId) throw new Error('agents.spawn returned no sessionId');

  // A fresh session needs a moment before it accepts input, and
  // agents.sendMessage throws while it doesn't — retry briefly rather than
  // dropping the brief and leaving the user an empty agent they didn't ask for.
  const text = renderBrief(brief.template, enriched);
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
    const cwd = new URL(req.url || '/', 'http://x').searchParams.get('cwd') || '';
    const projects = loadProjects();
    const scoped = issuesForCwd(state.issues, cwd, projects);
    return sendJson(res, 200, Object.assign({}, state, {
      provider: conf().provider,
      issues: scoped,
      // So the pane can say "showing HVMS" rather than silently hiding things,
      // and can enable Start agent for tickets whose directory it now knows
      // even when the pane itself has no cwd.
      scopedTo: projects.filter((e) => e.dir === cwd.replace(/\/+$/, '')).map((e) => e.prefix),
      mapped: projects.length > 0,
      // What the HOST would draw for this pane's directory, so the header reads
      // as part of the app rather than as a plugin that happens to be docked in
      // it. null when the pane has no cwd (the Overview pane).
      project: resolveProjectIdentity(cwd, projectsNow()),
    }));
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
    // The pane's own cwd wins; otherwise the mapping resolves one. That is what
    // makes Start agent work from the Overview pane, which has no cwd at all.
    const candidates = dirsForIssue(issue.key, loadProjects());
    const cwd = body.cwd || (candidates.length === 1 ? candidates[0] : '');
    if (!cwd) {
      return sendJson(res, 400, {
        error: candidates.length
          ? 'several directories are mapped to ' + prefixOf(issue.key) + ' — pick one'
          : 'no project directory for this pane, and ' +
            (prefixOf(issue.key) || 'this ticket') + ' is not mapped to one',
        candidates,
      });
    }
    try {
      return sendJson(res, 200, { sessionId: await startAgent(issue, cwd, body.briefId), cwd });
    } catch (e) {
      log('start failed: ' + e.message);
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (url === '/briefs' && req.method === 'GET') {
    return sendJson(res, 200, {
      briefs: loadBriefs(),
      defaults: DEFAULT_BRIEFS,
      tokens: BRIEF_TOKENS,
    });
  }
  if (url === '/briefs' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return sendJson(res, 200, { briefs: body.reset ? resetBriefs() : saveBriefs(body.briefs) });
    } catch (e) {
      // A read-only plugin dir is the realistic failure. Say so — silently
      // discarding an edit the user just wrote is the worse outcome.
      log('could not save briefs: ' + e.message);
      return sendJson(res, 500, { error: 'could not save: ' + e.message });
    }
  }
  if (url === '/projects' && req.method === 'GET') {
    return sendJson(res, 200, { projects: projectSources(), pluginId: manifest.id });
  }
  if (url === '/projects' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return sendJson(res, 200, { projects: saveProjects(body.projects) });
    } catch (e) {
      log('could not save projects: ' + e.message);
      return sendJson(res, 500, { error: 'could not save: ' + e.message });
    }
  }
  // Row expansion: the description we already have, plus the comment thread we
  // deliberately do not poll for.
  if (url.startsWith('/issue/') && url.endsWith('/detail')) {
    const key = decodeURIComponent(url.slice('/issue/'.length, -'/detail'.length));
    const issue = state.issues.find((i) => i.key === key);
    if (!issue) return sendJson(res, 404, { error: 'unknown issue ' + key });
    try {
      return sendJson(res, 200, { key, description: issue.description, comments: await fetchComments(key) });
    } catch (e) {
      // The description is already in hand — show it rather than failing the
      // whole expansion because the comment call was refused.
      return sendJson(res, 200, { key, description: issue.description, comments: [], error: e.message });
    }
  }
  // Rendered by the SERVER so the preview is the exact text the agent will be
  // sent, rather than a second substitution implementation in the pane that can
  // drift from this one.
  if (url === '/brief/preview' && req.method === 'POST') {
    const body = await readBody(req);
    const issue = state.issues.find((i) => i.key === body.key) || state.issues[0] || {
      key: 'PROJ-123',
      summary: 'An example ticket',
      description: 'What the ticket says goes here.',
      type: 'Task', status: 'To Do', priority: 'Medium', assignee: 'you',
      url: 'https://example.atlassian.net/browse/PROJ-123',
    };
    let previewIssue = issue;
    if (wantsComments(body.template) && issue.key) {
      try {
        previewIssue = { ...issue, comments: await fetchComments(issue.key) };
      } catch { /* preview without them */ }
    }
    return sendJson(res, 200, { text: renderBrief(body.template, previewIssue), key: issue.key });
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

// ── Facade tools (manifest `tools` → agents' mcp__workspacer__* surface) ─────
// The hub routes a granted agent's tool call here as a plain bus call of the
// `provides` method. Handlers return raw data — the caller is a model, not the
// pane — and errors become the caller's error reply verbatim.

const TOOL_MAX_RESULTS = 50;

wks.provide('djtouchette.jira.search', async (params) => {
  const c = conf();
  if (!isConfigured(c)) throw new Error('jira plugin is not configured (baseUrl/email/apiToken)');
  const p = params || {};
  const jql = String(p.jql || '').trim() || c.jql;
  const max = Math.max(1, Math.min(TOOL_MAX_RESULTS, Number(p.maxResults) || 20));
  const q = 'jql=' + encodeURIComponent(jql) + '&fields=' + FIELDS + '&maxResults=' + max;
  let data;
  try {
    data = await jiraGet(c, '/rest/api/3/search/jql?' + q);
  } catch (e) {
    if (e.status !== 404 && e.status !== 410) throw e;
    data = await jiraGet(c, '/rest/api/3/search?' + q);
  }
  const issues = (data.issues || []).map((i) => normalize(i, c.baseUrl));
  return { jql, total: issues.length, issues };
});

wks.provide('djtouchette.jira.issue', async (params) => {
  const c = conf();
  if (!isConfigured(c)) throw new Error('jira plugin is not configured (baseUrl/email/apiToken)');
  const key = String((params || {}).key || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) throw new Error('invalid issue key: ' + key);
  const data = await jiraGet(
    c,
    '/rest/api/3/issue/' + encodeURIComponent(key) + '?fields=' + FIELDS,
  );
  const issue = normalize(data, c.baseUrl);
  let comments = [];
  try {
    comments = await fetchComments(key);
  } catch { /* the issue itself is still useful without its thread */ }
  return { ...issue, description: adfToText((data.fields || {}).description).trim(), comments };
});
