// Run: node --test .github/actions/release-sanity/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, hasRelease, highestRelease, judge, parseVersion } from './sanity.mjs';

const RELEASES = [
  { tag_name: 'v8.69.0', draft: false },
  { tag_name: '8.70.0', draft: false },
  { tag_name: '9.0.0', draft: true },
  { tag_name: 'nightly', draft: false },
  { tag_name: '8.9.1', draft: false },
];

test('parseVersion accepts X.Y.Z with an optional v and nothing else', () => {
  assert.deepEqual(parseVersion('8.70.0'), [8, 70, 0]);
  assert.deepEqual(parseVersion(' v1.2.3 '), [1, 2, 3]);
  assert.equal(parseVersion('8.70'), null);
  assert.equal(parseVersion('8.70.0-rc1'), null);
  assert.equal(parseVersion(undefined), null);
});

test('compareVersions orders numerically, not lexically', () => {
  assert.ok(compareVersions([8, 70, 0], [8, 9, 1]) > 0);
  assert.ok(compareVersions([3, 70, 0], [8, 0, 0]) < 0);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test('highestRelease skips drafts, non-semver tags and the version itself', () => {
  assert.equal(highestRelease(RELEASES, ''), '8.70.0');
  assert.equal(highestRelease(RELEASES, 'v8.70.0'), 'v8.69.0');
  assert.equal(highestRelease([], '1.0.0'), null);
});

test('hasRelease ignores drafts and matches with or without v', () => {
  assert.ok(hasRelease(RELEASES, 'v8.70.0'));
  assert.ok(!hasRelease(RELEASES, '9.0.0'));
});

test('judge passes a version above the latest release', () => {
  assert.deepEqual(judge({ version: '8.71.0', releases: RELEASES }), { ok: true, baseline: '8.70.0', errors: [] });
});

test('judge refuses a typo below the latest release and a re-pin of the same version', () => {
  const typo = judge({ version: '3.70.0', releases: RELEASES });
  assert.equal(typo.ok, false);
  assert.match(typo.errors[0], /not higher than 8\.70\.0/);
  assert.equal(judge({ version: '8.70.0', releases: RELEASES, compareTo: '8.70.0' }).ok, false);
});

test('judge does not compare a just-created release with itself', () => {
  assert.deepEqual(judge({ version: '8.70.0', releases: RELEASES }), { ok: true, baseline: 'v8.69.0', errors: [] });
});

test('judge refuses a malformed version', () => {
  const verdict = judge({ version: '8.70', releases: RELEASES });
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors[0], /not a plain X\.Y\.Z/);
});

test('judge compares against an explicit baseline and allows a deliberate rollback', () => {
  assert.equal(judge({ version: '8.69.0', releases: RELEASES, compareTo: '8.70.0' }).ok, false);
  assert.equal(judge({ version: '8.69.0', releases: RELEASES, compareTo: '8.70.0', allowLower: true }).ok, true);
  assert.equal(judge({ version: '8.71.0', releases: RELEASES, compareTo: 'latest' }).ok, false);
});

test('judge with require-release refuses a bare tag', () => {
  const bare = judge({ version: '8.71.0', releases: RELEASES, compareTo: '8.70.0', requireRelease: true });
  assert.equal(bare.ok, false);
  assert.match(bare.errors[0], /no published GitHub Release/);
  assert.equal(judge({ version: '8.70.0', releases: RELEASES, compareTo: '8.69.0', requireRelease: true }).ok, true);
});

test('judge passes the first release of a repository', () => {
  assert.deepEqual(judge({ version: '0.1.0', releases: [] }), { ok: true, baseline: null, errors: [] });
});
