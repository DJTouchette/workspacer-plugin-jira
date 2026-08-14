#!/usr/bin/env node
// Static tests for the Jira plugin's pure helpers (run: node test.js).
// server.js exports these and only starts the sidecar when run directly.
const assert = require('assert');
const {
  adfToText, normalize, briefFor, renderBrief, resolveConf, isConfigured, newlyArrived,
  DEFAULT_JQL, DEFAULT_BRIEF, BRIEF_TOKENS,
  wantsComments, formatComments, DEFAULT_BRIEFS, normalizeBriefs, slugId,
  prefixOf, normalizeProjects, dirsForIssue, issuesForCwd,
  basenameOf, initialsOf, projectKey, resolveProjectKey, resolveProjectIdentity,
  PROJECT_PALETTE,
  projectsFromHostConfig, mergeProjectSources,
} = require('./server.js');

// ── adfToText ────────────────────────────────────────────────────────────────
// The v3 API returns descriptions as an ADF tree, never a string, so a brief
// built without this contains "[object Object]".
assert.strictEqual(adfToText(null), '');
assert.strictEqual(adfToText({ type: 'text', text: 'hello' }), 'hello');
assert.strictEqual(
  adfToText({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First para.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second para.' }] },
    ],
  }).trim(),
  'First para.\n\nSecond para.',
);
// Bullet lists survive as readable text rather than collapsing into a run-on.
assert.strictEqual(
  adfToText({
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
    ],
  }).trim(),
  '- one\n- two',
);
// Marks (bold/link) keep their text; unknown node types degrade to content.
assert.strictEqual(
  adfToText({ type: 'paragraph', content: [
    { type: 'text', text: 'see ' },
    { type: 'text', text: 'the docs', marks: [{ type: 'link', attrs: { href: 'x' } }] },
  ] }).trim(),
  'see the docs',
);
assert.strictEqual(adfToText({ type: 'someFutureNode', content: [{ type: 'text', text: 'kept' }] }), 'kept');
// A cyclic/absurdly deep document must not hang the poll.
let deep = { type: 'text', text: 'bottom' };
for (let i = 0; i < 60; i++) deep = { type: 'paragraph', content: [deep] };
assert.strictEqual(typeof adfToText(deep), 'string');

// ── normalize ────────────────────────────────────────────────────────────────
const raw = {
  key: 'PROJ-12',
  fields: {
    summary: '  Fix the flaky login test  ',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Bug' },
    priority: { name: 'High' },
    assignee: { displayName: 'Dana' },
    updated: '2026-08-01T10:00:00.000+0000',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It flakes.' }] }] },
  },
};
const n = normalize(raw, 'https://acme.atlassian.net');
assert.strictEqual(n.key, 'PROJ-12');
assert.strictEqual(n.summary, 'Fix the flaky login test');
assert.strictEqual(n.status, 'In Progress');
assert.strictEqual(n.statusCategory, 'indeterminate');
assert.strictEqual(n.type, 'Bug');
assert.strictEqual(n.priority, 'High');
assert.strictEqual(n.description, 'It flakes.');
assert.strictEqual(n.url, 'https://acme.atlassian.net/browse/PROJ-12');

// Every optional field is genuinely optional — an unassigned, unprioritised
// issue with no description is ordinary, and must not throw.
const bare = normalize({ key: 'PROJ-13', fields: {} }, 'https://acme.atlassian.net');
assert.strictEqual(bare.summary, '');
assert.strictEqual(bare.priority, '');
assert.strictEqual(bare.assignee, '');
assert.strictEqual(bare.description, '');
assert.strictEqual(bare.url, 'https://acme.atlassian.net/browse/PROJ-13');

// A giant description is bounded — it rides into a prompt.
const huge = normalize({ key: 'P-1', fields: {
  description: { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(9000) }] },
} }, '');
assert.ok(huge.description.length <= 4000, 'description must be capped');

// ── briefFor ─────────────────────────────────────────────────────────────────
const brief = briefFor(n);
assert.ok(brief.includes('PROJ-12'), 'the brief names the ticket');
assert.ok(brief.includes('Fix the flaky login test'));
assert.ok(brief.includes('https://acme.atlassian.net/browse/PROJ-12'), 'the brief links back');
assert.ok(brief.includes('It flakes.'), 'the brief carries the description');
assert.ok(/before writing code/i.test(brief), 'the brief asks for a read-back first');
assert.ok(briefFor(bare).includes('no description'), 'an empty description says so explicitly');

