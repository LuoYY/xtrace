// Shared CDP pipe transport for XTrace drivers (N0, review R6).
//
// Frame protocol: NUL-delimited JSON over fds 3/4 (remote-debugging-pipe).
// sessionId IS serialized — messages without it route to the browser
// session and never reach a page's agent.
'use strict';

class CdpPipe {
  constructor(child, { timeoutMs = 60000, onEvent } = {}) {
    this.child = child;
    this.id = 0;
    this.pending = new Map();
    this.timeoutMs = timeoutMs;
    this.onEvent = onEvent || null;
    this.fatal = null;
    let buffered = Buffer.alloc(0);
    child.stdio[4].on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      let boundary;
      while ((boundary = buffered.indexOf(0)) >= 0) {
        const raw = buffered.subarray(0, boundary).toString();
        buffered = buffered.subarray(boundary + 1);
        if (!raw) continue;
        let message;
        try { message = JSON.parse(raw); } catch { continue; }
        if (message.id !== undefined) {
          const request = this.pending.get(message.id);
          if (!request) continue;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) {
            request.reject(new Error(JSON.stringify(message.error)));
          } else {
            request.resolve(message.result);
          }
        } else if (this.onEvent) {
          this.onEvent(message);
        }
      }
    });
    const gone = () => {
      const error = new Error('browser exited before reply');
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
    };
    child.once('exit', gone);
    child.once('close', gone);
  }

  send(method, params = {}, sessionId) {
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const frame = sessionId === undefined
          ? { id, method, params }
          : { id, method, params, sessionId };
      this.child.stdio[3].write(JSON.stringify(frame) + '\0');
    });
  }
}

// Deterministic teardown: ask the browser to close, then escalate. The
// plain `await exit` pattern hangs when the browser is wedged, and a bare
// SIGTERM can preempt a clean shutdown (review R6/R5 cleanup findings).
async function closeBrowser(child, { graceMs = 8000, killMs = 8000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const exited = new Promise(resolve =>
      child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');  // Chrome treats SIGTERM as a graceful shutdown
  let outcome = await Promise.race([
    exited,
    new Promise(resolve => setTimeout(() => resolve(null), graceMs)),
  ]);
  if (!outcome) {
    child.kill('SIGKILL');
    outcome = await Promise.race([
      exited,
      new Promise(resolve => setTimeout(() => resolve({ code: null, signal: 'SIGKILL-timeout' }), killMs)),
    ]);
  }
  return outcome;
}

module.exports = { CdpPipe, closeBrowser };
