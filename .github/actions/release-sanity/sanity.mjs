// Release sanity check (workflow-base#43).
//
// Refuses a version that is not plain `X.Y.Z` (an optional leading `v` is allowed) or
// that does not move forward: a typo such as `3.70.0` instead of `8.70.0` passes every
// build and only surfaces once it is deployed. The baseline is either an explicit
// `COMPARE_TO` version (e.g. the tag a deployment currently pins) or the highest
// published, non-draft release of `REPOSITORY` other than `VERSION` itself.
// `REQUIRE_RELEASE=true` additionally demands that `VERSION` has a published GitHub
// Release, so a bare or transient tag is not enough.
//
// Env (set by action.yml): VERSION, REPOSITORY, COMPARE_TO, REQUIRE_RELEASE,
// ALLOW_LOWER, GH_TOKEN; GITHUB_API_URL / GITHUB_OUTPUT from the runner.
// Node only: the self-hosted build runner has node but no jq.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] of a plain `X.Y.Z` / `vX.Y.Z`, or null. */
export function parseVersion(text) {
  const match = SEMVER.exec(String(text ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Negative / 0 / positive like a sort comparator. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Highest published release tag among `releases`, ignoring drafts, non-semver tags and `exclude`. */
export function highestRelease(releases, exclude) {
  const skip = parseVersion(exclude);
  let best = null;
  for (const release of releases) {
    if (release.draft) continue;
    const parsed = parseVersion(release.tag_name);
    if (!parsed || (skip && compareVersions(parsed, skip) === 0)) continue;
    if (!best || compareVersions(parsed, best.parsed) > 0) best = { tag: release.tag_name, parsed };
  }
  return best?.tag ?? null;
}

/** True when a published (non-draft) release carries the same version as `version`. */
export function hasRelease(releases, version) {
  const wanted = parseVersion(version);
  return releases.some((r) => {
    const parsed = parseVersion(r.tag_name);
    return !r.draft && parsed !== null && compareVersions(parsed, wanted) === 0;
  });
}

/**
 * The verdict: `{ ok, baseline, errors }`. `releases` is every release of the repository,
 * `compareTo` an optional explicit baseline.
 */
export function judge({ version, releases, compareTo = '', requireRelease = false, allowLower = false }) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return { ok: false, baseline: null, errors: [`"${version}" is not a plain X.Y.Z version.`] };
  }
  const errors = [];
  const baseline = compareTo.trim() || highestRelease(releases, version);
  if (compareTo.trim() && !parseVersion(compareTo)) {
    errors.push(`compare-to "${compareTo}" is not a plain X.Y.Z version.`);
  } else if (baseline && !allowLower && compareVersions(parsed, parseVersion(baseline)) <= 0) {
    errors.push(`${version} is not higher than ${baseline}. A typo? Set allow-lower for a deliberate rollback.`);
  }
  if (requireRelease && !hasRelease(releases, version)) {
    errors.push(`${version} has no published GitHub Release; a bare tag is not enough.`);
  }
  return { ok: errors.length === 0, baseline, errors };
}

async function listReleases(apiUrl, repository, token) {
  const releases = [];
  for (let page = 1; page <= 20; page += 1) {
    const res = await fetch(`${apiUrl}/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GET releases of ${repository}: HTTP ${res.status} ${await res.text()}`);
    const batch = await res.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

async function main() {
  const env = process.env;
  const repository = env.REPOSITORY;
  const releases = await listReleases(env.GITHUB_API_URL || 'https://api.github.com', repository, env.GH_TOKEN);
  const verdict = judge({
    version: env.VERSION,
    releases,
    compareTo: env.COMPARE_TO ?? '',
    requireRelease: env.REQUIRE_RELEASE === 'true',
    allowLower: env.ALLOW_LOWER === 'true',
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `baseline=${verdict.baseline ?? ''}\n`);
  if (!verdict.ok) {
    for (const error of verdict.errors) console.log(`::error title=Release sanity (${repository})::${error}`);
    process.exit(1);
  }
  console.log(`${env.VERSION} of ${repository} is fine (baseline: ${verdict.baseline ?? 'none'}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.log(`::error title=Release sanity::${e.message}`);
    process.exit(1);
  });
}
