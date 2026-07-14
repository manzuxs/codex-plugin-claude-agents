import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function atomicWrite(filePath, value) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, filePath);
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
    const meta = { jobId, status: 'queued', createdAt: new Date().toISOString(), agent: request.agent, cwd: request.cwd, planSha256: request.planSha256 || null };
    atomicWrite(path.join(dir, 'meta.json'), meta);
    return meta;
  }

  readJson(jobId, name) {
    const filePath = path.join(this.dir(jobId), name);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  writeMeta(jobId, patch) {
    const current = this.readJson(jobId, 'meta.json') || { jobId };
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    atomicWrite(path.join(this.dir(jobId), 'meta.json'), next);
    return next;
  }

  writeResult(jobId, result) {
    atomicWrite(path.join(this.dir(jobId), 'result.json'), result);
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
