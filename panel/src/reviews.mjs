// Visual review records: evidence revisions and decisions.
//
// Records are append-only JSONL in the controller's state directory. A decision
// binds to the evidence hash that was on screen when it was made; the hash
// covers the revision number, the reference and actual image bytes, and the
// review checks, so any new submission, or an in-place file replacement, makes
// an earlier approval stale instead of silently carrying it over.
import crypto from 'node:crypto';
import path from 'node:path';
import { PanelError, appendPrivateLine, fileLabel, readImage, readVerifiedSync, sha256, sniffImage } from './paths.mjs';

export const REVIEW_STATES = Object.freeze({
  awaiting: 'awaiting_evidence',
  ready: 'ready_for_review',
  changes: 'changes_requested',
  approved: 'approved',
});
export const DECISIONS = Object.freeze(['approve', 'request_changes', 'feedback']);
// Who recorded a decision, and how the controller knows. Only these channels
// can record a decision; a model-visible tool has none of them.
//
// None of these channels proves that a human clicked. `local-ui` means a local
// client presented the loopback session token; any process running as the same
// OS user can read that token, so it is not a boundary against such a process.
// `mcp-app` means the host forwarded an app-only tool call. The channel says
// how the decision arrived, nothing more.
export const CHANNELS = Object.freeze({
  'local-ui': { actor: 'local panel client', authentication: 'loopback session token (authenticates a local client, not a person)', recordedBy: 'local panel' },
  'mcp-app': { actor: 'host app view', authentication: 'app-only MCP tool with a per-view nonce; relies on the host enforcing app-only visibility', recordedBy: 'host app view' },
  'demo-ui': { actor: 'demo', authentication: 'demo session; not a real approval', recordedBy: 'demo panel' },
});
const SUBMITTERS = new Set(['config', 'model-tool', 'local-ui', 'demo']);
const MAX_RECORDS_BYTES = 5 * 1024 * 1024;
const MAX_FEEDBACK = 4000;
const MAX_NOTE = 1000;
const MAX_HASH_CACHE = 256;

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // Control characters other than newline/tab are dropped; the UI renders text only.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

