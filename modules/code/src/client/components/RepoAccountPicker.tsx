import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Dropdown } from '@companion/ui';
import { REPO_PERMISSION_LABEL, type RepoAccountOption } from '../../contract/index.js';
import { codeApi } from '../api.js';

/** Sentinel for "no binding" — account ids never collide with it. */
const AUTOMATIC = '';

/**
 * Which of MY GitHub accounts acts on this repository. Each option carries the
 * permission that account actually holds there, so the choice is made against
 * real reach instead of a guess — and a read-only account is visibly the reason
 * a push-shaped action is unavailable.
 *
 * The binding is a preference, not an authorization: it only ever names the
 * caller's own accounts, and resolution still verifies permission per action.
 */
export function RepoAccountPicker({
  repo,
  onChange,
  className = '',
}: {
  repo: string;
  /** Fires after a successful change, with the freshly graded list. */
  onChange?: (accounts: readonly RepoAccountOption[]) => void;
  className?: string;
}): JSX.Element | null {
  const [accounts, setAccounts] = useState<readonly RepoAccountOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAccounts(null);
    void codeApi
      .repoAccounts(repo)
      .then((r) => {
        if (!cancelled) setAccounts(r.accounts);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const select = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        const { accounts: next } = await codeApi.setRepoAccount(repo, value === AUTOMATIC ? null : value);
        setAccounts(next);
        setError(null);
        onChange?.(next);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [repo, onChange],
  );

  // Nothing to choose between: one credential is not a decision.
  if (!accounts || accounts.length < 2) return null;

  const bound = accounts.find((a) => a.bound);
  return (
    <div className={className}>
      <Dropdown
        ariaLabel={`GitHub account acting on ${repo}`}
        value={bound?.id ?? AUTOMATIC}
        disabled={busy}
        onChange={(v) => void select(v)}
        options={[
          { value: AUTOMATIC, label: 'Automatic', hint: 'first of your accounts with the needed permission' },
          ...accounts.map((a) => ({
            value: a.id,
            label: a.login,
            hint: a.permission === null ? 'no access to this repo' : REPO_PERMISSION_LABEL[a.permission],
          })),
        ]}
      />
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