// ── renderBrief (the editable template) ──────────────────────────────────────
assert.strictEqual(renderBrief('{{key}}: {{summary}}', n), 'PROJ-12: Fix the flaky login test');
// Whitespace inside the braces is a typo waiting to happen; accept it.
assert.strictEqual(renderBrief('{{ key }}', n), 'PROJ-12');
// Case-insensitive, so {{KEY}} does not silently do nothing.
assert.strictEqual(renderBrief('{{KEY}}', n), 'PROJ-12');
// An UNKNOWN token survives verbatim. Blanking it would delete the line the
// user cared about and hide the typo; leaving it makes the mistake visible in
// the preview, which is the whole point of having one.
assert.strictEqual(renderBrief('a {{summry}} b', n), 'a {{summry}} b');
// Every advertised token resolves — a chip in the editor that inserts a token
// the renderer ignores is a broken promise.
for (const t of BRIEF_TOKENS) {
  const out = renderBrief('<{{' + t.token + '}}>', n);
  assert.ok(!out.includes('{{'), 'advertised token {{' + t.token + '}} does not resolve');
}
// Absent values get a stand-in, never a blank: a prompt with nothing after
// "Priority:" reads as a bug to the model too.
assert.strictEqual(renderBrief('{{priority}}', { key: 'X' }), 'unset');
assert.strictEqual(renderBrief('{{summary}}', { key: 'X' }), '(no summary)');
assert.ok(/no description/.test(renderBrief('{{description}}', { key: 'X' })));
// Degenerate templates must not throw — the editor lets you save anything.
assert.strictEqual(renderBrief('', n), '');
assert.strictEqual(renderBrief(null, n), '');
assert.strictEqual(renderBrief('no tokens at all', n), 'no tokens at all');
assert.doesNotThrow(() => renderBrief('{{key}}', null));

// The default is a template, and briefFor is that template rendered — so the
// shipped wording and the editable one can never drift apart.
assert.ok(DEFAULT_BRIEF.includes('{{key}}'), 'the default must be a template');
assert.strictEqual(briefFor(n), renderBrief(DEFAULT_BRIEF, n));

// ── resolveConf / isConfigured ───────────────────────────────────────────────
const d = resolveConf({});
assert.strictEqual(d.jql, DEFAULT_JQL);
assert.strictEqual(d.provider, 'claude');
assert.strictEqual(d.pollSeconds, 120);
assert.strictEqual(d.notifyNew, true);
assert.strictEqual(isConfigured(d), false);
// A trailing slash on the base URL would double up in every issue link.
assert.strictEqual(resolveConf({ baseUrl: 'https://acme.atlassian.net/' }).baseUrl, 'https://acme.atlassian.net');
// The poll floor protects a shared API from a mistyped 1.
assert.strictEqual(resolveConf({ pollSeconds: 1 }).pollSeconds, 20);
assert.strictEqual(resolveConf({ pollSeconds: 600 }).pollSeconds, 600);
// A blank JQL falls back rather than searching for nothing.
assert.strictEqual(resolveConf({ jql: '   ' }).jql, DEFAULT_JQL);
assert.strictEqual(resolveConf({ notifyNew: false }).notifyNew, false);
assert.strictEqual(
  isConfigured(resolveConf({ baseUrl: 'https://x', email: 'a@b.c', apiToken: 't' })),
  true,
);
// Two of three is not configured — a half-filled form must not fire requests.
assert.strictEqual(isConfigured(resolveConf({ baseUrl: 'https://x', email: 'a@b.c' })), false);

// ── Directory ↔ project mapping ──────────────────────────────────────────────
assert.strictEqual(prefixOf('HVMS-142'), 'HVMS');
assert.strictEqual(prefixOf('hvms-142'), 'HVMS', 'keys are matched case-insensitively');
assert.strictEqual(prefixOf('AB2-9'), 'AB2', 'digits are legal inside a project key');
assert.strictEqual(prefixOf('not-a-key'), '');
assert.strictEqual(prefixOf(''), '');
assert.strictEqual(prefixOf(null), '');

// A row missing either half is not a mapping; prefixes normalise to upper case
// so a user typing "hvms" gets what they meant.
assert.deepStrictEqual(
  normalizeProjects([{ dir: '/a/', prefix: 'hvms' }, { dir: '', prefix: 'X' }, { prefix: 'Y' }, null]),
  [{ dir: '/a', prefix: 'HVMS', jql: '' }],
);

