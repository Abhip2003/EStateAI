import { jobService, type EnqueueJobInput, type EnqueueResult } from './job.service.js';

export class SchedulingNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulingNotImplementedError';
  }
}

export interface CronScheduleInput extends EnqueueJobInput {
  cronExpression: string;
}

// Architecture only, per this checkpoint's scope — every method here is a
// distinct *trigger source* for the same underlying JobService.enqueue(),
// named separately so callers (and future code) can reason about *why* a
// job was created even though the enqueue mechanism is identical today.
class SchedulerService {
  // A human or an API call asking for work right now.
  async scheduleManual(input: EnqueueJobInput): Promise<EnqueueResult> {
    return jobService.enqueue(input);
  }

  // Extension point for a future cron runner: given a schedule spec, this
  // is where a periodic tick would call jobService.enqueue(). No cron
  // implementation yet — deliberately throws rather than silently
  // no-opping a "scheduled" job, so a caller can't mistake "not built yet"
  // for "scheduled and forgotten".
  scheduleCron(_input: CronScheduleInput): Promise<never> {
    return Promise.reject(
      new SchedulingNotImplementedError(
        'Cron scheduling is not implemented yet — this is an architectural extension point only',
      ),
    );
  }

  // Extension point for a future webhook receiver to enqueue work in
  // response to an inbound provider event (e.g. a GitHub push webhook
  // triggering a targeted re-sync).
  async scheduleFromTrigger(input: EnqueueJobInput): Promise<EnqueueResult> {
    return jobService.enqueue(input);
  }
}

export const schedulerService = new SchedulerService();
