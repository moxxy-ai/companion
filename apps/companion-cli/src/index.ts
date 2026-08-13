import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegularTextFile, type AuthMode } from '@moxxy/companion-services';
import {
  applyPendingAdminSetup,
  consumePendingAdminSetup,
  createDefaultAdmin,
  readAdminSetup,
  readStoredAuthMode,
  renderSetupBox,
  scrubSeedPasswordEnvironment,
  setupExists,
  validateEmail,
  validatePassword,
  validateUsername,
  takePendingProfile,
  writePendingAdminSetup,
  writePendingProfile,
  writeStoredAuthMode,
} from './setup.js';
import type { AdminSetup } from './setup.js';
import {
  installModules,
  modulesFor,
  profileFromEnv,
  waitForToken,
} from './profile.js';
import {
  harnessChoices,
  NOTHING_INSTALLED,
  readHarnessOptions,
  recommendedHarnesses,
  saveHarnesses,
} from './harnesses.js';
import { offerBuiltinProvider, parseProviderCommand, runProviderCommand, PROVIDER_HELP } from './providers.js';
import { withTerminal } from './terminal.js';
import { addRepo, declinedRepos, declineRepo, detectRepo, firstWorkspaceId, trackedRepos } from './repo.js';
import { backupDatabase, restoreDatabase } from './backup.js';
import { rotateSecretKey } from './rotate-key.js';
import { RUN_HELP, parseRunCommand, runRunCommand } from './runs.js';
import {
  connectGhAccount,
  detectGhLogin,
  importPendingGhAccount,
  pendingGhLogin,
  resolveGithubHost,
  scheduleGhImport,
} from './github.js';
import { MODULE_HELP, parseModuleCommand, runModuleCommand } from './modules.js';
import { ACL_HELP, parseAclCommand, runAclCommand } from './acl.js';
import { daemonLog, runningPid, startDetached, stopDaemon, tailLog, waitUntilServing } from './daemon.js';
import type { Detached } from './daemon.js';
import { apiClient } from './client.js';
import { MCP_HELP, resolveMcpBaseUrl, runMcpServer } from './mcp.js';
import { assertSupportedNode, DOCTOR_HELP, parseDoctorArgs, runDoctor } from './doctor.js';
import { COMPANION_VERSION } from './version.js';

/** Commands that talk to a running daemon instead of starting one. */
const CLIENT_COMMANDS = ['module', 'provider', 'acl', 'role', 'user', 'run', 'mcp', 'doctor'] as const;
type ClientCommand = (typeof CLIENT_COMMANDS)[number];

interface CliOptions {
  readonly command: 'start' | 'stop' | 'init' | 'connect-github' | 'backup' | 'restore' | 'rotate-key' | ClientCommand;
  readonly home: string;
  readonly host?: string;
  readonly port?: number;
  readonly open: boolean;
  readonly yes: boolean;
  readonly withAuth: boolean;
  readonly githubFromGh: boolean;
  readonly verbose: boolean;
  readonly background: boolean;
  /** Positional path for `backup` / `restore`. */
  readonly file?: string;
  /** Replacement key for `rotate-key`, when the operator supplies their own. */
  readonly newKey?: string;
}

/**
 * The mark rasterized from its own geometry by docs/brand/ascii.mjs. The dot is
 * emerald because green already means AI everywhere else in this product; it is
 * the only element of the mark allowed to carry colour.
 */
const BANNER = `
                 .....
           ..:###########:.
         .:#################:.
       .#####:..       .:#####:
      .####:              .:##:
     .####.
     ####.                   \x1b[38;5;42m.:::.\x1b[0m
     ####                   \x1b[38;5;42m.######\x1b[0m
     ####                   \x1b[38;5;42m.######\x1b[0m
     ####.                   \x1b[38;5;42m.:::.\x1b[0m
     .####.
      .####:              .:##:
       .#####:..       .:#####:
         .:#################:.
           ..:###########:.
                 .....

           c o m p a n i o n

`;