export class ReviewStore {
  constructor({ stateDir, reviews, roots, demo = false, clock = () => new Date() }) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, 'reviews.jsonl');
    this.reviews = new Map(reviews.map((r) => [r.id, r]));
    this.roots = roots;
    this.demo = demo;
    this.clock = clock;
    this.hashCache = new Map();
  }

  records() {
    let text = '';
    try {
      text = readVerifiedSync([this.stateDir], this.file, { exact: this.file, maxBytes: MAX_RECORDS_BYTES }).data.toString('utf8');
    } catch (error) {
      if (error.code === 'artifact_too_large') throw new PanelError('state_too_large', 'The review record exceeds its size limit.', 500);
      if (error.code !== 'artifact_missing') throw new PanelError('state_unreadable', 'The review record is not a private regular file.', 500);
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record?.schemaVersion === 1 && this.reviews.has(record.reviewId)) out.push(record);
      } catch {
        // A torn or malformed line is ignored; it can never become an approval.
      }
    }
    return out;
  }

  append(record) {
    const full = { schemaVersion: 1, recordId: crypto.randomBytes(8).toString('hex'), at: this.clock().toISOString(), ...record };
    appendPrivateLine(this.file, `${JSON.stringify(full)}\n`);
    return full;
  }

  // Facts about one evidence image, always from a safe, verified open. For
  // display, bytes already hashed for the same (device, inode, size, mtime,
  // ctime) are not re-read; `fresh` (decisions and gate enforcement) always
  // hashes the bytes on disk now. Restoring an mtime after an in-place rewrite
  // still changes ctime, and a swapped symlink fails the open checks.
  async imageFacts(file, { fresh = false } = {}) {
    if (file === null) return null;
    const keyOf = (stat) => `${file}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
    let facts;
    try {
      // Evidence paths are canonical when registered, so the read is pinned to
      // them: a later symlink, even one pointing inside a root, is refused.
      const read = readVerifiedSync(this.roots, file, { exact: file, reuse: fresh ? null : (stat) => this.hashCache.get(keyOf(stat)) });
      if (read.reused) return read.reused;
      const type = sniffImage(read.data);
      facts = type === null
        ? { present: false, label: fileLabel(file), problem: 'unsupported_image' }
        : { present: true, label: fileLabel(file), sha256: sha256(read.data), bytes: read.data.length, type };
      if (this.hashCache.size >= MAX_HASH_CACHE) this.hashCache.clear();
      this.hashCache.set(keyOf(read.stat), facts);
    } catch (error) {
      facts = error.code === 'artifact_missing'
        ? { present: false, label: fileLabel(file) }
        : { present: false, label: fileLabel(file), problem: error.code ?? 'artifact_unreadable' };
    }
    return facts;
  }

  // The revision list: the configured evidence (if any) is revision 1, and
  // every later submission adds one.
  revisions(review, records) {
    const list = [];
    if (review.actual !== null) list.push({ number: 1, actual: review.actual, submittedAt: null, submittedBy: 'config', note: '' });
    for (const record of records) {
      if (record.type !== 'evidence.submitted' || record.reviewId !== review.id || typeof record.actual !== 'string') continue;
      list.push({
        number: list.length + 1,
        actual: record.actual,
        submittedAt: record.at,
        submittedBy: SUBMITTERS.has(record.submittedBy) ? record.submittedBy : 'unknown',
        note: cleanText(record.note, MAX_NOTE),
        submittedSha256: typeof record.actualSha256 === 'string' ? record.actualSha256 : null,
      });
    }
    return list;
  }

  async evaluate(review, records = this.records(), { fresh = false } = {}) {
    const revisions = this.revisions(review, records);
    const current = revisions.at(-1) ?? null;
    const reference = await this.imageFacts(review.reference, { fresh });
    const actual = current === null ? null : await this.imageFacts(current.actual, { fresh });
    const evidenceHash = actual?.present === true
      ? sha256(JSON.stringify({ review: review.id, revision: current.number, reference: reference?.present ? reference.sha256 : null, actual: actual.sha256, checks: review.checks, ...(review.question?{question:review.question,title:review.title}:{}) }))
      : review.question ? sha256(JSON.stringify({review:review.id,question:review.question,title:review.title,checks:review.checks})) : null;
    const decisions = records
      .filter((r) => r.type === 'decision.recorded' && r.reviewId === review.id && DECISIONS.includes(r.decision) && Object.hasOwn(CHANNELS, r.channel))
      .map((r) => ({
        id: r.recordId,
        decision: r.decision,
        feedback: cleanText(r.feedback, MAX_FEEDBACK),
        channel: r.channel,
        ...CHANNELS[r.channel],
        revision: Number.isSafeInteger(r.revision) ? r.revision : null,
        evidenceHash: typeof r.evidenceHash === 'string' ? r.evidenceHash : null,
        at: r.at,
        current: evidenceHash !== null && r.evidenceHash === evidenceHash,
      }));
    const latestCurrent = decisions.filter((d) => d.current && d.decision!=='feedback').at(-1) ?? null;
    let state;
    if (evidenceHash === null) state = REVIEW_STATES.awaiting;
    else if (latestCurrent?.decision === 'approve') state = REVIEW_STATES.approved;
    else if (latestCurrent?.decision === 'request_changes') state = REVIEW_STATES.changes;
    else state = decisions.some(d=>d.current&&d.decision==='feedback') ? 'feedback_received' : REVIEW_STATES.ready;
    const staleApproval = decisions.some((d) => !d.current && d.decision === 'approve') && state !== REVIEW_STATES.approved;
    const changedOnDisk = current?.submittedSha256 && actual?.present && actual.sha256 !== current.submittedSha256;
    return {
      id: review.id,
      title: review.title,
      question: review.question??null,
      workspaceId: review.workspace,
      gate: review.gate,
      run: review.run,
      checks: review.checks,
      state,
      evidenceHash,
      revision: current === null ? null : {
        number: current.number,
        submittedAt: current.submittedAt,
        submittedBy: current.submittedBy,
        note: current.note,
        changedOnDisk: Boolean(changedOnDisk),
      },
      revisionCount: revisions.length,
      // The image hashes let the view fetch exactly the bytes this evidence hash covers.
      reference: reference === null ? null : { present: reference.present, label: reference.label, bytes: reference.bytes ?? null, sha256: reference.sha256 ?? null, problem: reference.problem ?? null },
      actual: actual === null ? null : { present: actual.present, label: actual.label, bytes: actual.bytes ?? null, sha256: actual.sha256 ?? null, problem: actual.problem ?? null },
      decisions,
      approvedBy: state === REVIEW_STATES.approved ? latestCurrent.channel : null,
      notice: staleApproval
        ? 'An earlier approval applied to different evidence and no longer counts.'
        : changedOnDisk ? 'The evidence file changed on disk after it was submitted; review the current bytes.' : null,
    };
  }

  // `fresh` re-hashes every image now; used wherever a decision or gate is enforced.
  async snapshot({ fresh = false } = {}) {
    const records = this.records();
    return Promise.all([...this.reviews.values()].map((review) => this.evaluate(review, records, { fresh })));
  }

  get(reviewId) {
    const review = this.reviews.get(reviewId);
    if (!review) throw new PanelError('unknown_review', 'No such review.', 404);
    return review;
  }

  // The file for one side of the current revision; the caller serves it with readImage.
  async artifactPath(reviewId, side) {
    const review = this.get(reviewId);
    if (side === 'reference') {
      if (review.reference === null) throw new PanelError('artifact_missing', 'This review has no reference image.', 404);
      return review.reference;
    }
    if (side !== 'actual') throw new PanelError('invalid_side', 'side must be reference or actual.', 400);
    const current = this.revisions(review, this.records()).at(-1);
    if (!current) throw new PanelError('artifact_missing', 'No evidence has been submitted yet.', 404);
    return current.actual;
  }

  async decide({ reviewId, decision, feedback = '', expectedHash, channel }) {
    const review = this.get(reviewId);
    if (!DECISIONS.includes(decision)) throw new PanelError('invalid_decision', 'decision must be approve, request_changes or feedback.', 400);
    if (!Object.hasOwn(CHANNELS, channel)) throw new PanelError('invalid_channel', 'This channel cannot record a decision.', 403);
    if (this.demo !== (channel === 'demo-ui')) throw new PanelError('provenance_mismatch', 'Demo and real decisions are recorded separately.', 403);
    const text = cleanText(feedback, MAX_FEEDBACK);
    if (['request_changes','feedback'].includes(decision) && !text) throw new PanelError('feedback_required', 'Describe the change you want before requesting changes.', 400);
    const evaluated = await this.evaluate(review, this.records(), { fresh: true });
    if(decision!=='feedback' && !evaluated.actual?.present)throw new PanelError('awaiting_evidence','Approval actions require visual evidence.',409);
    if (evaluated.evidenceHash === null) throw new PanelError('awaiting_evidence', 'There is no evidence to decide on yet.', 409);
    if (typeof expectedHash !== 'string' || expectedHash !== evaluated.evidenceHash) {
      throw new PanelError('stale_evidence', 'The evidence changed since you opened it. Review the current revision first.', 409);
    }
    const record = this.append({
      type: 'decision.recorded', reviewId, decision, feedback: text, channel,
      revision: evaluated.revision?.number ?? 0, evidenceHash: evaluated.evidenceHash,
    });
    return { recorded: true, decisionId: record.recordId, review: await this.evaluate(review) };
  }

  // New evidence for an existing review. The path must be an existing raster
  // image inside a registered root; nothing else about the review can change.
  async submitEvidence({ reviewId, actual, note = '', submittedBy }) {
    const review = this.get(reviewId);
    if (!SUBMITTERS.has(submittedBy) || submittedBy === 'config') throw new PanelError('invalid_submitter', 'Unknown evidence submitter.', 400);
    const image = await readImage(this.roots, actual);
    this.append({
      type: 'evidence.submitted', reviewId, actual: image.path, actualSha256: image.sha256,
      note: cleanText(note, MAX_NOTE), submittedBy,
    });
    return { submitted: true, review: await this.evaluate(review) };
  }

  async latestFeedback(reviewId) {
    const evaluated = await this.evaluate(this.get(reviewId));
    const request = evaluated.decisions.filter((d) => d.decision === 'request_changes' && d.channel !== 'demo-ui').at(-1);
    return request ? { feedback: request.feedback, revision: request.revision, at: request.at } : null;
  }
}