const PROJ = [
  { dir: '/repo/hvms', prefix: 'HVMS' },
  { dir: '/repo/plat', prefix: 'PLAT' },
  { dir: '/repo/hvms-ui', prefix: 'HVMS' },
];
assert.deepStrictEqual(dirsForIssue('HVMS-1', PROJ), ['/repo/hvms', '/repo/hvms-ui'],
  'one prefix may legitimately map to several directories');
assert.deepStrictEqual(dirsForIssue('PLAT-1', PROJ), ['/repo/plat']);
assert.deepStrictEqual(dirsForIssue('NOPE-1', PROJ), []);

const MIXED = [{ key: 'HVMS-1' }, { key: 'PLAT-9' }, { key: 'HVMS-2' }];
assert.deepStrictEqual(issuesForCwd(MIXED, '/repo/hvms', PROJ).map((i) => i.key), ['HVMS-1', 'HVMS-2']);
// Trailing slashes are a typing accident, not a different directory.
assert.deepStrictEqual(issuesForCwd(MIXED, '/repo/hvms/', PROJ).map((i) => i.key), ['HVMS-1', 'HVMS-2']);
// An UNMAPPED directory shows everything. Hiding someone's queue because they
// never filled in a table is worse than showing too much.
assert.strictEqual(issuesForCwd(MIXED, '/somewhere/else', PROJ).length, 3);
assert.strictEqual(issuesForCwd(MIXED, '', PROJ).length, 3);
assert.strictEqual(issuesForCwd(MIXED, '/repo/hvms', []).length, 3);

// ── Briefs ───────────────────────────────────────────────────────────────────
assert.ok(DEFAULT_BRIEFS.length >= 3, 'ship more than one, or the picker is pointless');
assert.deepStrictEqual(DEFAULT_BRIEFS.map((b) => b.id), ['understand', 'triage', 'fix']);
// The token IS the setting: a triage brief wants the discussion, a fix brief
// does not, and neither needs a toggle to say so.
assert.strictEqual(wantsComments(DEFAULT_BRIEFS.find((b) => b.id === 'triage').template), true);
assert.strictEqual(wantsComments(DEFAULT_BRIEFS.find((b) => b.id === 'fix').template), false);
assert.strictEqual(wantsComments('{{ COMMENTS }}'), true, 'spacing and case must not matter');
assert.strictEqual(wantsComments('no tokens'), false);
assert.strictEqual(wantsComments(null), false);

assert.strictEqual(slugId('Investigate a Bug!'), 'investigate-a-bug');
assert.strictEqual(slugId(''), 'brief');

// A hand-editable file must not be able to leave you with nothing to start with.
assert.deepStrictEqual(normalizeBriefs([]).map((b) => b.id), DEFAULT_BRIEFS.map((b) => b.id));
assert.deepStrictEqual(normalizeBriefs(null).map((b) => b.id), DEFAULT_BRIEFS.map((b) => b.id));
// A malformed entry costs that entry, not the feature.
assert.deepStrictEqual(
  normalizeBriefs([{ title: 'A', template: 'x' }, { title: 'B' }, null, { template: '   ' }])
    .map((b) => b.title),
  ['A'],
);
// Duplicate ids would make the caret menu ambiguous and the picker pick wrong.
const dup = normalizeBriefs([
  { id: 'x', title: 'One', template: 'a' },
  { id: 'x', title: 'Two', template: 'b' },
]);
assert.strictEqual(new Set(dup.map((b) => b.id)).size, 2, 'ids must be unique');

// ── formatComments ───────────────────────────────────────────────────────────
assert.ok(/No comments/.test(formatComments([])), 'an empty thread says so rather than going blank');
assert.ok(/No comments/.test(formatComments(null)));
const fc = formatComments([
  { author: 'Sam', created: '2026-08-10', body: 'First.' },
  { author: 'Dana', created: '2026-08-11', body: 'Second.' },
]);
assert.ok(fc.indexOf('First.') < fc.indexOf('Second.'), 'the thread must read in order');
assert.ok(fc.includes('Sam') && fc.includes('Dana'));
// A comment with no author still renders rather than saying "undefined".
assert.ok(!/undefined/.test(formatComments([{ body: 'anon' }])));