const HELP = `@moxxy/companion: run Companion locally

Usage:
  npx @moxxy/companion                  Initialize when needed, start, open browser
  npx @moxxy/companion --background     Same, but leave it running without a terminal
  npx @moxxy/companion stop             Stop the daemon using this data directory
  npx @moxxy/companion init             Prepare the local data directory only
  npx @moxxy/companion connect-github   Connect active gh to an existing Companion user
  npx @moxxy/companion run list         Runs awaiting you; also show/diff/approve/discard
  npx @moxxy/companion mcp              Safe stdio MCP: read state, prepare reviewed actions
  npx @moxxy/companion doctor           Redacted local installation diagnostics
  npx @moxxy/companion backup [file]    Snapshot the database (safe while running)
  npx @moxxy/companion restore <file>   Replace the database from a snapshot (stop first)
  npx @moxxy/companion rotate-key       Re-encrypt stored secrets under a new key (stop first)
  npx @moxxy/companion module ...       Inspect and toggle modules (see: module --help)
  npx @moxxy/companion acl ...          Inspect the live permission grid (see: acl --help)
  npx @moxxy/companion role ...         Create and edit roles
  npx @moxxy/companion user role <username> <role>

Options:
  --home <path>    Data directory (default: COMPANION_HOME or ~/.companion)
  --host <host>    Bind host for this run (default: 127.0.0.1)
  --port <port>    HTTP port for this run (default: 8901)
  --no-open        Do not open a browser
  --background     Run the daemon detached; logs go to <home>/companiond.log
  -y, --yes        Accept secure generated defaults without prompting
  --with-auth      Require Companion sign-in (default: trusted loopback session)
  --github-from-gh Deprecated; active gh is connected automatically
  --verbose        Show daemon startup and diagnostic logs
  --new-key <key>  Replacement key for rotate-key (base64url or 64 hex chars)
  -v, --version    Show the Companion version
  -h, --help       Show this help

The default local flow installs the slim module set, detects available agent
runtimes, connects the active gh account, and opens the app without a login form.
`;

class SetupCancelled extends Error {}

/**
 * Where the operator ran this, captured before anything moves. `start` chdirs
 * into the data directory to boot the daemon, and by then the one directory
 * that says which repository this is about is gone.
 */
