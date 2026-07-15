import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30_000;
const lockSignal = new Int32Array(new SharedArrayBuffer(4));

function atomicWrite(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function withFileLock(filePath, callback) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out locking ${path.basename(filePath)}`);
      Atomics.wait(lockSignal, 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export class JobStore {
  constructor(dataRoot) {
    this.root = path.join(dataRoot, 'jobs');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  newId() {
    return `claude-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  dir(jobId) {
    if (!/^claude-[a-zA-Z0-9-]+$/.test(jobId)) throw new Error(`Invalid job id: ${jobId}`);
    return path.join(this.root, jobId);
  }

  create(request) {
    const jobId = this.newId();
    const dir = this.dir(jobId);
    fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
    atomicWrite(path.join(dir, 'request.json'), request);
    const meta = {
      jobId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      agent: request.agent,
      cwd: request.cwd,
      planSha256: request.planSha256 || null,
      progressRevision: 0,
      phase: 'starting',
      elapsedMs: 0,
      turnsObserved: 0,
      lastActivityAt: null,
      lastTool: null,
      lastToolSummary: null,
      verificationState: 'pending',
    };
    atomicWrite(path.join(dir, 'meta.json'), meta);
    return meta;
  }

  readJson(jobId, name) {
    const filePath = path.join(this.dir(jobId), name);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  updateMeta(jobId, updater) {
    const filePath = path.join(this.dir(jobId), 'meta.json');
    return withFileLock(filePath, () => {
      const current = this.readJson(jobId, 'meta.json') || { jobId };
      const next = updater(current);
      atomicWrite(filePath, next);
      return next;
    });
  }

  writeMeta(jobId, patch) {
    return this.updateMeta(jobId, (current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }));
  }

  writeResult(jobId, result) {
    atomicWrite(path.join(this.dir(jobId), 'result.json'), result);
  }

  writeProgress(jobId, patch) {
    return this.updateMeta(jobId, (current) => {
      const visibleKeys = ['phase', 'turnsObserved', 'lastTool', 'verificationState'];
      const changed = visibleKeys.some((key) => patch[key] !== undefined && patch[key] !== current[key]);
      return {
        ...current,
        ...patch,
        progressRevision: changed ? Number(current.progressRevision || 0) + 1 : Number(current.progressRevision || 0),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  renewLease(jobId) {
    const current = this.get(jobId);
    if (current.persistOnDisconnect || !current.leaseTimeoutMs || !['queued', 'starting', 'running'].includes(current.status)) return current;
    if (current.leaseExpiresAt && Date.now() >= Date.parse(current.leaseExpiresAt)) return current;
    return this.writeMeta(jobId, { leaseExpiresAt: new Date(Date.now() + current.leaseTimeoutMs).toISOString() });
  }

  get(jobId) {
    const meta = this.readJson(jobId, 'meta.json');
    if (!meta) throw new Error(`Job not found: ${jobId}`);
    return { ...meta, resultAvailable: fs.existsSync(path.join(this.dir(jobId), 'result.json')) };
  }

  result(jobId) {
    const meta = this.get(jobId);
    const result = this.readJson(jobId, 'result.json');
    return { meta, result };
  }

  list(limit = 20) {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('claude-'))
      .map((entry) => {
        try { return this.get(entry.name); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }
}