// {{comments}} resolves through renderBrief like any other token.
assert.ok(renderBrief('{{comments}}', { key: 'X', comments: [{ author: 'Sam', body: 'Hi' }] }).includes('Hi'));
assert.ok(/No comments/.test(renderBrief('{{comments}}', { key: 'X' })));

// ── Host project identity ────────────────────────────────────────────────────
// A PORT of workspacer's apps/desktop/src/renderer/src/lib/projectIdentity.ts
// (and projectKey.ts). Every case below was cross-checked by running both
// implementations over the same corpus, so a failure here means the two have
// drifted — and a drifted mark is worse than no mark: the same directory would
// carry two different identities inside one window.
assert.strictEqual(basenameOf('/home/me/work/api-gateway'), 'api-gateway');
assert.strictEqual(basenameOf('/home/me/work/api-gateway/'), 'api-gateway');
assert.strictEqual(basenameOf('C:\\Users\\me\\repo'), 'repo');
assert.strictEqual(basenameOf(''), '');

// Word initials, not the first two letters: sibling repos sharing a prefix must
// not both read AP.
assert.strictEqual(initialsOf('api-gateway'), 'AG');
assert.strictEqual(initialsOf('api-worker'), 'AW');
assert.strictEqual(initialsOf('work_spacer'), 'WS');
assert.strictEqual(initialsOf('my project'), 'MP');
assert.strictEqual(initialsOf('workSpacer'), 'WS', 'a camelCase word has a second word inside it');
assert.strictEqual(initialsOf('claudemon'), 'CL');
assert.strictEqual(initialsOf(''), '?');
assert.strictEqual(initialsOf('---'), '?');

assert.strictEqual(projectKey('C:\\work\\repo\\'), 'C:/work/repo');
assert.strictEqual(resolveProjectKey({ '/w/repo': {} }, '/w/repo/'), '/w/repo');

// NO configuration is the case that matters: an unconfigured project is still
// legible, which is why the mark is derived rather than looked up.
const derived = resolveProjectIdentity('/home/me/work/api-gateway');
assert.strictEqual(derived.label, 'api-gateway');
assert.strictEqual(derived.initials, 'AG');
assert.ok(PROJECT_PALETTE.includes(derived.color));
assert.strictEqual(derived.icon, undefined);
assert.strictEqual(derived.iconSrc, undefined);

// Pinned against the host's own output for these paths. Editing the palette or
// the FNV-1a hash on either side fails this — which is the point.
assert.strictEqual(resolveProjectIdentity('/w/api-gateway').color, '#fb923c');
assert.strictEqual(resolveProjectIdentity('/w/api-worker').color, '#c084fc');
assert.strictEqual(resolveProjectIdentity('/w/repo').color, '#6b8afd');

// Config overrides each part independently; a blank means unset, not "override
// with nothing".
const over = resolveProjectIdentity('/w/repo', {
  '/w/repo': { label: 'Platform API', icon: '🚀', color: '#ff0000' },
});
assert.strictEqual(over.label, 'Platform API');
assert.strictEqual(over.icon, '🚀');
assert.strictEqual(over.color, '#ff0000');
assert.strictEqual(over.initials, 'PA', 'initials follow the label, so renaming renames the mark');
const blank = resolveProjectIdentity('/w/repo', { '/w/repo': { label: '  ', icon: '', color: '' } });
assert.strictEqual(blank.label, 'repo');
assert.strictEqual(blank.icon, undefined);
assert.ok(PROJECT_PALETTE.includes(blank.color));

// Keyed the way the host keys it, so the pane and the app read one entry for one
// directory however the path was spelled.
assert.strictEqual(resolveProjectIdentity('/w/repo/', { '/w/repo': { label: 'Kept' } }).label, 'Kept');
assert.strictEqual(resolveProjectIdentity('\\w\\repo', { '/w/repo': { label: 'Kept' } }).label, 'Kept');
// Colour comes from the PATH, never the label: renaming must not recolour.
assert.strictEqual(
  resolveProjectIdentity('/w/repo', { '/w/repo': { label: 'Something Else' } }).color,
  resolveProjectIdentity('/w/repo').color,
);

