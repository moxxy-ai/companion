/**
 * Minimal GitHub REST client on global fetch — no octokit dependency tree.
 * ETag-aware GETs keep polling cheap against the 5k/hr PAT budget.
 */

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const API = 'https://api.github.com';

export class GitHubClient {
  private readonly etags = new Map<string, { etag: string; body: unknown }>();
  private readonly branchCache = new Map<string, { at: number; branches: GhBranch[] }>();
  private readonly branchInflight = new Map<string, Promise<GhBranch[]>>();

  constructor(private readonly token: string) {}

  /** GET with ETag cache. Returns the cached body on 304. */
  async get<T>(path: string): Promise<T> {
    const cached = this.etags.get(path);
    const res = await fetch(`${API}${path}`, {
      headers: {
        ...this.headers(),
        ...(cached ? { 'if-none-match': cached.etag } : {}),
      },
    });
    if (res.status === 304 && cached) return cached.body as T;
    if (!res.ok) throw await this.error(res, path);
    const body = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (etag) this.etags.set(path, { etag, body });
    return body;
  }

  async post<T>(path: string, payload: unknown): Promise<T> {
    return this.send<T>('POST', path, payload);
  }

  async patch<T>(path: string, payload: unknown): Promise<T> {
    return this.send<T>('PATCH', path, payload);
  }

  async viewer(): Promise<{ login: string }> {
    return this.get<{ login: string }>('/user');
  }

  /** Repositories the token can see (owner/collaborator/org), newest push first, paged. */
  async viewerRepos(maxPages = 3): Promise<GhRepoSummary[]> {
    const collected: GhRepoSummary[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<GhRepoSummary[]>(`/user/repos?per_page=100&sort=pushed&direction=desc&page=${page}`);
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected;
  }

  async repo(fullName: string): Promise<{
    full_name: string;
    default_branch: string;
    private: boolean;
    owner: { login: string };
    name: string;
    /** What THIS token may do here — absent only on unauthenticated reads. */
    permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
  }> {
    return this.get(`/repos/${fullName}`);
  }

  /** Existing remote branches, paged and bounded to protect the GitHub budget. */
  async branches(fullName: string, maxPages = 20): Promise<GhBranch[]> {
    const cached = this.branchCache.get(fullName);
    if (cached && Date.now() - cached.at < 60_000) return cached.branches;
    const pending = this.branchInflight.get(fullName);
    if (pending) return pending;
    const load = (async (): Promise<GhBranch[]> => {
      const collected: GhBranch[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const batch = await this.get<GhBranch[]>(`/repos/${fullName}/branches?per_page=100&page=${page}`);
        collected.push(...batch);
        if (batch.length < 100) break;
      }
      this.branchCache.set(fullName, { at: Date.now(), branches: collected });
      return collected;
    })();
    this.branchInflight.set(fullName, load);
    try {
      return await load;
    } finally {
      this.branchInflight.delete(fullName);
    }
  }

  /** All issues (open+closed, no PRs) sorted by updated, paged. */
  async issues(
    fullName: string,
    opts: { since?: string; maxPages?: number } = {},
  ): Promise<GhIssue[]> {
    const collected: GhIssue[] = [];
    const maxPages = opts.maxPages ?? 10;
    for (let page = 1; page <= maxPages; page++) {
      const since = opts.since ? `&since=${encodeURIComponent(opts.since)}` : '';
      const batch = await this.get<GhIssue[]>(
        `/repos/${fullName}/issues?state=all&per_page=100&sort=updated&direction=desc&page=${page}${since}`,
      );
      // The issues endpoint interleaves PRs (they carry `pull_request`) —
      // keep them: the sync harvests PR comment counts from these rows.
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected;
  }

  async pulls(fullName: string, maxPages = 5): Promise<GhPull[]> {
    const collected: GhPull[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.get<GhPull[]>(
        `/repos/${fullName}/pulls?state=all&per_page=100&sort=updated&direction=desc&page=${page}`,
      );
      collected.push(...batch);
      if (batch.length < 100) break;
    }
    return collected;
  }

  /** One PR's current state — used to refresh the cache right after an action. */
  async pull(fullName: string, number: number): Promise<GhPull> {
    return this.get<GhPull>(`/repos/${fullName}/pulls/${number}`);
  }

  /** One issue's current state — used to refresh the cache right after an action. */
  async issue(fullName: string, number: number): Promise<GhIssue> {
    return this.get<GhIssue>(`/repos/${fullName}/issues/${number}`);
  }

  async issueComments(fullName: string, issueNumber: number): Promise<Array<{ user: { login: string } | null; body: string; created_at: string }>> {
    return this.get(`/repos/${fullName}/issues/${issueNumber}/comments?per_page=50`);
  }

  async prReviewList(fullName: string, prNumber: number): Promise<GhReview[]> {
    return this.get(`/repos/${fullName}/pulls/${prNumber}/reviews?per_page=100`);
  }

  /** Inline (file/line-anchored) review comments on a PR. */
  async prReviewComments(fullName: string, prNumber: number): Promise<GhReviewComment[]> {
    return this.get(`/repos/${fullName}/pulls/${prNumber}/comments?per_page=100`);
  }

  async addLabels(fullName: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.post(`/repos/${fullName}/issues/${issueNumber}/labels`, { labels });
  }

  /** Close/reopen an issue (works for PR numbers too via the issues API). */
  async updateIssueState(fullName: string, issueNumber: number, state: 'open' | 'closed'): Promise<void> {
    await this.patch(`/repos/${fullName}/issues/${issueNumber}`, { state });
  }

  async comment(fullName: string, issueNumber: number, body: string): Promise<{ html_url: string }> {
    return this.post(`/repos/${fullName}/issues/${issueNumber}/comments`, { body });
  }

  async createPr(
    fullName: string,
    args: { title: string; head: string; base: string; body: string },
  ): Promise<{ html_url: string; number: number }> {
    return this.post(`/repos/${fullName}/pulls`, args);
  }

  /** Check runs for a commit (GitHub Actions + apps). */
  async checkRuns(fullName: string, ref: string): Promise<GhCheckRun[]> {
    const body = await this.get<{ check_runs: GhCheckRun[] }>(
      `/repos/${fullName}/commits/${ref}/check-runs?per_page=100`,
    );
    return body.check_runs ?? [];
  }

  /** Legacy combined commit status (CircleCI et al. still use it). */
  async combinedStatus(fullName: string, ref: string): Promise<GhCombinedStatus> {
    return this.get<GhCombinedStatus>(`/repos/${fullName}/commits/${ref}/status`);
  }

  /**
   * Changed files via the paginated files API — resilient to large PRs that the
   * single-payload `.diff` endpoint rejects (406). Pages are capped to bound the
   * response; `truncated` flags a PR that exceeds the cap.
   */
  async prFiles(fullName: string, number: number, maxPages = 15): Promise<{ files: GhPrFile[]; truncated: boolean }> {
    const files: GhPrFile[] = [];
    let full = false;
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`${API}/repos/${fullName}/pulls/${number}/files?per_page=100&page=${page}`, {
        headers: this.headers(),
      });
      if (!res.ok) throw await this.error(res, `/repos/${fullName}/pulls/${number}/files`);
      const batch = (await res.json()) as GhPrFile[];
      files.push(...batch);
      full = batch.length === 100;
      if (!full) break;
    }
    return { files, truncated: full };
  }

