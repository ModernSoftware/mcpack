import { readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const path of [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli.js',
  'runtimes/python/worker.py',
]) {
  await access(new URL(`../${path}`, import.meta.url));
}
if (pkg.repository?.url !== 'git+https://github.com/ModernSoftware/mcpack.git')
  throw new Error('Unexpected package repository');
if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(pkg.version))
  throw new Error('This release workflow only supports alpha versions');
if (process.argv.includes('--publish')) {
  if (pkg.private)
    throw new Error(
      'Publication is disabled by package.json private: true; settle distribution first',
    );
  if (!['public', 'restricted'].includes(pkg.publishConfig?.access))
    throw new Error('Set publishConfig.access explicitly');
  if (!pkg.license || (pkg.publishConfig.access === 'public' && pkg.license === 'UNLICENSED')) {
    throw new Error('Choose the public package license before publishing');
  }
  if (pkg.publishConfig.access === 'public') await access(new URL('../LICENSE', import.meta.url));
  if (process.env.GITHUB_REF !== `refs/tags/v${pkg.version}`)
    throw new Error('Run publication from the matching version tag');
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { stdio: 'inherit' });
}
console.log(
  `Release files verified for ${pkg.name}@${pkg.version}${pkg.private ? ' (publication disabled)' : ''}`,
);
