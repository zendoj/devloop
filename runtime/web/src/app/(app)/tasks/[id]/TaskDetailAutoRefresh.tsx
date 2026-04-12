'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Live-refresh the /tasks/:id detail page while the task is
 * actively moving through the pipeline. Polls every 3 seconds
 * when the task status is one of the "in motion" values; stops
 * polling once the task reaches a resting state (ready_for_test,
 * accepted, failed, etc) so we don't hammer /api/tasks/:id for
 * nothing.
 *
 * We poll faster (3s) than the list view (5s) because the
 * operator is actively watching a specific task land.
 */

const ACTIVE_STATUSES = new Set<string>([
  'queued_for_lock',
  'assigned',
  'in_progress',
  'review',
  'changes_requested',
  'approved',
  'deploying',
  'merged',
  'verifying',
  'rolling_back',
]);

const POLL_MS = 3_000;

export function TaskDetailAutoRefresh({
  status,
}: {
  status: string;
}): React.ReactElement | null {
  const router = useRouter();

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(status)) return;
    const id = setInterval(() => {
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [router, status]);

  return null;
}
