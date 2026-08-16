// wks.js — a zero-dependency hub-bus client for a sidecar (Node >=22, built-in WebSocket).
// Vendor this file next to server.js and require it: const { connect } = require('./wks.js');
const fs = require('fs');
const path = require('path');

function readToken() {
  if (process.env.HUB_TOKEN) return process.env.HUB_TOKEN;
  if (process.env.WKS_BUS_TOKEN) return process.env.WKS_BUS_TOKEN;
  try {
    return fs.readFileSync(path.join(__dirname, '.bus-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '.settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

// connect() -> { ready, connected, call, publish, on, onStatus, settings } — mirrors window.workspacer.
//
// Requires the global WebSocket (Node >= 22). On older Nodes this returns a
// DEAD client instead of throwing at boot: calls reject, no events arrive,
// settings still load — so a sidecar can keep serving its pane degraded
// rather than crash-looping with "exit status 1" and no explanation.
function connect(opts = {}) {
  if (typeof WebSocket === 'undefined') {
    return {
      ready: Promise.resolve(),
      connected: false,
      busAvailable: false,
      call: async (method) => {
        throw new Error(
          'hub bus unavailable: Node ' + process.versions.node +
          ' has no built-in WebSocket (need >= 22) — cannot call ' + method,
        );
      },
      publish: () => {},
      provide: () => {},
      on: () => {},
      onStatus: (cb) => { try { cb(false); } catch {} },
      settings: readSettings(),
    };
  }
  const url = opts.url || 'ws://127.0.0.1:7895/bus';
  const source = opts.source || 'sidecar';
  const listeners = new Map(); // type -> Set(cb)
  const pending = new Map(); // id -> { resolve, reject }
  const providers = new Map(); // method -> async handler(params) => result
  const statusListeners = new Set(); // cb(connected)
  let ws = null;
  let seq = 1;
  let connected = false;
  let settings = readSettings();
  let markReady;
  const ready = new Promise((r) => {
    markReady = r;
  });

  const deliver = (type, data, event) => {
    for (const key of [type, '*']) {
      const set = listeners.get(key);
      if (set) for (const cb of set) try { cb(data, event); } catch {}
    }
  };

  const fireStatus = (c) => {
    for (const cb of statusListeners) try { cb(c); } catch {}
  };

  const open = () => {
    ws = new WebSocket(`${url}?token=${encodeURIComponent(readToken())}`);
    ws.addEventListener('open', () => {
      connected = true;
      ws.send(JSON.stringify({ op: 'subscribe', topics: ['*'] }));
      if (providers.size) {
        ws.send(JSON.stringify({ op: 'register', methods: [...providers.keys()] }));
      }
      markReady();
      fireStatus(true);
    });
    ws.addEventListener('message', (ev) => {
      let f;
      try {
        f = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (f.op === 'call' && f.method) {
        // Inbound RPC: the hub routed a caller's capability call here because
        // we registered the method (manifest `provides`). Reply on the SAME id
        // (the router's global correlation id).
        const handler = providers.get(f.method);
        const reply = (frame) => { try { ws.send(JSON.stringify(frame)); } catch {} };
        if (!handler) {
          reply({ op: 'error', id: f.id, error: 'no handler for ' + f.method });
          return;
        }
        Promise.resolve()
          .then(() => handler(f.params))
          .then((result) => reply({ op: 'result', id: f.id, result: result === undefined ? null : result }))
          .catch((err) => reply({ op: 'error', id: f.id, error: String((err && err.message) || err) }));
        return;
      }
      if (f.op === 'event' && f.event) {
        if (f.event.type === 'plugin.settings.changed' && f.event.data) settings = f.event.data;
        deliver(f.event.type, f.event.data, f.event);
      } else if (f.op === 'result' && pending.has(f.id)) {
        pending.get(f.id).resolve(f.result);
        pending.delete(f.id);
      } else if (f.op === 'error' && pending.has(f.id)) {
        pending.get(f.id).reject(new Error(f.error || 'call failed'));
        pending.delete(f.id);
      }
    });
    ws.addEventListener('close', () => {
      connected = false;
      fireStatus(false);
      setTimeout(open, 1000); // reconnect loop
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {}
    });
  };
  open();

  return {
    ready,
    busAvailable: true,
    get connected() {
      return connected;
    },
    get settings() {
      return settings;
    },
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = 'c' + seq++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ op: 'call', id, method, params }));
      });
    },
    publish(type, data = {}) {
      ws.send(JSON.stringify({ op: 'publish', event: { type, source, data } }));
    },
    // provide(method, handler) — answer a bus method declared in the manifest
    // `provides` (and, via a manifest `tools` entry, exposed to agents as an
    // MCP tool through the workspacer facade). handler(params) may return a
    // value or a Promise; a throw becomes the caller's error reply.
    // Registration is sent now and re-sent on every reconnect; the hub drops
    // methods the consented grant doesn't cover. A provider slot frees when
    // the connection drops (there is no unregister op).
    provide(method, handler) {
      providers.set(method, handler);
      if (connected) {
        try { ws.send(JSON.stringify({ op: 'register', methods: [method] })); } catch {}
      }
    },
    on(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
      return () => listeners.get(type)?.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
  };
}

module.exports = { connect };
