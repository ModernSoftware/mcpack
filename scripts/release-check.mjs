import { readFile, access, appendFile } from 'node:fs/promises';

import { execFileSync } from 'node:child_process';

import { releaseDistTag, validateReleaseRef } from './release-policy.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

for (const path of [
  'LICENSE',
  'NOTICE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli.js',
  'runtimes/python/worker.py',
]) {
  await access(new URL(`../${path}`, import.meta.url));
}

if (
  pkg.name !== '@modern-software/mcpack' ||
  pkg.license !== 'Apache-2.0' ||
  pkg.publishConfig?.access !== 'public'
) {
  throw new Error('Expected the approved public npm scope and Apache-2.0 license');
}

if (pkg.repository?.url !== 'git+https://github.com/ModernSoftware/mcpack.git') {
  throw new Error('Unexpected package repository');
}

const distTag = releaseDistTag(pkg.version);

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  throw new Error('package.json and package-lock.json versions must match');
}

if (process.argv.includes('--publish')) {
  if (pkg.private) {
    throw new Error(
      'Publication is disabled by package.json private: true; settle distribution first',
    );
  }

  if (!['public', 'restricted'].includes(pkg.publishConfig?.access)) {
    throw new Error('Set publishConfig.access explicitly');
  }

  if (!pkg.license || (pkg.publishConfig.access === 'public' && pkg.license === 'UNLICENSED')) {
    throw new Error('Choose the public package license before publishing');
  }

  if (pkg.publishConfig.access === 'public') {
    await access(new URL('../LICENSE', import.meta.url));
  }

  validateReleaseRef(pkg.version, process.env.GITHUB_REF);

  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], {
    stdio: 'inherit',
  });
}

console.log(
  `Release files verified for ${pkg.name}@${pkg.version}${pkg.private ? ' (publication disabled)' : ''}`,
);

if (process.argv.includes('--github-output')) {
  if (!process.argv.includes('--publish') || !process.env.GITHUB_OUTPUT) {
    throw new Error('GitHub output requires validated publication and GITHUB_OUTPUT');
  }

  await appendFile(process.env.GITHUB_OUTPUT, `dist_tag=${distTag}\n`);
}
