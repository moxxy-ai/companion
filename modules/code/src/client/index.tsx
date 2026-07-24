import { defineClientModule } from '@companion/core/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';
import { onboarding } from './onboarding.js';

/**
 * The `/client` barrel — module-code's web surface: the Code sidebar group +
 * issues/PRs/pipelines/repos/github/overview routes, the GitHub-flavored
 * widget set, and the pieces downstream modules reach by name.
 */

export * from './widgets.js';
export { useWorkspaceRepos } from './hooks/useWorkspaceRepos.js';
export { CommentsSection } from './components/Comments.js';
export { AccountPicker } from './components/AccountPicker.js';
export { RepoAccountPicker } from './components/RepoAccountPicker.js';
export { BranchPicker } from './components/BranchPicker.js';
export { RepoUnavailableRow } from './components/RepoUnavailableRow.js';
export { codeApi } from './api.js';

export default defineClientModule({
  manifest,
  sections,
  nav,
  routes,
  onboarding,
});