const INVOKED_FROM = process.cwd();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    process.stdout.write(`${COMPANION_VERSION}\n`);
    return;
  }
  const group = CLIENT_COMMANDS.find((c) => c === argv[0]);
  if (group !== 'doctor' && !argv.includes('--help') && !argv.includes('-h') && !argv.includes('help')) {
    assertSupportedNode();
  }
  if (group) {
    const { cli, rest } = splitClientArgs(argv);
    if ((group !== 'mcp' && group !== 'doctor' && !rest.length) || rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(
        group === 'module'
          ? MODULE_HELP
          : group === 'provider'
            ? PROVIDER_HELP
            : group === 'run'
              ? RUN_HELP
              : group === 'mcp'
                ? MCP_HELP
                : group === 'doctor'
                  ? DOCTOR_HELP
                : ACL_HELP,
      );
      return;
    }
    const options = parseArgs([group, ...cli]);
    // paths.cliToken() and the stored address both resolve from COMPANION_HOME.
    process.env.COMPANION_HOME = options.home;
    const { host, port } = resolveAddress(options);
    const url = localUrl(host, port);
    if (group === 'doctor') {
      await runDoctor({ home: options.home, baseUrl: url, host, port, ...parseDoctorArgs(rest) });
    } else if (group === 'mcp') {
      if (rest.length) throw new Error(`Unknown argument: ${rest[0]}\n\n${MCP_HELP}`);
      const baseUrl = resolveMcpBaseUrl(url);
      await runMcpServer(apiClient(baseUrl, process.env.COMPANION_TOKEN, 30_000));
    } else if (group === 'module') await runModuleCommand(parseModuleCommand(rest), url);
    else if (group === 'provider') await runProviderCommand(parseProviderCommand(rest), url);
    else if (group === 'run') await runRunCommand(parseRunCommand(rest), url);
    else await runAclCommand(parseAclCommand(group, rest, options.home), url);
    return;
  }

  const options = parseArgs(argv);
  if (options.command === 'stop') {
    process.env.COMPANION_HOME = options.home;
    const { host, port } = resolveAddress(options);
    await stopDaemon(options.home, localUrl(host, port));
    return;
  }
  if (options.command === 'backup' || options.command === 'restore') {
    process.env.COMPANION_HOME = options.home;
    const { host, port } = resolveAddress(options);
    const url = localUrl(host, port);
    if (options.command === 'backup') {
      const target =
        options.file ?? join(options.home, `companion-backup-${new Date().toISOString().slice(0, 10)}.db`);
      await backupDatabase(options.home, target, url);
    } else {
      if (!options.file) throw new Error('Which snapshot? Usage: companion restore <file>');
      await restoreDatabase(options.home, options.file, url);
    }
    return;
  }
  if (options.command === 'rotate-key') {
    process.env.COMPANION_HOME = options.home;
    const { host, port } = resolveAddress(options);
    await rotateSecretKey(options.home, localUrl(host, port), options.newKey ? { newKey: options.newKey } : {});
    return;
  }
  if (options.command === 'connect-github') {
    await connectGithub(options);
    return;
  }
  // Before initialize below: gh host resolution and the daemon both read
  // stored config and .env layers from COMPANION_HOME.
  process.env.COMPANION_HOME = options.home;
  // Decoration, so only when a person is watching: piped output stays clean.
  // NO_COLOR still gets the mark, just without the emerald on the dot.
  if (process.stdout.isTTY) {
    process.stdout.write(process.env.NO_COLOR ? BANNER.replace(/\x1b\[[0-9;]*m/g, '') : BANNER);
  }
  const initialized = setupExists(options.home);
  const storedMode = readStoredAuthMode(options.home);
  const envMode = process.env.COMPANION_AUTH_MODE?.trim();
  if (envMode && envMode !== 'local' && envMode !== 'password') {
    throw new Error(`Invalid COMPANION_AUTH_MODE=${envMode}; expected local or password.`);
  }
  const effectiveMode: AuthMode = options.withAuth
    ? 'password'
    : (envMode as AuthMode | undefined) ?? storedMode ?? (initialized ? 'password' : 'local');
  if (storedMode === 'local' && effectiveMode === 'password') {
    throw new Error(
      'This data directory already uses trusted local mode. Use a new --home for password auth; ' +
        'an in-place switch would leave its passwordless admin without a usable credential.',
    );
  }
  if (options.withAuth) process.env.COMPANION_AUTH_MODE = 'password';
  const { host } = resolveAddress(options);
  if (effectiveMode === 'local' && host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error(`Trusted local mode cannot bind to ${host}. Re-run with --with-auth before exposing Companion.`);
  }
  if (!initialized) await initialize(options, effectiveMode);
  else if (options.command === 'init') {
    process.stdout.write(`Companion is already initialized in ${options.home}\n`);
    return;
  }
  if (options.command === 'init') return;
  await start(options);
}

async function connectGithub(options: CliOptions): Promise<void> {
  process.env.COMPANION_HOME = options.home;
  const { host, port } = resolveAddress(options);
  const url = localUrl(host, port);
  if (!(await waitForHealth(url, 2_000))) {
    throw new Error(`Companion is not running at ${url}. Start it first, then retry.`);
  }

  const ghHost = resolveGithubHost();
  const ghLogin = detectGhLogin(ghHost);
  if (!ghLogin) throw new Error(`gh is not authenticated for ${ghHost}. Run \`gh auth login\` and retry.`);
  const localToken = await waitForToken();
  if (localToken) {
    process.stdout.write(`Connecting active gh account ${ghLogin} to Companion at ${url}...\n`);
    await connectGhAccount(url, { bearerToken: localToken }, ghLogin);
    process.stdout.write(`Connected GitHub account ${ghLogin}.\n`);
    return;
  }

  const stored = readAdminSetup(options.home);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !options.yes);
  let credentials = stored;
  if (interactive) {
    const { input, password } = await import('@inquirer/prompts');
    const username = await input({
      message: 'Companion username',
      default: stored?.username ?? 'admin',
      validate: validateUsername,
    });
    const chosenPassword = await password({
      message: 'Companion password',
      mask: '*',
      validate: (value) => value.length > 0 || 'Enter your Companion password.',
    });
    credentials = {
      username: username.trim(),
      password: chosenPassword,
      email: stored?.email ?? '',
      passwordSource: 'chosen',
    };
  }
  if (!credentials) {
    throw new Error(
      'Companion credentials are required in non-interactive mode. Set COMPANION_ADMIN_USER and COMPANION_ADMIN_PASSWORD or run interactively.',
    );
  }

  process.stdout.write(`Connecting active gh account ${ghLogin} to Companion user ${credentials.username} at ${url}...\n`);
  try {
    await connectGhAccount(url, credentials, ghLogin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/invalid credentials/i.test(message)) {
      throw new Error(
        'Companion rejected those credentials. Admin env variables only seed an empty database; enter the existing Companion username and password.',
      );
    }
    throw err;
  }
  process.stdout.write(`Connected GitHub account ${ghLogin} to Companion user ${credentials.username}.\n`);
}

