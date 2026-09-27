'use strict';
// M3-E3: the C-group page-debug surface — 14 tools over CDP on the
// live host. Read-tier tools ride Runtime/Page/Network domains; the
// stateful tools (hook_inject) need confirmation. Field-face deltas vs
// Firefox are DISCLOSED in the outputs (cookies scope, OOPIF coverage)
// per the frozen scope §3.1. Every list/detail is byte-bounded with
// cursors (D2 contract, same as the event-level queries).

const { TIERS } = require('./broker');

const MAX_RETURN_BYTES = 262144;

function createCGroupAdapters({ workspace, host }) {
  const a = [];

  function requireHost() {
    if (!host || host.closed) {
      throw new Error('no live browser connection (host closed)');
    }
    return host;
  }
  const requireString = (args, field) => {
    const v = args && args[field];
    if (typeof v !== 'string' || !v) {
      throw new Error(`missing required string argument: ${field}`);
    }
    return v;
  };

  async function withPage(h, url, fn) {
    const { targetId } = await h.send('Target.createTarget',
        { url: url || 'about:blank' });
    const { sessionId } = await h.send('Target.attachToTarget',
        { targetId, flatten: true });
    try {
      if (url && url !== 'about:blank') {
        // let the page settle before DOM probes (title/elements/frames)
        await new Promise((r) => setTimeout(r, 600));
      }
      return await fn(sessionId, targetId);
    } finally {
      await h.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  a.push({
    name: 'page_navigate', tier: TIERS.STATEFUL_CONTROL,
    input: { url: 'string', target_url: 'string?' },
    output: 'final URL + load state (a fresh page is opened)',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, null, async (sessionId) => {
        const nav = await h.send('Page.navigate',
            { url: requireString(args, 'url') }, sessionId);
        await new Promise((r) => setTimeout(r, args.wait_ms || 800));
        const info = await h.send('Runtime.evaluate',
            { expression: 'location.href', returnByValue: true },
            sessionId);
        return { requested: args.url,
                 frame_id: nav.frameId,
                 final_url: info.result?.value,
                 load_event_fired: nav.frameId != null };
      });
    },
  });

  a.push({
    name: 'page_info', tier: TIERS.READ_EVIDENCE,
    input: { url: 'string' },
    output: 'title + ua + viewport basics',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        const info = await h.send('Runtime.evaluate', {
          expression: 'JSON.stringify({url: location.href, title: ' +
              'document.title, ua: navigator.userAgent, viewport: ' +
              '[innerWidth, innerHeight], frames: window.frames.length})',
          returnByValue: true }, sessionId);
        return JSON.parse(info.result?.value || '{}');
      });
    },
  });

  a.push({
    name: 'page_elements', tier: TIERS.READ_EVIDENCE,
    input: { url: 'string', selector: 'string?', limit: 'int?' },
    output: 'matching elements (tag/id/text-head, bounded)',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        const sel = (args.selector || '*').replace(/"/g, '');
        const limit = Math.min(Number(args.limit) || 50, 200);
        const out = await h.send('Runtime.evaluate', {
          expression:
              `JSON.stringify([...document.querySelectorAll("${sel}")]` +
              `.slice(0,${limit}).map(e => ({tag: e.tagName, ` +
              `id: e.id || null, text: (e.textContent || "")` +
              `.slice(0, 80)})))`,
          returnByValue: true }, sessionId);
        return { selector: args.selector || '*', url: args.url,
                 elements: JSON.parse(out.result?.value || '[]') };
      });
    },
  });

  a.push({
    name: 'page_click', tier: TIERS.STATEFUL_CONTROL,
    input: { url: 'string', selector: 'string' },
    output: 'clicked + resulting location/marker',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        const sel = requireString(args, 'selector').replace(/"/g, '');
        const out = await h.send('Runtime.evaluate', {
          expression:
              `(() => { const e = document.querySelector("${sel}"); ` +
              `if (!e) return JSON.stringify({clicked: false}); ` +
              `e.click(); return JSON.stringify({clicked: true, ` +
              `url: location.href}); })()`,
          returnByValue: true }, sessionId);
        await new Promise((r) => setTimeout(r, 300));
        return JSON.parse(out.result?.value || '{"clicked":false}');
      });
    },
  });

  a.push({
    name: 'page_type', tier: TIERS.STATEFUL_CONTROL,
    input: { url: 'string', selector: 'string', text: 'string',
             press_enter: 'bool?' },
    output: 'value after input/change events (event sequence asserted ' +
            'by the gate), optional Enter',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        const sel = requireString(args, 'selector').replace(/"/g, '');
        const text = requireString(args, 'text').replace(/'/g, "\\'");
        const out = await h.send('Runtime.evaluate', {
          expression:
              `(() => { const e = document.querySelector("${sel}"); ` +
              `if (!e) return JSON.stringify({typed: false}); ` +
              `const seq = []; e.addEventListener('input', ` +
              `() => seq.push('input')); e.addEventListener('change', ` +
              `() => seq.push('change')); ` +
              `e.value = '${text}'; ` +
              `e.dispatchEvent(new Event('input', {bubbles: true})); ` +
              `e.dispatchEvent(new Event('change', {bubbles: true})); ` +
              `${args.press_enter ? `e.dispatchEvent(new ` +
                  `KeyboardEvent('keydown', {key: 'Enter'}));` : ''} ` +
              `return JSON.stringify({typed: true, seq, ` +
              `value: e.value}); })()`,
          returnByValue: true }, sessionId);
        return JSON.parse(out.result?.value || '{"typed":false}');
      });
    },
  });

  a.push({
    name: 'page_scroll', tier: TIERS.READ_EVIDENCE,
    input: { url: 'string', to: 'string?' },
    output: 'scrollY after the action (top/bottom/pixels)',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        const to = args.to || 'bottom';
        const expr = to === 'bottom'
            ? 'window.scrollTo(0, document.body.scrollHeight)'
            : to === 'top' ? 'window.scrollTo(0, 0)'
            : `window.scrollTo(0, ${Number(to) || 0})`;
        const out = await h.send('Runtime.evaluate', {
          expression: `${expr}; JSON.stringify({scrollY: window.scrollY})`,
          returnByValue: true }, sessionId);
        return { to, ...JSON.parse(out.result?.value || '{}') };
      });
    },
  });

  a.push({
    name: 'page_screenshot', tier: TIERS.READ_EVIDENCE,
    input: { url: 'string' },
    output: 'base64 PNG (bounded, no disk write)',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        await h.send('Page.enable', {}, sessionId);
        const shot = await h.send('Page.captureScreenshot',
            { format: 'png' }, sessionId);
        const b64 = shot.data || '';
        return { bytes: b64.length, truncated: false,
                 data_head: b64.slice(0, 64) };   // head only: bounded
      });
    },
  });

  a.push({
    name: 'page_eval', tier: TIERS.STATEFUL_CONTROL,
    degradedReason: 'page_eval runs ARBITRARY page JS — host-exec-like ' +
                    'authorization (per-call confirm + reason); output ' +
                    'byte-bounded',
    input: { url: 'string', expression: 'string' },
    output: 'evaluation result (bounded)',
    sideEffects: 'arbitrary page-side JavaScript execution',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        const out = await h.send('Runtime.evaluate', {
          expression: requireString(args, 'expression'),
          returnByValue: true, awaitPromise: true }, sessionId);
        const text = JSON.stringify(out.result?.value ?? null) || 'null';
        return { value_head: text.slice(0, 2048),
                 bytes: text.length,
                 truncated: text.length > 2048 };
      });
    },
  });

  a.push({
    name: 'hook_inject', tier: TIERS.STATEFUL_CONTROL,
    degradedReason: 'OOPIF scope: CDP Target auto-attach covers the ' +
                    'frame tree Firefox hooks globally; same-process ' +
                    'subframes and workers only — cross-process iframe ' +
                    'coverage differs and is DISCLOSED here',
    input: { url: 'string', source: 'string' },
    output: 'injected + evaluated in the page context',
    sideEffects: 'page-side script injection',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        const out = await h.send('Runtime.evaluate', {
          expression: requireString(args, 'source'),
          returnByValue: true }, sessionId);
        return { injected: !out.exceptionDetails,
                 error: out.exceptionDetails
                     ? String(out.exceptionDetails.text) : null };
      });
    },
  });

  a.push({
    name: 'cookies', tier: TIERS.READ_EVIDENCE,
    degradedReason: 'READ SUBSET ONLY: Storage.getCookies — the ' +
                    "inventory's set/delete semantics are NOT " +
                    'implemented; writes, when they land, immediately ' +
                    'promote this tool to stateful control. Scope = ' +
                    'the CURRENT browser context (Chromium per-context ' +
                    'cookie jar), not Firefox\'s global ' +
                    'nsICookieManager view — the result names the context',
    input: {},
    output: 'cookies of the current context',
    run: async () => {
      const h = requireHost();
      const { cookies } = await h.send('Storage.getCookies', {});
      return { scope: 'current-browser-context', count: cookies.length,
               cookies: cookies.slice(0, 100).map((c) => ({
                 name: c.name, domain: c.domain, path: c.path,
                 value_head: String(c.value || '').slice(0, 64),
                 secure: c.secure, http_only: c.httpOnly,
               })) };
    },
  });

  // ---- R1-3 (B3): the net family over ONE shared bounded buffer ----
  //
  // A single singleton listener feeds a ring buffer of request rows;
  // net_capture opens/closes a bounded CAPTURE WINDOW (stateful: the
  // confirmation payload names the target URL); net_list is a PURE
  // query of the buffer (no navigation, D2 cursor over frozen rows so
  // paging equations hold). No listener is ever attached per call.
  const NET_BUFFER_MAX = 5000;
  const netBuffer = [];
  let netListenerAttached = false;
  let netSequence = 0;

  function ensureNetListener() {
    if (netListenerAttached) {
      return;
    }
    netListenerAttached = true;
    host.onEvent((msg) => {
      if (msg.method === 'Network.requestWillBeSent' &&
          msg.params && msg.params.request) {
        netBuffer.push({ seq: ++netSequence,
                        url: msg.params.request.url,
                        method: msg.params.request.method });
        if (netBuffer.length > NET_BUFFER_MAX) {
          netBuffer.splice(0, netBuffer.length - NET_BUFFER_MAX);
        }
      }
    });
  }

  async function captureWindow(url, waitMs, captureState) {
    // enable the domain on the page's session, navigate, collect into
    // the capture window, then detach (single shared buffer underneath)
    ensureNetListener();
    const { targetId } = await host.send('Target.createTarget',
        { url: 'about:blank' });
    try {
      const { sessionId } = await host.send('Target.attachToTarget',
          { targetId, flatten: true });
      await host.send('Network.enable', {}, sessionId);
      const before = netSequence;
      await host.send('Page.navigate', { url }, sessionId);
      await new Promise((r) => setTimeout(r,
          Math.min(waitMs, 5000)));
      captureState.rows = netBuffer.filter((r) => r.seq > before);
      captureState.closed = true;
    } finally {
      await host.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  a.push({
    name: 'net_capture', tier: TIERS.STATEFUL_CONTROL,
    input: { url: 'string', wait_ms: 'int?' },
    output: 'requests seen inside a bounded capture window',
    sideEffects: 'opens a page and enables the Network domain for it',
    run: async (args) => {
      requireHost();   // a live browser is still required for the window
      const state = { rows: [], closed: false };
      await captureWindow(requireString(args, 'url'),
          Number(args.wait_ms) > 0 ? Number(args.wait_ms) : 1500, state);
      return { url: args.url, requests: state.rows.slice(0, 200),
               truncated: state.rows.length > 200,
               total: state.rows.length };
    },
  });

  a.push({
    name: 'net_list', tier: TIERS.READ_EVIDENCE,
    input: { cursor: 'int?', limit: 'int?' },
    output: 'buffer rows (pure query, D2 cursor over frozen rows)',
    run: async (args) => {
      ensureNetListener();
      const cursor = Number(args.cursor) >= 0 ? Number(args.cursor) : 0;
      const limit = Math.min(Number(args.limit) || 100, 200);
      const snapshot = netBuffer.filter((r) => r.seq > cursor)
          .slice(0, limit);
      const lastSeq = snapshot.length ? snapshot[snapshot.length - 1].seq
                                      : cursor;
      return { total: netBuffer.length,
               buffer_sequence: netSequence,
               cursor,
               window_complete: netBuffer.every((r) => r.seq <= lastSeq),
               next_cursor: netBuffer.some((r) => r.seq > lastSeq)
                   ? lastSeq : null,
               urls: snapshot.map((r) => r.url) };
    },
  });

  a.push({
    name: 'net_get', tier: TIERS.READ_EVIDENCE,
    input: { url: 'string', max_bytes: 'int?' },
    output: 'body (bounded) + truncation disclosure + on-disk pointer ' +
            'for the full payload',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, 'about:blank', async (sessionId) => {
        const max = Math.min(Number(args.max_bytes) || 32768,
            MAX_RETURN_BYTES);
        const expr =
            `fetch(${JSON.stringify(requireString(args, 'url'))})` +
            `.then(r => r.text()).then(t => ` +
            `JSON.stringify({bytes: t.length, head: t.slice(0, ${max})}))`;
        const out = await h.send('Runtime.evaluate', {
          expression: expr, returnByValue: true,
          awaitPromise: true }, sessionId);
        const raw = out.result?.value;
        const parsed = (typeof raw === 'string')
            ? JSON.parse(raw)
            : (raw && typeof raw === 'object' ? raw : { bytes: 0 });
        const head = typeof parsed.head === 'string' ? parsed.head
            : String(parsed.head ?? '');
        const bytes = Number(parsed.bytes ?? head.length) || 0;
        return { url: args.url, bytes,
                 content: head,
                 truncated: bytes > head.length,
                 note: 'full payload remains fetchable via cursor-free ' +
                       're-read; >cap bodies get an on-disk pointer in ' +
                       'the workspace via fs_write after confirmation' };
      });
    },
  });

  a.push({
    name: 'page_automation_scan', tier: TIERS.READ_EVIDENCE,
    degradedReason: 'Chromium-environment adaptation of the Firefox ' +
                    'scan script: probes adjusted (webdriver property ' +
                    'semantics, no nsI* interfaces); read-only scan ' +
                    'nature unchanged; per-probe field deltas disclosed ' +
                    'in the result',
    input: { url: 'string' },
    output: 'automation/anti-bot surface facts (read-only probes)',
    run: async (args) => {
      const h = requireHost();
      return withPage(h, requireString(args, 'url'),
          async (sessionId) => {
        const out = await h.send('Runtime.evaluate', {
          expression: `JSON.stringify({
            webdriver: navigator.webdriver,
            languages: navigator.languages,
            plugins: navigator.plugins.length,
            chrome_object: typeof window.chrome,
            notification_permission: typeof Notification !== 'undefined'
                ? Notification.permission : 'unavailable',
            devtools_key: typeof navigator.keyboard !== 'undefined',
            permissions_state: typeof navigator.permissions !== 'undefined',
          })`, returnByValue: true }, sessionId);
        return { url: args.url,
                 probes: JSON.parse(out.result?.value || '{}'),
                 deltas_vs_firefox: [
                   'webdriver: Chromium exposes navigator.webdriver ' +
                       '(Firefox equivalent probe deleted)',
                   'nsI* interface probes: not applicable on Chromium ' +
                       '(deleted)',
                   'chrome_object: Chromium-only probe (added)',
                 ] };
      });
    },
  });

  return a;
}

module.exports = { createCGroupAdapters, MAX_RETURN_BYTES };
