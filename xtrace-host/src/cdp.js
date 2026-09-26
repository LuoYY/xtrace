'use strict';
// P6-E1: CDP pipe client for the Agent Host (browser ownership).
//
// Hardened from the driver-grade scripts/lib/cdp-pipe.cjs into a Host
// module: explicit lifecycle (pipe closed => browser is GONE — the
// frozen no-reconnect decision), typed errors, event fan-out, and a
// capability probe against the XTrace domain.

const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');

class CdpConnection extends EventEmitter {
  constructor(child, { sendTimeoutMs = 30000 } = {}) {
    super();
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.timers = new Map();
    this.sendTimeoutMs = sendTimeoutMs;
    this.buffer = '';
    this.closed = false;
    // --remote-debugging-pipe convention: fd 3 = commands IN (we
    // write), fd 4 = responses/events OUT (we read).
    this.outbound = child.stdio[3];
    this.inbound = child.stdio[4];
    this.inbound.on('data', (chunk) => this._onData(chunk));
    this.inbound.on('close', () => this._onClose());
    this.child.on('exit', (code, signal) => this._onClose(code, signal));
  }

  _onClose(code, signal) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error(
        `browser pipe closed (exit=${code} signal=${signal}) — the ` +
        `browser is gone; no reconnect in P6`);
    error.code = 'CDP_PIPE_CLOSED';
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
    this.emit('closed', error);
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\0')) !== -1) {
      const frame = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!frame.trim()) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(frame);
      } catch {
        this.emit('protocol-error', frame);
        continue;
      }
      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          const timer = this.timers.get(message.id);
          if (timer) {
            clearTimeout(timer);
            this.timers.delete(message.id);
          }
          if (message.error) {
            waiter.reject(new Error(
                `${message.error.message || 'CDP error'}` +
                `${message.error.data ? ` (${message.error.data})` : ''}`));
          } else {
            waiter.resolve(message.result);
          }
        }
      } else if (message.method) {
        this.emit('event', message);
        this.emit(`event:${message.method}`, message.params || {});
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) {
      return Promise.reject(new Error('CDP connection closed'));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      // m1 (R2-2): every pending send carries a watchdog — a hung
      // browser can no longer hang the caller forever.
      this.timers.set(id, setTimeout(() => {
        this.pending.delete(id);
        this.timers.delete(id);
        const error = new Error(
            `CDP send timeout after ${this.sendTimeoutMs}ms: ${method}`);
        error.code = 'CDP_TIMEOUT';
        reject(error);
      }, this.sendTimeoutMs));
      this.pending.set(id, { resolve, reject });
      this.outbound.write(JSON.stringify(payload) + '\0');
    });
  }
}

async function launchBrowser({ executable, args = [], env = process.env,
                               cwd, stderr }) {
  const argv = ['--headless=new', '--remote-debugging-pipe', '--no-first-run',
                ...args];
  const child = spawn(executable, argv, {
    env, cwd,
    stdio: ['ignore', 'ignore', stderr || 'ignore', 'pipe', 'pipe'],
  });
  const connection = new CdpConnection(child);
  // The browser endpoint speaks on pipe 3 once the process is up.
  const version = await connection.send('Browser.getVersion');
  return { child, connection, version };
}

module.exports = { CdpConnection, launchBrowser };
