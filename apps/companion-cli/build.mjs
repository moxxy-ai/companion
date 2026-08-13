import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dist = join(here, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const nodeBanner = [
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __f } from 'node:url';",
  "import { dirname as __d } from 'node:path';",
  'const require = __cr(import.meta.url);',
  'const __filename = __f(import.meta.url);',
  'const __dirname = __d(__filename);',
].join('\n');

await build({
  entryPoints: {
    index: join(here, 'src/bootstrap.ts'),
    main: join(here, 'src/index.ts'),
    setup: join(here, 'src/setup.ts'),
    github: join(here, 'src/github.ts'),
    modules: join(here, 'src/modules.ts'),
    acl: join(here, 'src/acl.ts'),
    client: join(here, 'src/client.ts'),
    daemon: join(here, 'src/daemon.ts'),
    repair: join(here, 'src/repair.ts'),
    backup: join(here, 'src/backup.ts'),
    'rotate-key': join(here, 'src/rotate-key.ts'),
    runs: join(here, 'src/runs.ts'),
    profile: join(here, 'src/profile.ts'),
    harnesses: join(here, 'src/harnesses.ts'),
    mcp: join(here, 'src/mcp.ts'),
    doctor: join(here, 'src/doctor.ts'),
    version: join(here, 'src/version.ts'),
  },
  outdir: dist,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // The package's declared runtime dependencies, and nothing else: everything
  // that is not one is inlined. SQLite is `node:sqlite`, so none of them is native.
  external: ['@inquirer/prompts', 'undici'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

await build({
  entryPoints: [join(root, 'apps/api/src/index.ts')],
  outfile: join(dist, 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['ws', 'undici'],
  banner: { js: nodeBanner },
  // Contract-only imports register TypeScript interfaces and intentionally
  // have no runtime side effects; keep the publish build output readable.
  logOverride: { 'ignored-bare-import': 'silent' },
  logLevel: 'info',
});

// The built-in runtime's child process, emitted ONLY when this profile carries
// module-runtime. The module is inlined into the daemon bundle, so there is no
// package on disk for it to resolve at run time: the child has to be a file
// beside the bundle, which is what `childPath()` falls back to.
if (readFileSync(join(root, 'apps/api/src/modules.generated.ts'), 'utf8').includes('@companion/module-runtime/')) {
  await build({
    entryPoints: [join(root, 'packages/runtime/src/child/main.ts')],
    outfile: join(dist, 'agent.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: { js: nodeBanner },
    logLevel: 'info',
  });
}

cpSync(join(root, 'apps/web/dist'), join(dist, 'web'), { recursive: true });

// `module scaffold` copies the hello-world example, sources only: the scaffold
// is a starting point, never a prebuilt artifact.
const templateSrc = join(root, 'examples/companion-module-hello');
const templateDst = join(dist, 'templates/hello');
cpSync(templateSrc, templateDst, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(templateSrc.length);
    return !rel.startsWith('/node_modules') && !rel.startsWith('/dist');
  },
});
// A scaffolded module lives outside this workspace: resolve the workspace
// ranges to the published ones and drop this repository's own metadata.
const templatePkgFile = join(templateDst, 'package.json');
const templatePkg = JSON.parse(readFileSync(templatePkgFile, 'utf8'));
for (const [name, dir] of [
  ['@moxxy/companion-sdk', 'packages/sdk'],
  ['@moxxy/companion-contracts', 'packages/contracts'],
]) {
  const { version } = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  templatePkg.devDependencies[name] = `^${version}`;
}
delete templatePkg.homepage;
delete templatePkg.repository;
delete templatePkg.bugs;
writeFileSync(templatePkgFile, JSON.stringify(templatePkg, null, 2) + '\n');

chmodSync(join(dist, 'index.js'), 0o755);
