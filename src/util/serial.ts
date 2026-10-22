/**
 * Runs a job so that calls never overlap. A call while it runs schedules exactly one more
 * pass after the current one; every caller's promise settles once the latest pass is done.
 * A failing pass doesn't drop a pass queued behind it; callers see the error only if the
 * last pass failed.
 */
export class Serial {
  private running?: Promise<void>;
  private again = false;

  run(job: () => Promise<void>): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        let lastError: unknown;
        do {
          this.again = false;
          lastError = undefined;
          try { await job(); } catch (e) { lastError = e; }
        } while (this.again);
        if (lastError !== undefined) throw lastError;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
