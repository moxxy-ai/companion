import { del, patch, post, put, qs, request, type PageQuery } from '@companion/core/client';
import type { RunRecord } from '@companion/module-operate/contract';
import type { ReportRecord } from '@companion/module-workspace/contract';
import type {
  ChecksSummary,
  CommentRecord,
  GitHubAccountRecord,
  GitHubAccountScope,
  GitHubPurpose,
  IssueRecord,
  PipelineRecord,
  PipelineRunRecord,
  PrFileChange,
  PrRecord,
  PrReviewResult,
  RepoCandidate,
  RepoRecord,
  SavePipelineRequest,
  SaveStepDefinitionRequest,
  StepDefinitionRecord,
  TriageResult,
} from '../contract/index.js';

/**
 * module-code's REST surface, carved from the legacy `lib/api.ts`: repositories
 * + the GitHub account registry, the workspace-scoped issue/PR/pipeline feeds,
 * issue triage + fixes, PR reviews/checks/lifecycle, and the pipeline + step
 * library CRUD. HTTP + token plumbing lives in `@companion/core/client`.
 */

export const codeApi = {
  // repos
  listRepos: () => request<{ repos: RepoRecord[] }>('/api/repos'),
  addRepo: (fullName: string, workspaceId: string) =>
    post<{ repo: RepoRecord }>('/api/repos', { fullName, workspaceId }),
  /** Repos the reachable GitHub accounts can see — feeds the add-repo picker. */
  repoCandidates: (workspaceId: string) =>
    request<{ candidates: RepoCandidate[] }>(`/api/github/repo-candidates?workspaceId=${encodeURIComponent(workspaceId)}`),
  removeRepo: (fullName: string) => del<{ ok: true }>(`/api/repos/${fullName}`),
  moveRepo: (fullName: string, workspaceId: string) =>
    post<{ repo: RepoRecord }>(`/api/repos/${fullName}/workspace`, { workspaceId }),
  syncRepo: (fullName: string) => post<{ issues: number; prs: number }>(`/api/repos/${fullName}/sync`),
  setRepoGithubAccount: (fullName: string, accountId: string | null) =>
    patch<{ repo: RepoRecord }>(`/api/repos/${fullName}/github-account`, { accountId }),
  setRepoRunner: (fullName: string, runnerId: string | null) =>
    patch<{ repo: RepoRecord }>(`/api/repos/${fullName}/runner`, { runnerId }),

  // workspace-scoped feeds
  workspaceRepos: (id: string) => request<{ repos: RepoRecord[] }>(`/api/workspaces/${id}/repos`),
  workspaceIssues: (
    id: string,
    state?: 'open' | 'closed',
    page?: PageQuery & { author?: string; assignee?: string; label?: string; triage?: string },
  ) =>
    request<{
      issues: IssueRecord[];
      total: number;
      counts: { open: number; closed: number };
      facets: { authors: string[]; assignees: string[]; labels: string[] };
    }>(`/api/workspaces/${id}/issues${qs({ state, ...page })}`),
  workspacePrs: (
    id: string,
    state?: 'open' | 'merged' | 'closed',
    page?: PageQuery & { author?: string; assignee?: string; decision?: string; draft?: string; review?: string },
  ) =>
    request<{
      prs: PrRecord[];
      total: number;
      counts: { open: number; merged: number; closed: number };
      facets: { authors: string[]; assignees: string[] };
    }>(`/api/workspaces/${id}/prs${qs({ state, ...page })}`),
  workspacePipelines: (id: string) =>
    request<{ pipelines: PipelineRecord[]; stepDefinitions: StepDefinitionRecord[] }>(
      `/api/workspaces/${id}/pipelines`,
    ),
  workspacePipelineRuns: (id: string) =>
    request<{ runs: PipelineRunRecord[] }>(`/api/workspaces/${id}/pipeline-runs`),

  // issues + triage
  listIssues: (fullName: string, state?: 'open' | 'closed') =>
    request<{ issues: IssueRecord[] }>(`/api/repos/${fullName}/issues${state ? `?state=${state}` : ''}`),
  getIssue: (fullName: string, number: number) =>
    request<{ issue: IssueRecord; triage: TriageResult | null }>(`/api/repos/${fullName}/issues/${number}`),
  issueComments: (fullName: string, number: number) =>
    request<{ comments: CommentRecord[] }>(`/api/repos/${fullName}/issues/${number}/comments`),
  commentIssue: (fullName: string, number: number, body: string) =>
    post<{ url: string }>(`/api/repos/${fullName}/issues/${number}/comment`, { body }),
  setIssueState: (fullName: string, number: number, state: 'open' | 'closed') =>
    post<{ ok: true }>(`/api/repos/${fullName}/issues/${number}/state`, { state }),
  triageIssue: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/issues/${number}/triage`),
  fixIssue: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/issues/${number}/fix`),
  applyTriage: (id: string, comment: boolean, accountId?: string) =>
    post<{ ok: true }>(`/api/triage/${id}/apply${accountId ? `?account=${accountId}` : ''}`, { comment }),
  dismissTriage: (id: string) => post<{ ok: true }>(`/api/triage/${id}/dismiss`),

  // prs
  listPrs: (fullName: string) => request<{ prs: PrRecord[] }>(`/api/repos/${fullName}/prs`),
  getPr: (fullName: string, number: number) =>
    request<{
      pr: PrRecord;
      review: PrReviewResult | null;
      pipelineRuns: PipelineRunRecord[];
      ciAnalysis: ReportRecord | null;
    }>(`/api/repos/${fullName}/prs/${number}`),
  prChecks: (fullName: string, number: number) =>
    request<{ checks: ChecksSummary }>(`/api/repos/${fullName}/prs/${number}/checks`),
  prFiles: (fullName: string, number: number) =>
    request<{ files: PrFileChange[]; truncated: boolean }>(`/api/repos/${fullName}/prs/${number}/files`),
  analyzeFailedChecks: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/prs/${number}/checks/analyze`),
  fixChecks: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/fix-checks`),
  addressReviews: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/address-reviews`),
  resolveConflicts: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/resolve-conflicts`),
  runPrAgent: (fullName: string, number: number, instructions: string) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/agent`, { instructions }),
  prComments: (fullName: string, number: number) =>
    request<{ comments: CommentRecord[] }>(`/api/repos/${fullName}/prs/${number}/comments`),
  commentPr: (fullName: string, number: number, body: string) =>
    post<{ url: string }>(`/api/repos/${fullName}/prs/${number}/comment`, { body }),
  analyzePr: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/prs/${number}/analyze`),
  mergePr: (fullName: string, number: number, method: 'merge' | 'squash' | 'rebase') =>
    post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/merge`, { method }),
  closePr: (fullName: string, number: number) => post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/close`),
  applyPrReview: (id: string, accountId?: string) =>
    post<{ ok: true }>(`/api/pr-reviews/${id}/apply${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`),
  dismissPrReview: (id: string) => post<{ ok: true }>(`/api/pr-reviews/${id}/dismiss`),

  // pipelines + step library
  createPipeline: (workspaceId: string, body: SavePipelineRequest) =>
    post<{ pipeline: PipelineRecord }>(`/api/workspaces/${workspaceId}/pipelines`, body),
  updatePipeline: (id: string, body: SavePipelineRequest) =>
    put<{ pipeline: PipelineRecord }>(`/api/pipelines/${id}`, body),
  deletePipeline: (id: string) => del<{ ok: true }>(`/api/pipelines/${id}`),
  createStepDefinition: (workspaceId: string, body: SaveStepDefinitionRequest) =>
    post<{ stepDefinition: StepDefinitionRecord }>(`/api/workspaces/${workspaceId}/step-definitions`, body),
  updateStepDefinition: (id: string, body: SaveStepDefinitionRequest) =>
    put<{ stepDefinition: StepDefinitionRecord }>(`/api/step-definitions/${id}`, body),
  deleteStepDefinition: (id: string) => del<{ ok: true }>(`/api/step-definitions/${id}`),
  runPipeline: (repo: string, prNumber: number, pipelineId: string) =>
    post<{ run: PipelineRunRecord }>(`/api/repos/${repo}/prs/${prNumber}/pipelines/${pipelineId}/run`),
  runPipelineOnIssue: (repo: string, issueNumber: number, pipelineId: string) =>
    post<{ run: PipelineRunRecord }>(`/api/repos/${repo}/issues/${issueNumber}/pipelines/${pipelineId}/run`),
  runPlatformPipeline: (repo: string, pipelineId: string) =>
    post<{ run: PipelineRunRecord }>(`/api/repos/${repo}/pipelines/${pipelineId}/run`),
  issuePipelineRuns: (repo: string, issueNumber: number) =>
    request<{ runs: PipelineRunRecord[] }>(`/api/repos/${repo}/issues/${issueNumber}/pipeline-runs`),
  prPipelineRuns: (repo: string, prNumber: number) =>
    request<{ runs: PipelineRunRecord[] }>(`/api/repos/${repo}/prs/${prNumber}/pipeline-runs`),
  pipelineRun: (id: string) => request<{ run: PipelineRunRecord }>(`/api/pipeline-runs/${id}`),

  // AI generation (bounded companion runner turns)
  generateStepDefinition: (workspaceId: string, instructions: string) =>
    post<{ stepDefinition: StepDefinitionRecord }>(`/api/workspaces/${workspaceId}/step-definitions/generate`, {
      instructions,
    }),
  generatePipeline: (workspaceId: string, instructions: string) =>
    post<{ pipeline: PipelineRecord }>(`/api/workspaces/${workspaceId}/pipelines/generate`, { instructions }),

  // GitHub accounts
  listGithubAccounts: () => request<{ accounts: GitHubAccountRecord[] }>('/api/github/accounts'),
  addGithubAccount: (
    token: string,
    purposes: readonly GitHubPurpose[],
    scope: GitHubAccountScope = 'shared',
    workspaceIds: readonly string[] = [],
    shared = false,
  ) => post<{ account: GitHubAccountRecord }>('/api/github/accounts', { token, purposes, scope, workspaceIds, shared }),
  updateGithubAccount: (
    id: string,
    fields: { purposes?: readonly GitHubPurpose[]; scope?: GitHubAccountScope; workspaceIds?: readonly string[] },
  ) => patch<{ account: GitHubAccountRecord }>(`/api/github/accounts/${id}`, fields),
  removeGithubAccount: (id: string) => del<{ ok: true }>(`/api/github/accounts/${id}`),
  setGithubToken: (t: string) => post<{ login: string }>('/api/settings/github', { token: t }),
};