  /** Post a PR review (COMMENT / APPROVE / REQUEST_CHANGES). */
  async createPrReview(
    fullName: string,
    number: number,
    args: { body: string; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' },
  ): Promise<{ html_url: string }> {
    return this.post(`/repos/${fullName}/pulls/${number}/reviews`, args);
  }

  async mergePr(
    fullName: string,
    number: number,
    method: 'merge' | 'squash' | 'rebase' = 'squash',
  ): Promise<{ merged: boolean; message: string }> {
    const res = await fetch(`${API}/repos/${fullName}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ merge_method: method }),
    });
    if (!res.ok) throw await this.error(res, `/repos/${fullName}/pulls/${number}/merge`);
    return (await res.json()) as { merged: boolean; message: string };
  }

  async closePr(fullName: string, number: number): Promise<void> {
    await this.patch(`/repos/${fullName}/pulls/${number}`, { state: 'closed' });
  }

  /**
   * Best-effort head-branch cleanup after a merge. Same-repo heads only — a
   * fork's ref is not ours to delete, and a same-named base-repo branch must
   * not be collateral. Returns false when skipped (fork / unknown head repo).
   */
  async deleteMergedPrBranch(fullName: string, number: number): Promise<boolean> {
    const pr = await this.pull(fullName, number);
    if (pr.head.repo?.full_name !== fullName) return false;
    const res = await fetch(`${API}/repos/${fullName}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    // 422 = ref already gone (raced GitHub's own auto-delete) — that's success.
    if (!res.ok && res.status !== 422) throw await this.error(res, `/repos/${fullName}/git/refs/heads/${pr.head.ref}`);
    return true;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'companion-daemon',
    };
  }

  private async send<T>(method: string, path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await this.error(res, path);
    return (await res.json()) as T;
  }

  private async error(res: Response, path: string): Promise<GitHubError> {
    const body = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(body) as { message?: string; errors?: Array<{ message?: string } | string> };
      if (parsed.message) message = parsed.message;
      // 422s carry the actual reason in errors[] ("Can not request changes on
      // your own pull request", ...) — without it the failure is undebuggable.
      const details = (parsed.errors ?? [])
        .map((e) => (typeof e === 'string' ? e : e.message))
        .filter((m): m is string => Boolean(m));
      if (details.length > 0) message += ` — ${details.join('; ')}`;
    } catch {
      // keep the status line
    }
    return new GitHubError(`GitHub ${path}: ${message}`, res.status);
  }
}

export interface GhRepoSummary {
  full_name: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  archived: boolean;
}

export interface GhBranch {
  name: string;
  protected: boolean;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name?: string } | string>;
  user: { login: string } | null;
  assignees: Array<{ login: string }> | null;
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  closed_at: string | null;
  draft?: boolean;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login: string }> | null;
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base: { ref: string };
  /** Only on the single-PR GET and webhook payloads (never the list); null = still computing. */
  mergeable?: boolean | null;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GhReview {
  user: { login: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body?: string | null;
  submitted_at: string | null;
}

export interface GhReviewComment {
  user: { login: string } | null;
  body: string;
  path: string;
  /** Line in the current diff; original_line survives force-pushes. */
  line: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  created_at: string;
}

export interface GhPrFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GhCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale'
    | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface GhCombinedStatus {
  state: 'success' | 'failure' | 'pending' | 'error';
  statuses: Array<{
    context: string;
    state: 'success' | 'failure' | 'pending' | 'error';
    target_url: string | null;
    created_at: string;
    updated_at: string;
  }>;
}