async function initialize(options: CliOptions, authMode: AuthMode): Promise<void> {
  process.stdout.write('\nWelcome to Companion.\n\n');
  const { host, port } = resolveAddress(options);
  const url = localUrl(host, port);
  const modules = await resolveProfile();
  const ghLogin = detectGhLogin();

  if (authMode === 'local') {
    writeStoredAuthMode(options.home, authMode);
    writePendingProfile(options.home, modules);
    if (ghLogin) scheduleGhImport(options.home, ghLogin);
    process.stdout.write(
      `Trusted local mode · ${url}\n` +
        'Companion will open as the local superadmin; no account or password is required.\n' +
        'Use --with-auth with a fresh data directory for a shared or networked instance.\n',
    );
    if (ghLogin) process.stdout.write(`Active gh account ${ghLogin} will be connected automatically.\n`);
    if (options.command === 'init') process.stdout.write('\nNext: npx @moxxy/companion\n');
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !options.yes);
  const setup = interactive ? await promptForAdmin() : createDefaultAdmin();
  process.stdout.write(`${renderSetupBox(setup, options.home, url)}\n`);

  if (interactive) {
    const { confirm } = await import('@inquirer/prompts');
    const accepted = await confirm({ message: 'Create this local configuration?', default: true });
    if (!accepted) throw new SetupCancelled('Setup cancelled.');
  } else {
    process.stdout.write('Using secure generated defaults because prompting was skipped.\n');
  }

  writeStoredAuthMode(options.home, authMode);
  writePendingProfile(options.home, modules);
  if (ghLogin) scheduleGhImport(options.home, ghLogin);
  const file = writePendingAdminSetup(options.home, setup);
  if (ghLogin) {
    process.stdout.write(`Will connect gh account ${ghLogin} to admin ${setup.username} when Companion starts.\n`);
  }
  process.stdout.write(`\nSaved one-time bootstrap data in ${file} with owner-only permissions.\n`);
  // The generated credential exists nowhere else, so it must be shown once.
  if (setup.passwordSource === 'generated') {
    process.stdout.write('Save the generated password now; it will not be shown on later starts.\n');
  }
  if (options.command === 'init') process.stdout.write('\nNext: npx @moxxy/companion\n');
}

/** npx stays on the slim DX unless an advanced scripted run explicitly opts in. */
async function resolveProfile(): Promise<readonly string[]> {
  const fromEnv = profileFromEnv();
  if (fromEnv) {
    process.stdout.write(`Module set: ${fromEnv} (from COMPANION_PROFILE).\n`);
    return modulesFor(fromEnv);
  }
  return modulesFor('slim');
}

/** Full auth asks for the credential instead of shipping a well-known default. */
async function promptForAdmin(): Promise<AdminSetup> {
  const { input, password } = await import('@inquirer/prompts');
  const username = await input({ message: 'Admin username', default: 'admin', validate: validateUsername });
  const email = await input({ message: 'Admin email', default: 'admin@companion.local', validate: validateEmail });
  const chosen = await password({ message: 'Admin password', mask: '*', validate: validatePassword });
  await password({
    message: 'Confirm password',
    mask: '*',
    validate: (value) => value === chosen || 'Passwords do not match.',
  });
  return { username: username.trim(), email: email.trim(), password: chosen, passwordSource: 'chosen' };
}

