import assert from 'node:assert/strict';

import test from 'node:test';

import { releaseDistTag, validateReleaseRef } from '../scripts/release-policy.mjs';

test('release channel separates numbered alphas from non-prerelease versions', () => {
  assert.equal(releaseDistTag('0.9.0'), 'latest');

  assert.equal(releaseDistTag('1.0.0'), 'latest');

  assert.equal(releaseDistTag('0.1.0-alpha.2'), 'alpha');

  for (const version of [
    'v0.9.0',
    '0.9',
    '01.9.0',
    '0.9.0-alpha',
    '0.9.0-alpha.01',
    '0.9.0-beta.1',
    '0.9.0+build',
    '0.9.0\n',
  ])
    assert.throws(() => releaseDistTag(version));
});

test('publication requires the exact version tag, never a branch or different version', () => {
  assert.equal(validateReleaseRef('0.9.0', 'refs/tags/v0.9.0'), 'latest');

  assert.equal(validateReleaseRef('0.9.0-alpha.1', 'refs/tags/v0.9.0-alpha.1'), 'alpha');

  for (const ref of [undefined, 'refs/heads/main', 'refs/tags/v0.9.1', 'refs/tags/v0.9.0-alpha.1'])
    assert.throws(() => validateReleaseRef('0.9.0', ref));
});
