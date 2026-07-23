import { useLive } from '@companion/core/client';
import { useCallback, useState } from 'react';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { BillingStatus } from '../../contract/index.js';
import { billingApi } from '../api.js';

/** The sole billing.changed consumer; refreshes only the active workspace. */
export function useBilling(): { current: WorkspaceRecord | null; status: BillingStatus | null; error: string | null; refresh: () => Promise<void> } {
  const { current } = useWorkspace();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!current) { setStatus(null); return; }
    try { setStatus(await billingApi.status(current.id)); setError(null); }
    catch (err) { setStatus(null); setError(String(err)); }
  }, [current]);
  useLive(refresh, (message) => message.t === 'billing.changed' && message.workspaceId === current?.id);
  return { current, status, error, refresh };
}