async function start(options: CliOptions): Promise<void> {
  const { host, port } = resolveAddress(options);
  const url = localUrl(host, port);
  const bundleDir = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(bundleDir, 'web');
  const server = join(bundleDir, 'server.js');
  if (!existsSync(join(staticDir, 'index.html')) || !existsSync(server)) {
    throw new Error('Companion bundle is incomplete. Reinstall @moxxy/companion.');
  }

  // A daemon that outlives its terminal is one someone will start twice. Booting
  // anyway means waiting out the instance lock for 75 seconds to be told what is
  // already knowable here, so treat a second `npx` as "show me the one I have".
  const already = runningPid(options.home);
  if (already !== null) {
    process.stdout.write(`\nCompanion is already running at ${url} (pid ${already}).\n`);
    process.stdout.write(`Stop it with: npx @moxxy/companion stop\n`);
    if (options.open) openBrowser(url);
    return;
  }

  process.env.COMPANION_HOME = options.home;
  // The one-command experience stays focused on actionable status. Warnings
  // and errors still surface; developers running `pnpm dev` keep full logs.
  if (options.verbose) process.env.COMPANION_LOG_LEVEL = 'info';
  else process.env.COMPANION_LOG_LEVEL ??= 'warn';
  const hasPendingAdmin = applyPendingAdminSetup(options.home) !== null;
  // A pending import is completed synchronously through the CLI token below;
  // keep the module's opportunistic boot import from racing the same account.
  process.env.COMPANION_IMPORT_LOCAL_GH = pendingGhLogin(options.home) ? 'false' : 'true';
  process.env.COMPANION_STATIC_DIR = staticDir;
  if (options.host !== undefined) process.env.COMPANION_HOST = options.host;
  if (options.port !== undefined) process.env.COMPANION_PORT = String(options.port);

  const note = options.background ? `Logs: ${daemonLog(options.home)}` : 'Press Ctrl+C to stop.';
  process.stdout.write(`\nStarting Companion at ${url}\nData directory: ${options.home}\n${note}\n\n`);
  const pendingModules = takePendingProfile(options.home);
  const firstRun = pendingModules.length > 0 || hasPendingAdmin;
  // Either way this process stays in the foreground until the questions below
  // are answered; what --background changes is who owns the server afterwards.
  let detached: Detached | null = null;
  let outcome: 'ready' | 'timeout' | 'exited';
  if (options.background) {
    detached = startDetached(server, options.home);
    // spawn() has already copied the seed into the daemon. Do not let the CLI
    // retain it while it subsequently invokes gh, git or the system browser.
    scrubSeedPasswordEnvironment();
    outcome = await waitUntilServing(detached, options.home, url, 30_000);
  } else {
    process.chdir(options.home);
    const ready = waitForHealth(url, 30_000);
    await import(pathToFileURL(server).href);
    outcome = (await ready) ? 'ready' : 'timeout';
  }
  if (outcome !== 'ready') {
    process.exitCode = 1;
    if (outcome === 'exited' && detached) {
      process.stderr.write(
        `Companion exited while starting. Last lines of ${detached.log}:\n\n${tailLog(detached.log)}\n`,
      );
    } else {
      process.stderr.write(
        `Companion did not become ready within 30 seconds. Check ${detached ? detached.log : 'the logs above'}.\n`,
      );
    }
    return;
  }
  if (pendingModules.length) {
    process.stdout.write(`Enabling ${pendingModules.length} optional module(s)…\n`);
    await installModules(url, pendingModules, (line) => process.stdout.write(`${line}\n`));
  }
  // Only on a first run: the machine's runtimes are settled once, and every
  // later start would otherwise re-ask a question that already has an answer.
  if (firstRun) await settleHarnesses(url, options);
  process.stdout.write(`\nCompanion is ready: ${url}\n`);
  const cliToken = await waitForToken();
  if (cliToken) {
    try {
      const githubLogin = await importPendingGhAccount(options.home, url, { bearerToken: cliToken });
      if (githubLogin) process.stdout.write(`Connected GitHub account ${githubLogin}.\n`);
    } catch (err) {
      process.stderr.write(
        `${err instanceof Error ? err.message : String(err)}\nRun \`npx @moxxy/companion connect-github\` to retry.\n`,
      );
    }
  }
  if (hasPendingAdmin) consumePendingAdminSetup(options.home);
  await settleRepo(url, options);
  if (options.open) openBrowser(url);
  if (detached) {
    process.stdout.write(
      `\nRunning in the background (pid ${detached.pid}). Closing this terminal leaves it running.\n` +
        `  logs:  ${detached.log}\n` +
        `  stop:  npx @moxxy/companion stop\n`,
    );
  }
}

/**
 * Offer to add the repository this was started in.
 *
 * Runs on every start rather than only the first, because the answer changes:
 * a second repository is a second `npx` in a second directory, and that is
 * exactly when Companion should ask instead of sending someone to a picker.
 * Nothing is asked twice, since a tracked repository is skipped and a declined
 * one is remembered.
 *
 * After the GitHub import on purpose: adding a repository reads it through a
 * connected account, so asking before one exists would offer something that
 * could only fail.
 */