// The one deliberate divergence from the host. A downloaded icon is served over
// workspacer-icon://, which is registered on Electron's DEFAULT session while a
// plugin pane's webview runs in the persist:browser partition — so that URL
// cannot resolve in this UI and would draw a broken image. It must degrade.
const cached = resolveProjectIdentity('/w/repo', { '/w/repo': { iconFile: 'abc123.png', icon: '🚀' } });
assert.strictEqual(cached.iconSrc, undefined, 'workspacer-icon:// never reaches a plugin webview');
assert.strictEqual(cached.icon, '🚀', 'a cached icon falls back to the configured emoji');
assert.ok(
  !JSON.stringify(resolveProjectIdentity('/w/repo', { '/w/repo': { iconFile: 'a b.png' } }))
    .includes('workspacer-icon'),
  'no path may put a workspacer-icon:// URL on the wire to a plugin webview',
);
// An http(s) favicon IS an ordinary subresource, so it is passed through — even
// where the host would have preferred its cached copy.
assert.strictEqual(
  resolveProjectIdentity('/w/repo', {
    '/w/repo': { favicon: 'https://x/icon.png', iconFile: 'abc.png' },
  }).iconSrc,
  'https://x/icon.png',
);
// …and nothing else is: a file:// or data: URL out of config must not become an
// <img src> in a plugin pane.
assert.strictEqual(
  resolveProjectIdentity('/w/repo', { '/w/repo': { favicon: 'file:///etc/passwd' } }).iconSrc,
  undefined,
);

// No directory (the Overview pane) means no mark at all, rather than a mark for
// the empty string.
assert.strictEqual(resolveProjectIdentity(''), null);
assert.strictEqual(resolveProjectIdentity(undefined), null);
// A malformed config costs the override, not the mark — config.yaml is
// hand-editable and a bad entry must not blank the header.
assert.strictEqual(resolveProjectIdentity('/w/repo', { '/w/repo': 'nonsense' }).label, 'repo');
assert.strictEqual(resolveProjectIdentity('/w/repo', 'nonsense').label, 'repo');

// ── newlyArrived ─────────────────────────────────────────────────────────────
const A = { key: 'A' }, B = { key: 'B' };
// The first successful poll BASELINES: without this, every app restart means a
// toast for each open ticket.
assert.deepStrictEqual(newlyArrived(null, [A, B]), []);
assert.deepStrictEqual(newlyArrived(new Set(['A']), [A, B]), [B]);
assert.deepStrictEqual(newlyArrived(new Set(['A', 'B']), [A, B]), []);
// A ticket leaving and returning is news again — it was reassigned to you.
assert.deepStrictEqual(newlyArrived(new Set(['B']), [A]), [A]);

console.log('ok — all Jira plugin helper tests passed');

// ── Host-held mappings (the collapse onto config.projects) ───────────────────
// The directory→prefix map was this plugin's private file. The host grew the
// concept ("scope": "project" settings, stored beside a project's identity), so
// the file becomes a fallback rather than the source of truth.
{
  const HOST = {
    '/w/hvms': { plugins: { 'djtouchette.jira': { prefix: 'hvms', jql: 'component = api' } } },
    '/w/other': { plugins: { 'someone.else': { prefix: 'NOPE' } } },  // another plugin's namespace
    '/w/plain': { label: 'No plugin settings at all' },
    '/w/blank': { plugins: { 'djtouchette.jira': { prefix: '   ' } } }, // set to nothing
  };
  const fromHost = projectsFromHostConfig(HOST, 'djtouchette.jira');
  assert.deepStrictEqual(fromHost, [{ dir: '/w/hvms', prefix: 'HVMS', jql: 'component = api' }],
    'only OUR namespace, only rows with a prefix, normalized like any other mapping');
  assert.deepStrictEqual(projectsFromHostConfig({}, 'djtouchette.jira'), []);
  assert.deepStrictEqual(projectsFromHostConfig(null, 'djtouchette.jira'), []);

  // Host wins where both describe the same directory: editing it on the shared
  // page has to actually change behaviour, not be shadowed by a file nobody
  // remembers writing.
  assert.deepStrictEqual(
    mergeProjectSources([{ dir: '/w/a', prefix: 'NEW' }], [{ dir: '/w/a', prefix: 'OLD' }]),
    [{ dir: '/w/a', prefix: 'NEW', jql: '' }],
  );
  // …and a legacy-only mapping keeps working, which is the whole point of not
  // deleting the file on upgrade.
  assert.deepStrictEqual(
    mergeProjectSources([], [{ dir: '/w/z', prefix: 'LEG' }]).map((e) => e.dir),
    ['/w/z'],
  );
  assert.deepStrictEqual(mergeProjectSources([], []), []);
}
