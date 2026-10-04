const { randomUUID } = require('crypto');

// Inference/persistence only. Delivery is explicitly requested once by the renderer;
// a background completion has no route to clipboard, paste or TTS.
class SpeechJobs {
  constructor({ polisher, database, approved = () => false, now = Date.now } = {}) {
    Object.assign(this, { polisher, database, approved, now });
    this.jobs = new Map();
  }

  run(text, options = {}, owner = null) {
    const id = options.sessionId || randomUUID();
    if (this.jobs.has(id)) return this.jobs.get(id).foreground;
    // A history retry must not interrupt a live utterance.
    if (options.backgroundOnly && [...this.jobs.values()].some(j => !j.done && !j.foregroundReturned)) {
      return Promise.resolve({ success: false, error: '正在处理新输入，请稍后重试' });
    }
    for (const job of this.jobs.values()) if (!job.done) this.cancel(job.id, 'preempted');
    const controller = new AbortController(), started = this.now();
    const stopped = Number(options.stoppedAtMs) || started;
    const needsModel = this.polisher.naturalFormatter.shouldFormat?.(text) !== false;
    const canAutoDeliver = needsModel && this.approved() === true;
    const deliveryDeadline = Math.min(started + 2000, stopped + 2000);
    const deadline = !canAutoDeliver || options.backgroundOnly || options.waitForModel === false ? started : deliveryDeadline;
    const record = this.database.createSpeechRecord(id, text);
    const job = { id, owner, controller, started, stopped, done: false, foregroundReturned: false,
      backgroundOnly: !!options.backgroundOnly, recordId: record.id,
      base: { text, raw_text: text, corrected_text: text, final_text: text, stages: [], mode: 'natural', degraded: null, changed: false } };
    job.waitEnded = new Promise(resolve => { job.finishWaiting = () => resolve(null); });
    this.jobs.set(id, job);
    const abort = () => this.cancel(id);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    let baseReady;
    const prepared = new Promise(resolve => { baseReady = resolve; });
    job.work = (async () => {
      try {
        job.base = await this.polisher.polish(text, { ...options, mode: 'natural', skipModel: true, signal: controller.signal });
        baseReady();
        if (controller.signal.aborted) return job.base;
        this.database.updateSpeechRecord(id, { corrected_text: job.base.text, processing_status: 'processing',
          processing_json: JSON.stringify({ dictionary_version: job.base.dictionary_version, stopped_at_ms: options.backgroundOnly ? null : stopped,
            asr_ready_at_ms: started, segments: options.segments || [], words: options.words || [] }) });
        const modelStartedAt = this.now();
        const result = await this.polisher.naturalFormatter.format(job.base.text, { signal: controller.signal,
          segments: options.segments || [], words: options.words || [],
          terms: this.polisher.hotWordsStore?.entriesForVersion(job.base.dictionary_version)?.filter(e => e.enabled !== false).map(e => e.term) || [] });
        if (controller.signal.aborted) return job.base;
        job.status = result.candidate_text ? 'review_required' : result.degraded ? 'failed' : 'completed';
        const approved = result.route === 'short_basic' || this.approved() === true;
        const generationDoneAt = modelStartedAt + (result.generation_ms ?? result.elapsed_ms ?? 0);
        const meta = { ...result, candidate_text: undefined, text: undefined, auto_delivery_approved: approved,
          total_ms: this.now() - started,
          stop_to_model_complete_ms: options.backgroundOnly || !result.generation_complete ? null : generationDoneAt - stopped,
          stop_to_validation_complete_ms: options.backgroundOnly || result.degraded || !result.generation_complete ? null : this.now() - stopped,
          model_completed_within_2s: options.backgroundOnly ? null : result.generation_complete === true && generationDoneAt <= deliveryDeadline,
          accepted_within_2s: options.backgroundOnly ? null : result.generation_complete === true && !result.degraded && this.now() <= deliveryDeadline,
          stopped_at_ms: options.backgroundOnly ? null : stopped, asr_ready_at_ms: started, background: job.foregroundReturned,
          segments: options.segments || [], words: options.words || [],
          dictionary_version: job.base.dictionary_version, rules_version: job.base.rules_version };
        this.database.updateSpeechRecord(id, { processed_text: result.degraded ? null : result.text,
          candidate_text: result.candidate_text || null, processing_status: job.status, processing_json: JSON.stringify(meta) });
        const delivered = approved && !result.degraded ? result.text : job.base.text;
        return { ...job.base, ...result, text: delivered, final_text: delivered, changed: delivered !== text,
          degraded: result.degraded || (!approved ? 'model_unverified' : null),
          stages: [...job.base.stages, { stage: 'natural', elapsed_ms: result.elapsed_ms, first_token_ms: result.first_token_ms,
            applied: approved && result.changed, degraded: result.degraded }], total_ms: this.now() - started };
      } catch {
        if (controller.signal.aborted) return job.base;
        job.status = 'failed';
        this.database.updateSpeechRecord(id, { processing_status: 'failed', processing_json: JSON.stringify({ degraded: 'processing_failed' }) });
        return { ...job.base, degraded: 'processing_failed' };
      } finally {
        baseReady(); job.done = true; job.doneAt = this.now();
        options.signal?.removeEventListener('abort', abort);
        for (const [key, old] of this.jobs) if (this.jobs.size > 64 && old.done && key !== id) this.jobs.delete(key);
      }
    })();
    job.foreground = (async () => {
      // Always deliver the explicit corrections. Once ASR is late, never add a
      // model wait; the isolated rule worker has its own small execution budget.
      await prepared;
      let timer;
      const result = this.now() >= deadline ? null : await Promise.race([job.work, job.waitEnded,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - this.now())); })]);
      clearTimeout(timer); job.foregroundReturned = true;
      let output;
      if (controller.signal.aborted) output = { ...job.base, degraded: 'cancelled' };
      else if (!result) {
        if (!job.done) this.database.updateSpeechRecord(id, { processing_status: 'background' });
        output = { ...job.base, degraded: !needsModel ? null : canAutoDeliver ? 'background_pending' : 'model_unverified' };
      } else output = job.doneAt > deadline ? { ...job.base, degraded: 'model_after_deadline' } : result;
      job.deliveryText = output.text;
      return { ...output, job_id: id, history_managed: true, history_id: job.recordId,
        processing_status: job.done ? job.status : 'background', frontend_ms: this.now() - started,
        stop_to_text_ready_ms: this.now() - stopped };
    })();
    return job.foreground;
  }

  async deliver(id, owner, action) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || !job.foregroundReturned || job.backgroundOnly || job.controller.signal.aborted ||
      !this.database.getTranscriptionById(job.recordId)) return { success: false, mode: 'cancelled' };
    if (job.deliveryPromise) return { ...(await job.deliveryPromise), duplicate: true };
    job.deliveryPromise = (async () => {
      const result = await action(job.deliveryText);
      if (result?.success !== false) this.database.markSpeechDelivery(id, job.deliveryText, result?.mode || 'pasted', this.now() - job.stopped);
      return result;
    })();
    return job.deliveryPromise;
  }

  cancel(id, reason = 'cancelled') {
    const job = this.jobs.get(id);
    if (!job || job.controller.signal.aborted) return;
    job.controller.abort();
    if (!job.done) {
      job.status = reason;
      this.database.updateSpeechRecord(id, { processing_status: reason, processing_json: JSON.stringify({ degraded: reason }) });
    }
  }

  finishWaitingForOwner(owner) {
    for (const job of this.jobs.values()) if (job.owner === owner && !job.foregroundReturned) job.finishWaiting();
  }

  cancelOwner(owner, { background = true } = {}) {
    for (const job of this.jobs.values()) if (job.owner === owner && (background || !job.foregroundReturned)) this.cancel(job.id);
  }
  dispose() { for (const job of this.jobs.values()) this.cancel(job.id); }
}
module.exports = { SpeechJobs };
