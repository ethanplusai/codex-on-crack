// Per-profile launch leases shared through the controller state directory.
//
// The localhost panel and the MCP server can run as separate processes over
// one configuration. A lease file per launch profile makes "at most one active
// run of this profile" hold across all of them, and across launch versus
// resume: whoever creates the file (atomically, with link(2)) owns the profile
// until its child exits.
//
// A lease is only ever reclaimed when it is provably stale: neither the
// controller process nor the child it spawned still exists. Liveness is probed
// with signal 0, which delivers nothing. A live lease is never stolen and no
// process is signalled on the strength of a lease file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PanelError, appendPrivateLine, readVerifiedSync } from './paths.mjs';

const MAX_LEASE_BYTES = 4096;
// A lease file that cannot be parsed is treated as live for this long, so a
// reader never mistakes a lease being written for an abandoned one.
const UNPARSEABLE_GRACE_MS = 10_000;
const RECLAIM_GUARD_STALE_MS = 60_000;

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export class ProfileLeases {
  constructor({ dir, session, isAlive = processAlive, clock = () => new Date() }) {
    this.dir = dir;
    this.session = session;
    this.isAlive = isAlive;
    this.clock = clock;
  }

  file(profileId) {
    return path.join(this.dir, `${profileId}.lease`);
  }

  // The current holder, or null. `live` is false only when the lease is
  // provably abandoned.
  holder(profileId) {
    const file = this.file(profileId);
    let read;
    try {
      read = readVerifiedSync([this.dir], file, { exact: file, maxBytes: MAX_LEASE_BYTES });
    } catch (error) {
      if (error.code === 'artifact_missing') return null;
      // Anything unsafe (symlink, oversized, not a file) is treated as held:
      // refusing to launch is the safe failure.
      return { live: true, token: null, runId: null, session: null, unsafe: true };
    }
    let doc = null;
    try { doc = JSON.parse(read.data.toString('utf8')); } catch { doc = null; }
    if (doc === null || typeof doc.token !== 'string') {
      const young = this.clock().getTime() - read.stat.mtimeMs < UNPARSEABLE_GRACE_MS;
      return { live: young, token: null, runId: null, session: null, ino: read.stat.ino };
    }
    const live = this.isAlive(doc.pid) || this.isAlive(doc.childPid);
    return { live, token: doc.token, runId: typeof doc.runId === 'string' ? doc.runId : null, session: doc.session ?? null, pid: doc.pid, ino: read.stat.ino };
  }

  // Take the lease for a profile, or throw `already_running`. Synchronous, so
  // two requests in one process cannot interleave between check and take.
  acquire(profileId, { kind }) {
    const lease = {
      profileId, token: crypto.randomBytes(16).toString('hex'), file: this.file(profileId), kind,
      doc: { schemaVersion: 1, profileId, kind, pid: process.pid, childPid: null, runId: null, session: this.session, at: this.clock().toISOString() },
    };
    lease.doc.token = lease.token;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.tryCreate(lease)) return lease;
      const holder = this.holder(profileId);
      if (holder === null) continue;
      if (holder.live) {
        const where = holder.session === this.session ? 'this panel process' : 'another panel process sharing this state';
        throw new PanelError('already_running', `A run of this profile is already active or starting (held by ${where}).`, 409);
      }
      this.reclaimStale(profileId, holder);
    }
    throw new PanelError('already_running', 'The launch lease for this profile is busy. Try again.', 409);
  }

  tryCreate(lease) {
    const tmp = `${lease.file}.${lease.token}.tmp`;
    // Write the complete record first, then link it into place: link fails
    // with EEXIST atomically, and a reader never sees a half-written lease.
    appendPrivateLine(tmp, `${JSON.stringify(lease.doc)}\n`);
    try {
      fs.linkSync(tmp, lease.file);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // Remove a lease whose holders are both gone. A short-lived guard directory
  // makes the re-check and removal exclusive, so two reclaimers cannot remove
  // a lease that one of them has just re-created.
  reclaimStale(profileId, seen) {
    const file = this.file(profileId);
    const guard = `${file}.reclaim`;
    try {
      fs.mkdirSync(guard, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (this.clock().getTime() - fs.lstatSync(guard).mtimeMs > RECLAIM_GUARD_STALE_MS) fs.rmdirSync(guard);
      } catch { /* another reclaimer finished first */ }
      return;
    }
    try {
      const now = this.holder(profileId);
      if (now !== null && !now.live && now.ino === seen.ino && now.token === seen.token) fs.unlinkSync(file);
    } finally {
      fs.rmdirSync(guard);
    }
  }

  // Record the child and run once spawned, so the lease outlives a crashed
  // controller for as long as its child runs.
  attach(lease, { childPid, runId }) {
    lease.doc = { ...lease.doc, childPid: Number.isSafeInteger(childPid) ? childPid : null, runId };
    const tmp = `${lease.file}.${lease.token}.tmp`;
    try {
      appendPrivateLine(tmp, `${JSON.stringify(lease.doc)}\n`);
      if (this.holder(lease.profileId)?.token === lease.token) fs.renameSync(tmp, lease.file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  release(lease) {
    if (!lease || lease.released) return;
    lease.released = true;
    try {
      if (this.holder(lease.profileId)?.token === lease.token) fs.unlinkSync(lease.file);
    } catch { /* already gone */ }
  }
}
