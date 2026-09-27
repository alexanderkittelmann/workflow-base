# workflow-base

Reusable GitHub Actions workflows + composite actions shared by the HotStox repos
(`alexanderkittelmann/*`). No application code, no CI of its own.

## Layout

| Path | What | Callers |
|---|---|---|
| `.github/workflows/build-java-maven-snapshot-docker.yml` | PR + `push:main` build: `mvn clean package verify`, self-hosted SonarQube scan, snapshot image | hotstox-backend `build-snapshot.yml` (+ other Java repos) |
| `.github/workflows/build-java-maven-release-docker.yml` | `release: created` build: `release:prepare/perform`, release image | hotstox-backend `build-release.yml` |
| `.github/actions/sonar-pr-new-issues/` | Composite action: fail a PR on SonarQube issues on changed lines (Node, `check.mjs`) | hotstox-backend, hotstox-frontend |

## Versioning + release

- Callers pin **full commit SHA + `# vX.Y.Z` comment** (`@<sha> # v2.1.0`). The comment is what Dependabot's
  `github-actions` updater reads to bump SHA + comment together -- never pin `# main`.
- New inputs are **additive with a default that keeps existing callers unchanged** -> minor bump. Removing or
  retyping an input -> major.
- Release: merge to `main`, then `gh release create vX.Y.Z --target main --generate-notes` (tags `main` HEAD).
  Dependabot then opens the pin bump in each caller.

## Sonar (self-hosted SonarQube Community Build, infra#597)

- `push:main`: full scan into `<sonar_project_key>` on `sonar_host_url_main`.
- **PR check (workflow-base#28, opt-in `sonar_pr_scan: true`).** Community Build has no PR analysis and the
  mc1arke branch plugin lags the server (plugin 26.5 vs server 26.9), so a same-repo, non-Dependabot PR is scanned
  into a **scratch project `<key>-pr-<N>`** (analysis pinned to the merge commit via `sonar.scm.revision`). The
  workflow exposes `sonar_pr_project_key`; the caller runs `sonar-pr-new-issues` on it in its own job, which
  waits for the analysis, keeps only issues on lines changed by the merge commit (`git diff HEAD^1 HEAD`,
  so it needs `fetch-depth: 2`), annotates them, fails the job, and deletes the scratch project.
  Server unreachable -> warning, never a red PR. The token needs `scan` + `provisioning` (+ project admin to
  delete; a failed delete is only a warning).
- Test the action: `node --test .github/actions/sonar-pr-new-issues/`.
- Dry run against real data: in a `git worktree add --no-checkout --detach <dir> <merge-sha>` of a caller repo,
  run `check.mjs` with `SONAR_PROJECT_KEY=<main key> REVISION=<merge-sha> DELETE_PROJECT=false` -- a merged PR's
  main analysis then yields exactly the issues that PR introduced.

## Conventions

- Commits: `#<issue>: <type>(<scope>): <subject>` (Conventional Commits), identity `Claude [AI]`.
- Self-hosted build runner: `node`, `mvn`, `docker` are on PATH; **no `jq`** (parse JSON in Node).
- Comments in workflows explain the *why* (outages, runner quirks); keep that density.
