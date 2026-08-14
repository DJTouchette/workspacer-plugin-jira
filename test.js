#!/usr/bin/env node
// Static tests for the Jira plugin's pure helpers (run: node test.js).
// server.js exports these and only starts the sidecar when run directly.
const assert = require('assert');
const {
  adfToText, normalize, briefFor, resolveConf, isConfigured, newlyArrived, DEFAULT_JQL,
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
