import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DatabaseSync } from './sqlite.mjs';

const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const TERMINAL_STATUS_SQL = [...TERMINAL_STATUSES].map((status) => `'${status}'`).join(', ');

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toMeta(row) {
  if (!row) return null;
  const meta = parseJson(row.meta_json, {});
  return { ...meta, resultAvailable: row.result_json !== null && row.result_json !== undefined };
}

export class JobStore {
  constructor(dataRoot) {
    fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    this.root = dataRoot;
    this.filePath = path.join(dataRoot, 'claude-agents.sqlite');
    this.db = new DatabaseSync(this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request_json TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS job_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_events_job_seq ON job_events(job_id, seq);
      CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs(created_at DESC);
    `);
    this.statements = {
      insertJob: this.db.prepare('INSERT INTO jobs(job_id,status,agent,cwd,created_at,updated_at,request_json,meta_json) VALUES(?,?,?,?,?,?,?,?)'),
      getJob: this.db.prepare('SELECT * FROM jobs WHERE job_id = ?'),
      updateJob: this.db.prepare('UPDATE jobs SET status = ?, updated_at = ?, meta_json = ? WHERE job_id = ?'),
      writeResult: this.db.prepare('UPDATE jobs SET result_json = ?, updated_at = ? WHERE job_id = ?'),
      insertEvent: this.db.prepare('INSERT INTO job_events(job_id,created_at,event_json) VALUES(?,?,?)'),
      readEvents: this.db.prepare('SELECT seq,event_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
      listJobs: this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?'),
      deleteEvents: this.db.prepare('DELETE FROM job_events WHERE job_id = ?'),
      deleteJob: this.db.prepare('DELETE FROM jobs WHERE job_id = ?'),
      selectTerminalForCleanup: this.db.prepare(`SELECT job_id FROM jobs WHERE status IN (${TERMINAL_STATUS_SQL}) AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`),
      countEvents: this.db.prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id = ?'),
    };
  }

  newId() {
    return `claude-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  create(request) {
    const jobId = this.newId();
    const now = new Date().toISOString();
    const meta = {
      jobId,
      status: 'queued',
      createdAt: now,
      role: request.role || request.agent,
      agent: request.agent,
      runner: request.runner || 'claude',
      model: request.model || null,
      capabilitiesUsed: request.capabilitiesUsed || [],
      task: request.task || '',
      cwd: request.cwd,
      browserMode: request.browserMode || 'none',
      planSha256: request.planSha256 || null,
      configuredTimeoutMs: request.configuredTimeoutMs ?? null,
      requestedTimeoutMs: request.requestedTimeoutMs ?? null,
      effectiveTimeoutMs: request.effectiveTimeoutMs ?? null,
      timeoutSource: request.timeoutSource || null,
      progressRevision: 0,
      phase: 'starting',
      elapsedMs: 0,
      turnsObserved: 0,
      lastActivityAt: null,
      lastTool: null,
      lastToolSummary: null,
      verificationState: 'pending',
    };
    this.statements.insertJob.run(jobId, 'queued', request.agent, request.cwd, now, now, JSON.stringify(request), JSON.stringify(meta));
    return meta;
  }

  row(jobId) {
    return this.statements.getJob.get(jobId);
  }

  readJson(jobId, name) {
    const row = this.row(jobId);
    if (!row) return null;
    if (name === 'request.json') return parseJson(row.request_json);
    if (name === 'meta.json') return parseJson(row.meta_json);
    if (name === 'result.json') return parseJson(row.result_json);
    return null;
  }

  writeMeta(jobId, patch) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.statements.getJob.get(jobId);
      const current = parseJson(row?.meta_json);
      if (!current) throw new Error(`Job not found: ${jobId}`);
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      this.statements.updateJob.run(String(next.status || current.status), next.updatedAt, JSON.stringify(next), jobId);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  writeResult(jobId, result) {
    const now = new Date().toISOString();
    this.statements.writeResult.run(JSON.stringify(result), now, jobId);
  }

  appendEvent(jobId, event) {
    this.statements.insertEvent.run(jobId, new Date().toISOString(), JSON.stringify(event));
  }

  readEvents(jobId, { after = 0, limit = 200 } = {}) {
    const rows = this.statements.readEvents.all(jobId, Math.max(0, Number(after) || 0), Math.max(1, Math.min(1000, Number(limit) || 200)));
    const events = rows.map((row) => ({ seq: row.seq, ...parseJson(row.event_json, {}) }));
    return { events, cursor: events.length ? events[events.length - 1].seq : Math.max(0, Number(after) || 0) };
  }

  writeProgress(jobId, patch) {
    const current = this.readJson(jobId, 'meta.json');
    if (!current) throw new Error(`Job not found: ${jobId}`);
    const visibleKeys = ['phase', 'turnsObserved', 'lastTool', 'verificationState'];
    const changed = visibleKeys.some((key) => patch[key] !== undefined && patch[key] !== current[key]);
    return this.writeMeta(jobId, {
      ...patch,
      progressRevision: changed ? Number(current.progressRevision || 0) + 1 : Number(current.progressRevision || 0),
    });
  }

  renewLease(jobId) {
    const current = this.get(jobId);
    if (current.persistOnDisconnect || !current.leaseTimeoutMs || !ACTIVE_STATUSES.has(current.status)) return current;
    if (current.leaseExpiresAt && Date.now() >= Date.parse(current.leaseExpiresAt)) return current;
    return this.writeMeta(jobId, { leaseExpiresAt: new Date(Date.now() + current.leaseTimeoutMs).toISOString() });
  }

  get(jobId) {
    const meta = toMeta(this.row(jobId));
    if (!meta) throw new Error(`Job not found: ${jobId}`);
    return meta;
  }

  result(jobId) {
    const row = this.row(jobId);
    const meta = toMeta(row);
    if (!meta) throw new Error(`Job not found: ${jobId}`);
    return { meta, result: parseJson(row.result_json) };
  }

  list(limit = 20) {
    return this.statements.listJobs.all(Math.max(1, Math.min(100, Number(limit) || 20))).map(toMeta).filter(Boolean);
  }

  delete(jobId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.statements.getJob.get(jobId);
      if (!row) throw new Error(`Job not found: ${jobId}`);
      this.statements.deleteEvents.run(jobId);
      this.statements.deleteJob.run(jobId);
      this.db.exec('COMMIT');
      return { ok: true, jobId };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  cleanupTerminal({ before, limit = 100 } = {}) {
    if (before === undefined || before === null) throw new Error('cleanupTerminal requires a before date or timestamp.');
    const cutoff = before instanceof Date ? before : new Date(before);
    if (Number.isNaN(cutoff.getTime())) throw new Error('cleanupTerminal before must be a valid date or timestamp.');
    const maxJobs = Math.max(1, Math.min(1000, Number(limit) || 100));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const candidates = this.statements.selectTerminalForCleanup.all(cutoff.toISOString(), maxJobs);
      const deletedJobIds = [];
      let deletedEvents = 0;
      for (const candidate of candidates) {
        const row = this.statements.getJob.get(candidate.job_id);
        if (!row || !TERMINAL_STATUSES.has(row.status)) continue;
        deletedEvents += Number(this.statements.countEvents.get(candidate.job_id)?.count || 0);
        this.statements.deleteEvents.run(candidate.job_id);
        this.statements.deleteJob.run(candidate.job_id);
        deletedJobIds.push(candidate.job_id);
      }
      this.db.exec('COMMIT');
      return { ok: true, before: cutoff.toISOString(), deletedJobs: deletedJobIds.length, deletedEvents, jobIds: deletedJobIds };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
