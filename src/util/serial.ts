/**
 * Runs a job so that calls never overlap. A call while it runs schedules exactly one more
 * pass after the current one; every caller's promise settles once the latest pass is done.
 */
export class Serial {
  private running?: Promise<void>;
  private again = false;

  run(job: () => Promise<void>): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await job(); } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
