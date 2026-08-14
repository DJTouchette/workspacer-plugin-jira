#!/usr/bin/env node
/**
 * Renders the pane and the widget against fixture state, in a DOM shim, and
 * asserts each state produces sane HTML without throwing.
 *
 * Both UI scripts are browser IIFEs with no exports, so this evaluates their
 * <script> bodies under stubs for the handful of globals they touch (location,
 * document, fetch, timers). That keeps the UI files free of any test-only seam
 * while still exercising the real render paths — which is where the risk is,
 * since every row is string-built HTML.
 *
 * Run: node test-ui.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const mk = (key, summary, type, status, cat, priority, days) => ({
  key, summary, type, status, statusCategory: cat, priority,
  updated: iso(days), description: 'body',
  url: 'https://acme.atlassian.net/browse/' + key,
});

const ISSUES = [
  mk('PLAT-142', 'Login flakes on Safari', 'Bug', 'In Review', 'indeterminate', 'Highest', 0.02),
  mk('PLAT-98', 'Add retry to the webhook sender', 'Task', 'In Progress', 'indeterminate', 'High', 0.3),
  mk('PLAT-201', 'Export the audit log as CSV', 'Story', 'To Do', 'new', 'Medium', 1),
  mk('PLAT-55', 'Billing reconciliation', 'Epic', 'To Do', 'new', 'Highest', 9),
  mk('PLAT-12', 'Fix onboarding typo', 'Bug', 'Done', 'done', 'Lowest', 21),
];

const SCENES = {
  full:         { configured: true, error: '', updatedAt: Date.now() - 12e4, issues: ISSUES },
  unconfigured: { configured: false, error: '', updatedAt: 0, issues: [] },
  empty:        { configured: true, error: '', updatedAt: Date.now(), issues: [] },
  authError:    { configured: true, error: 'Jira 401 Unauthorized', updatedAt: Date.now(), issues: [] },
  softError:    { configured: true, error: 'Jira 500 Server Error', updatedAt: Date.now(), issues: ISSUES.slice(0, 1) },
  // Every optional field absent — Jira issues routinely lack priority, type or
  // an assignee, and a row that throws on one blanks the whole pane.
  sparse:       { configured: true, error: '', updatedAt: Date.now(), issues: [
                    { key: 'X-1', summary: '', statusCategory: '', url: 'https://x/browse/X-1' } ] },
  // A status category Jira invents that this UI has no group for must still
  // render, under "Other", rather than silently dropping the ticket.
  unknownCat:   { configured: true, error: '', updatedAt: Date.now(), issues: [
                    mk('X-2', 'Odd category', 'Task', 'Blocked', 'blocked-by-vendor', 'High', 1) ] },
};

/** Evaluate a UI file's <script> under a minimal DOM, returning render hooks. */
function mount(file, { cwd = '/home/u/proj', width = 460 } = {}) {
  const html = fs.readFileSync(path.join(__dirname, 'ui', file), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  const nodes = new Map();
  const mkNode = () => ({
    innerHTML: '', textContent: '', style: {}, dataset: {}, className: '',
    addEventListener() {}, querySelector: () => null, closest: () => null,
  });
  for (const id of ['main', 'toast', 'tally', 'freshness', 'refresh', 'wrap']) {
    nodes.set(id, mkNode());
  }

  const document = {
    getElementById: (id) => nodes.get(id) ?? null,
    querySelector: () => null,
    addEventListener() {},
  };
  const sandbox = {
    document,
    location: { search: cwd ? '?cwd=' + encodeURIComponent(cwd) : '' },
    URLSearchParams,
    fetch: () => Promise.reject(new Error('no network in tests')),
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    Date,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { sandbox, nodes };
}

// ── Pane ─────────────────────────────────────────────────────────────────────
for (const [name, state] of Object.entries(SCENES)) {
  const { sandbox, nodes } = mount('index.html');
  assert.doesNotThrow(() => sandbox.render(state), name + ': render threw');
  const html = nodes.get('main').innerHTML;

  assert.ok(html.length > 50, name + ': rendered almost nothing');
  assert.ok(!/undefined|\[object Object\]|NaN/.test(html), name + ': leaked a placeholder value');

  if (name === 'unconfigured') {
    assert.ok(/Connect your Jira/.test(html), 'unconfigured must explain setup');
    assert.ok(/__WKS_SECRET__/.test(html), 'unconfigured should say how the token is stored');
  }
  if (name === 'full') {
    for (const i of ISSUES) {
      assert.ok(html.includes(i.key), 'full: ' + i.key + ' missing');
    }
    assert.ok(/IN PROGRESS|In progress/i.test(html), 'full: missing the In progress group');
    // The done ticket is present but visibly demoted.
    assert.ok(/is-done/.test(html), 'full: a done issue must render demoted');
    // The status pill must not repeat its own group heading.
    assert.ok(!/class="status[^"]*">To Do</.test(html),
      'full: a "To Do" pill under a TO DO heading is noise and must be suppressed');
    // …but a status the heading did NOT say is exactly the useful half.
    assert.ok(/In Review/.test(html), 'full: an informative status must survive');
    // Priority text only where it changes what you would pick up.
    assert.ok(/prio-text[^"]*">Highest</.test(html), 'full: Highest must be spelled out');
    assert.ok(!/prio-text[^"]*">Medium</.test(html), 'full: Medium is the dot\'s job, not text');
    assert.ok(html.includes('5 open') || nodes.get('tally').textContent === '4 open',
      'full: the tally counts open work');
  }
  if (name === 'authError') {
    assert.ok(/rejected the credentials/.test(html), 'a 401 must be translated, not echoed raw');
    assert.ok(!/Nothing in your queue/.test(html),
      'a failed fetch must not claim the queue is empty — we did not read it');
  }
  if (name === 'softError') {
    assert.ok(/PLAT-142/.test(html), 'a transient error must keep the last good list on screen');
  }
  if (name === 'empty') {
    assert.ok(/Nothing in your queue/.test(html), 'a successful empty poll says so');
  }
  if (name === 'unknownCat') {
    assert.ok(/X-2/.test(html), 'an unknown status category must not drop the ticket');
    assert.ok(/Other/.test(html), 'an unknown status category needs a home');
  }
}

// The tally counts OPEN work: a queue that is mostly shipped is not a busy queue.
{
  const { sandbox, nodes } = mount('index.html');
  sandbox.render(SCENES.full);
  assert.strictEqual(nodes.get('tally').textContent, '4 open',
    'the header must count open tickets, not every row');
}

// Without a project the action is disabled and SAYS why, once, rather than
// silently doing nothing per row.
{
  const { sandbox, nodes } = mount('index.html', { cwd: '' });
  sandbox.render(SCENES.full);
  const html = nodes.get('main').innerHTML;
  assert.ok(/no project/i.test(html), 'no-cwd must explain why Start agent is unavailable');
  assert.ok(/<button class="start"[^>]*disabled/.test(html), 'no-cwd must disable the action');
}

// ── Widget ───────────────────────────────────────────────────────────────────
for (const [name, state] of Object.entries(SCENES)) {
  const { sandbox, nodes } = mount('widget.html');
  assert.doesNotThrow(() => sandbox.render(state), 'widget ' + name + ': render threw');
  const html = nodes.get('wrap').innerHTML;
  assert.ok(html.length > 10, 'widget ' + name + ': rendered almost nothing');
  assert.ok(!/undefined|\[object Object\]|NaN/.test(html), 'widget ' + name + ': leaked a placeholder');
}
{
  const { sandbox, nodes } = mount('widget.html');
  sandbox.render(SCENES.full);
  const html = nodes.get('wrap').innerHTML;
  // Done work is not queue: the tile's headline number is what is still open.
  assert.ok(/>4</.test(html), 'the widget count must exclude done tickets');
  assert.ok(/2<\/b> in progress/.test(html), 'the widget should say how many are moving');
  assert.ok(!/PLAT-12/.test(html), 'a done ticket does not belong on the queue tile');
}
{
  const { sandbox, nodes } = mount('widget.html');
  sandbox.render(SCENES.empty);
  assert.ok(/Queue clear/.test(nodes.get('wrap').innerHTML), 'an empty queue reads as clear, not blank');
}

console.log('ok — pane + widget render cleanly across ' + Object.keys(SCENES).length + ' states');
