/**
 * S14: Dead-Letter Queue (DLQ)
 *
 * Persists permanently-failed dispatcher jobs to PostgreSQL for manual
 * inspection and replay. Jobs are moved to the DLQ after exhausting all
 * retry attempts.
 *
 * Table: dead_letter_jobs
 * - Stores the failed job payload, error, retry history, and resolution status
 *
 * Dashboard: /api/v1/health/dlq — queryable list of dead-letter jobs
 */

import type { DispatcherJobData } from './dispatcher.js';

export type DLQJobStatus = 'PENDING' | 'RESOLVED' | 'IGNORED';

export interface DLQJob {
  id: string;
  sequenceId: string;
  /** Job data snapshot */
  jobData: DispatcherJobData;
  /** Error that caused exhaustion */
  errorMessage: string;
  /** Error stack trace */
  errorStack?: string | null;
  /** Number of retry attempts before DLQ */
  attemptCount: number;
  /** When the job first failed */
  firstFailedAt: Date;
  /** When the job was moved to DLQ */
  deadLetteredAt: Date;
  /** Resolution status */
  status: DLQJobStatus;
  /** Who resolved it (manual notes) */
  resolvedBy?: string | null;
  /** Resolution notes */
  resolutionNotes?: string | null;
  /** When resolved */
  resolvedAt?: Date | null;
  /** Whether the job is available for replay */
  replayable: boolean;
  createdAt: Date;
}

export interface DLQStore {
  deadLetterJob: {
    create(args: { data: Omit<DLQJob, 'id' | 'createdAt'> }): Promise<DLQJob>;
    findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; skip?: number }): Promise<DLQJob[]>;
    count(args?: { where?: Record<string, unknown> }): Promise<number>;
    findUnique(args: { where: { id: string } }): Promise<DLQJob | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<DLQJob>;
  };
}

/**
 * Move a failed job to the dead-letter queue.
 */
export async function deadLetterJob(
  store: DLQStore,
  params: {
    sequenceId: string;
    jobData: DispatcherJobData;
    error: Error;
    attemptCount: number;
    firstFailedAt: Date;
  },
): Promise<DLQJob> {
  const job = await store.deadLetterJob.create({
    data: {
      sequenceId: params.sequenceId,
      jobData: params.jobData,
      errorMessage: params.error.message,
      errorStack: params.error.stack ?? null,
      attemptCount: params.attemptCount,
      firstFailedAt: params.firstFailedAt,
      deadLetteredAt: new Date(),
      status: 'PENDING',
      replayable: true,
    },
  });

  console.warn(
    JSON.stringify({
      msg: 'dead_letter_job_created',
      dlqJobId: job.id,
      sequenceId: params.sequenceId,
      error: params.error.message,
      attemptCount: params.attemptCount,
    }),
  );

  return job;
}

/**
 * Mark a DLQ job as resolved.
 */
export async function resolveDLQJob(
  store: DLQStore,
  jobId: string,
  resolvedBy: string,
  notes?: string,
): Promise<DLQJob> {
  return store.deadLetterJob.update({
    where: { id: jobId },
    data: {
      status: 'RESOLVED',
      resolvedBy,
      resolutionNotes: notes ?? null,
      resolvedAt: new Date(),
      replayable: false,
    },
  });
}

/**
 * Mark a DLQ job as ignored.
 */
export async function ignoreDLQJob(
  store: DLQStore,
  jobId: string,
  resolvedBy: string,
  notes?: string,
): Promise<DLQJob> {
  return store.deadLetterJob.update({
    where: { id: jobId },
    data: {
      status: 'IGNORED',
      resolvedBy,
      resolutionNotes: notes ?? null,
      resolvedAt: new Date(),
      replayable: false,
    },
  });
}

/**
 * List pending DLQ jobs for the dashboard.
 */
export async function listPendingDLQJobs(
  store: DLQStore,
  limit = 50,
  offset = 0,
): Promise<{ jobs: DLQJob[]; total: number }> {
  const [jobs, total] = await Promise.all([
    store.deadLetterJob.findMany({
      where: { status: 'PENDING' },
      orderBy: { deadLetteredAt: 'desc' as const },
      take: limit,
      skip: offset,
    }),
    store.deadLetterJob.count({ where: { status: 'PENDING' } }),
  ]);

  return { jobs, total };
}

/**
 * Replay a DLQ job by re-enqueueing it to the dispatcher queue.
 * Marks the DLQ entry as no longer replayable to prevent double-dispatch.
 */
export async function replayDLQJob(
  store: DLQStore,
  dlqJobId: string,
  reenqueueFn: (jobData: DispatcherJobData) => Promise<{ jobId: string }>,
): Promise<{ dlqJob: DLQJob; newJobId: string }> {
  const dlqJob = await store.deadLetterJob.findUnique({ where: { id: dlqJobId } });

  if (!dlqJob) {
    throw new Error(`DLQ job not found: ${dlqJobId}`);
  }

  if (!dlqJob.replayable) {
    throw new Error(`DLQ job ${dlqJobId} is not replayable (status: ${dlqJob.status})`);
  }

  const result = await reenqueueFn(dlqJob.jobData);

  await store.deadLetterJob.update({
    where: { id: dlqJobId },
    data: {
      replayable: false,
      resolvedAt: new Date(),
    },
  });

  console.log(
    JSON.stringify({
      msg: 'dlq_job_replayed',
      dlqJobId,
      newJobId: result.jobId,
      sequenceId: dlqJob.sequenceId,
    }),
  );

  return { dlqJob, newJobId: result.jobId };
}

/**
 * Check DLQ health for the health endpoint.
 */
export async function checkDLQHealth(store: DLQStore): Promise<{
  status: 'ok' | 'degraded';
  pendingCount: number;
  last24hCount: number;
}> {
  const pendingCount = await store.deadLetterJob.count({ where: { status: 'PENDING' } });

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const last24hCount = await store.deadLetterJob.count({
    where: { deadLetteredAt: { gte: oneDayAgo } },
  });

  return {
    status: pendingCount > 0 ? 'degraded' : 'ok',
    pendingCount,
    last24hCount,
  };
}