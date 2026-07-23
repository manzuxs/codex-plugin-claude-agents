import { spawn } from 'node:child_process';
import { collectSensitiveValues, redactText } from '../redact.mjs';

export const DEFAULT_CAPTURE_BYTES = 20 * 1024 * 1024;

export function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function appendWithLimit(current, chunk, label, maxBytes) {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeded ${maxBytes} bytes`);
  }
  return next;
}

/**
 * Run a local CLI without invoking a shell. Adapters own protocol parsing while
 * this supervisor owns process groups, cancellation, timeouts, capture limits,
 * and final output redaction.
 */
export async function superviseProcess({
  command,
  args = [],
  cwd,
  env,
  signal: abortSignal,
  timeoutMs,
  maxStdoutBytes = DEFAULT_CAPTURE_BYTES,
  maxStderrBytes = DEFAULT_CAPTURE_BYTES,
  onStdoutChunk,
  onStderrChunk,
  onSpawn,
} = {}) {
  if (!command) throw new Error('A runner command is required.');
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const secrets = collectSensitiveValues(env || {});
    onSpawn?.({ pid: child.pid, processGroupId: process.platform === 'win32' ? null : child.pid });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let failure;
    let forceKillTimer;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', onAbort);
    };
    const settleFailure = (error) => {
      if (settled) return;
      failure = error;
      settled = true;
      cleanup();
      terminateProcessTree(child, 'SIGTERM');
      reject(error);
    };
    const stopChild = (reason) => {
      if (settled) return;
      if (reason === 'cancelled') cancelled = true;
      if (reason === 'timeout') timedOut = true;
      terminateProcessTree(child, 'SIGTERM');
      if (!forceKillTimer) forceKillTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 3000).unref();
    };
    const onAbort = () => stopChild('cancelled');
    const timeout = setTimeout(() => stopChild('timeout'), Math.max(1, Number(timeoutMs) || 1));

    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      try {
        stdout = appendWithLimit(stdout, chunk, 'stdout', maxStdoutBytes);
        onStdoutChunk?.(chunk, { stop: stopChild });
      } catch (error) {
        settleFailure(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        stderr = appendWithLimit(stderr, chunk, 'stderr', maxStderrBytes);
        onStderrChunk?.(chunk);
      } catch (error) {
        settleFailure(error);
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to start runner CLI (${command}): ${error.message}`));
    });
    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal: closeSignal,
        stdout: redactText(stdout, secrets),
        stderr: redactText(stderr, secrets),
        cancelled,
        timedOut,
        failure,
      });
    });
  });
}