async function settleRepo(url: string, options: CliOptions): Promise<void> {
  // A scripted install must not reach out to GitHub and add rows nobody asked
  // for, so this is an interactive question or nothing at all.
  if (options.yes || !process.stdin.isTTY) return;
  const fullName = detectRepo(INVOKED_FROM);
  if (!fullName || declinedRepos(options.home).includes(fullName)) return;
  const token = await waitForToken();
  if (!token) return;
  const tracked = await trackedRepos(url, token);
  if (tracked === null || tracked.includes(fullName)) return;

  const { confirm } = await import('@inquirer/prompts');
  // Ctrl+C here is "not now", and it must not take a Companion that already
  // said it was ready down with it. It is also not an answer, so unlike a
  // declined question it is not remembered.
  const accepted = await withTerminal(() =>
    confirm({ message: `Add ${fullName} to Companion?`, default: true }),
  ).catch((err: unknown) => {
    if (err instanceof Error && err.name === 'ExitPromptError') return null;
    throw err;
  });
  if (accepted === null) return;
  if (!accepted) {
    declineRepo(options.home, fullName);
    process.stdout.write(`Leaving ${fullName} out. Add it later from the Repositories page.\n`);
    return;
  }
  const workspaceId = await firstWorkspaceId(url, token);
  if (!workspaceId) {
    process.stderr.write(`Could not read this instance's workspaces, so ${fullName} was not added.\n`);
    return;
  }
  try {
    await addRepo(url, token, fullName, workspaceId);
    process.stdout.write(`Added ${fullName}.\n`);
  } catch (err) {
    process.stderr.write(`Could not add ${fullName}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Which agent runtimes this machine will use, asked once, from what is actually
 * installed on it.
 *
 * Silent when the daemon does not answer: an instance without the execution
 * module has no such question, and saying nothing is better than explaining an
 * absence. Interactive and non-interactive setup share the same detected
 * default, so `--yes` cannot silently select historical moxxy on a machine
 * whose only usable runtime is Codex or Claude Code.
 */
async function settleHarnesses(url: string, options: CliOptions): Promise<void> {
  const token = await waitForToken();
  if (!token) return;
  const answer = await readHarnessOptions(url, token);
  if (!answer) return;
  if (answer.options.length === 0) {
    process.stdout.write(`\n${NOTHING_INSTALLED}\n`);
    return;
  }
  let picked: readonly string[] = recommendedHarnesses(answer.options);
  if (options.withAuth && !options.yes && process.stdin.isTTY) {
    const { checkbox } = await import('@inquirer/prompts');
    picked = await withTerminal(() =>
      checkbox<string>({
        message: 'Which agent runtimes should this machine use?',
        choices: harnessChoices(answer.options).map((c) => ({ ...c })),
      }),
    );
  }
  if (picked.length === 0) {
    process.stdout.write('Nothing ticked, so this machine keeps its current runtime.\n');
    return;
  }
  try {
    await saveHarnesses(url, token, picked);
    process.stdout.write(`Agent work here runs through ${picked.join(', ')}.\n`);
    // The built-in runtime is the one whose "not ready" is fixed HERE rather
    // than in another terminal, so it is offered a model straight away.
    if (picked.includes('companion')) {
      await offerBuiltinProvider(url, token, options.withAuth && !options.yes && process.stdin.isTTY);
    }
  } catch (err) {
    process.stderr.write(`Could not save the runtime choice: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  let command: CliOptions['command'] = 'start';
  let home = process.env.COMPANION_HOME || join(homedir(), '.companion');
  let host: string | undefined;
  let port: number | undefined;
  let open = true;
  let yes = false;
  let withAuth = false;
  let githubFromGh = false;
  let verbose = false;
  let background = false;
  let file: string | undefined;
  let newKey: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (CLIENT_COMMANDS.some((c) => c === arg) && command === 'start') command = arg as ClientCommand;
    else if ((arg === 'init' || arg === 'connect-github' || arg === 'stop') && command === 'start') command = arg;
    else if ((arg === 'backup' || arg === 'restore' || arg === 'rotate-key') && command === 'start') command = arg;
    else if (arg === '--new-key') newKey = requiredValue(argv, ++i, arg);
    // The one positional: the snapshot path these two commands operate on.
    else if ((command === 'backup' || command === 'restore') && !arg.startsWith('-') && file === undefined) file = arg;
    else if (arg === '--home') home = requiredValue(argv, ++i, arg);
    else if (arg === '--host') host = requiredValue(argv, ++i, arg);
    else if (arg === '--port') port = validPort(requiredValue(argv, ++i, arg));
    else if (arg === '--no-open') open = false;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--with-auth') withAuth = true;
    else if (arg === '--github-from-gh') githubFromGh = true;
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--background') background = true;
    else if (arg === '--help' || arg === '-h' || arg === 'help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}\n\n${HELP}`);
  }
  home = isAbsolute(home) ? home : resolve(home);
  return { command, home, host, port, open, yes, withAuth, githubFromGh, verbose, background, file, newKey };
}

/**
 * Sub-command arguments belong to the sub-parser, but the connection flags stay
 * with the CLI: both parsers reject what they do not know, so the split has to
 * happen before either runs.
 */
function splitClientArgs(argv: readonly string[]): { cli: string[]; rest: string[] } {
  const cli: string[] = [];
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--home' || arg === '--host' || arg === '--port') cli.push(arg, requiredValue(argv, ++i, arg));
    else rest.push(arg);
  }
  return { cli, rest };
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

function validPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid port: ${value}`);
  return port;
}

function resolveAddress(options: CliOptions): { host: string; port: number } {
  const stored = readStoredAddress(options.home);
  return {
    host: options.host ?? process.env.COMPANION_HOST?.trim() ?? stored.host ?? '127.0.0.1',
    port: options.port ?? envPort(process.env.COMPANION_PORT) ?? stored.port ?? 8901,
  };
}

function readStoredAddress(home: string): { host?: string; port?: number } {
  const file = join(home, 'companiond.json');
  try {
    const value = JSON.parse(readRegularTextFile(file, { maxBytes: 1024 * 1024 })) as {
      host?: unknown;
      port?: unknown;
    };
    return {
      host: typeof value.host === 'string' && value.host.trim() ? value.host : undefined,
      port: typeof value.port === 'number' && Number.isInteger(value.port) ? value.port : undefined,
    };
  } catch {
    return {};
  }
}

function envPort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  try {
    return validPort(value);
  } catch {
    return undefined;
  }
}

function localUrl(host: string, port: number): string {
  const requested = host.trim().replace(/^\[|\]$/g, '');
  const browserHost = localInterfaceAddress(requested);
  const formattedHost = browserHost.includes(':') ? `[${browserHost}]` : browserHost;
  return new URL(`http://${formattedHost}:${validPort(String(port))}`).origin;
}

/** `--host` is a bind address, not an arbitrary remote API target. Returning
 * the matched interface value (rather than the config-file string) prevents a
 * changed companiond.json from turning the admin CLI into an SSRF/token sink. */
function localInterfaceAddress(requested: string): string {
  const lower = requested.toLowerCase();
  if (lower === '0.0.0.0' || lower === '::' || lower === 'localhost') return '127.0.0.1';
  const family = isIP(requested);
  if (lower === '::1' || (family === 4 && lower.startsWith('127.'))) return lower;
  if (family === 0) {
    throw new Error(`Invalid bind host: ${requested}. Use localhost or a local interface IP address.`);
  }
  for (const entries of Object.values(networkInterfaces())) {
    const match = entries?.find((entry) => entry.address.toLowerCase() === lower);
    if (match) return match.address;
  }
  throw new Error(`${requested} is not an address of this machine; --host configures the local bind address.`);
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return true;
    } catch {
      // Boot is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function openBrowser(url: string): void {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('browser URL must use HTTP or HTTPS');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  // Avoid `cmd /c start`: even with shell:false, cmd reparses its remaining
  // arguments as command text. Each platform helper receives one URL argument.
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target.href] : [target.href];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', () => process.stderr.write(`Could not open a browser automatically. Open ${target.href}\n`));
  child.unref();
}

main().catch((err: unknown) => {
  if (err instanceof SetupCancelled || (err instanceof Error && err.name === 'ExitPromptError')) {
    process.stderr.write('Setup cancelled.\n');
    process.exit(130);
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
