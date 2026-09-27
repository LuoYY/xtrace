'use strict';
// M3-E1: host-exec executors (PD1). run_node + run_python — NO shell,
// direct spawn of the interpreter with explicit argv. Every execution
// carries a timeout, an output byte cap, and Broker-mediated
// cancellation (a cancelled child is KILLED and the kill is audited).
// The tools never run without the __action payload the broker gate
// policy-evaluated and disclosed to the human.

const { spawn } = require('node:child_process');
const { TIERS } = require('./broker');

const DEFAULT_EXEC_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 65536;
const MAX_TIMEOUT_MS = 120000;   // R1-5: caller cannot disable the watchdog
// R1-5: children get a MINIMAL env (PATH/HOME/LANG) — the full
// process.env (secrets included) never silently leaks into host-exec
// children. The disclosure is explicit in each result.
function childEnv() {
  const out = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'LC_ALL']) {
    if (process.env[key] !== undefined) {
      out[key] = process.env[key];
    }
  }
  return out;
}

function createExecutors({ workspace }) {
  function makeExecutor(name, interpreter, defaultArgs) {
    return {
      name,
      tier: TIERS.HOST_EXEC,
      input: { argv: 'string[]', script_path: 'string?',
               timeout_ms: 'int?', max_output_bytes: 'int?' },
      output: 'exit_code / output (bounded) / timed_out / cancelled',
      sideEffects: 'spawns a host process with the exact audited argv',
      run: async (args, context) => {
        const action = args && args.__action;
        if (!action || !Array.isArray(action.argv) || !action.argv.length) {
          throw new Error('host-exec: missing audited argv payload');
        }
        const argv = [...defaultArgs, ...action.argv.map(String)];
        const timeoutMs = Math.min(
            Number(args.timeout_ms) > 0 ? Number(args.timeout_ms)
                                        : DEFAULT_EXEC_TIMEOUT_MS,
            MAX_TIMEOUT_MS);
        const maxBytes = Number(args.max_output_bytes) > 0
            ? Math.min(Number(args.max_output_bytes), MAX_OUTPUT_BYTES)
            : MAX_OUTPUT_BYTES;
        return await new Promise((resolve) => {
          const child = spawn(interpreter, argv, {
            cwd: workspace.root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: childEnv(),   // R1-5: allowlisted, not process.env
            shell: false,   // PD1: NEVER a shell
          });
          let out = '';
          let outBytes = 0;
          let truncated = false;
          let settled = false;
          const cap = (chunk) => {
            outBytes += chunk.length;
            if (out.length < maxBytes) {
              out += chunk.toString('utf8', 0,
                  Math.min(chunk.length, maxBytes - out.length));
            } else {
              truncated = true;
            }
          };
          child.stdout.on('data', cap);
          child.stderr.on('data', cap);
          const finish = (patch) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({
              exit_code: patch.exit_code,
              output: out.slice(0, maxBytes),
              output_bytes: outBytes,
              truncated,
              timed_out: Boolean(patch.timed_out),
              cancelled: Boolean(patch.cancelled),
              pid: child.pid,
            });
          };
          const timer = setTimeout(() => {
            // timeout kills the child — audited via timed_out
            child.kill('SIGKILL');
            finish({ exit_code: null, timed_out: true });
          }, timeoutMs);
          // Broker-mediated cancellation (PD1): the Broker owns a kill
          // handle per RUNNING execution; cancelExecution() fires it and
          // the child is REALLY killed + the result records cancelled.
          if (context && typeof context.onKill === 'function') {
            context.onKill(() => {
              child.kill('SIGKILL');
              finish({ exit_code: null, cancelled: true });
            });
          }

          child.on('error', (e) => {
            if (!settled) {
              finish({ exit_code: -1 });
              out += `\n[spawn-error] ${e.message}`;
            }
          });
          child.on('close', (code) => finish({ exit_code: code }));
        });
      },
    };
  }

  return [
    makeExecutor('run_node', process.execPath, []),
    makeExecutor('run_python', 'python3', []),
  ];
}

module.exports = { createExecutors, DEFAULT_EXEC_TIMEOUT_MS,
                   MAX_OUTPUT_BYTES };
