// Fails a PR on SonarQube issues that sit on lines the PR changed (workflow-base#28).
//
// The self-hosted SonarQube Community Build has no PR analysis, so the PR is
// scanned into a scratch project (`<key>-pr-<N>`) and this script does the part
// the server cannot: it keeps only the issues on changed lines. That mirrors
// what SonarCloud's PR gate used to report ("new issues on new code").
//
// Env (set by action.yml): SONAR_TOKEN, SONAR_HOST_URL, SONAR_PROJECT_KEY,
// REVISION, WAIT_SECONDS, POLL_SECONDS, DELETE_PROJECT.
// Node only: the self-hosted build runner has node but no jq.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Parses `git diff --unified=0` output into the changed lines per file.
 * Returns Map<path, { added: boolean, lines: Set<number> }>, paths as in the new tree.
 */
export function parseChangedLines(diffText) {
  const files = new Map();
  let current = null;
  let fromDevNull = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      fromDevNull = false;
    } else if (line.startsWith('--- ')) {
      fromDevNull = line === '--- /dev/null';
    } else if (line.startsWith('+++ ')) {
      // A deleted file (`+++ /dev/null`) has no new lines to attribute.
      current = null;
      if (line.startsWith('+++ b/')) {
        const path = line.slice('+++ b/'.length);
        current = { added: fromDevNull, lines: new Set() };
        files.set(path, current);
      }
    } else if (current && line.startsWith('@@')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let n = start; n < start + count; n++) current.lines.add(n);
    }
  }
  return files;
}

/**
 * Keeps the issues on changed lines. An issue without a line (file level) counts
 * only when the PR added the whole file; a project-level issue never counts.
 */
export function selectNewIssues(issues, changed, projectKey) {
  const prefix = `${projectKey}:`;
  return issues.filter((issue) => {
    if (!issue.component?.startsWith(prefix)) return false;
    const file = changed.get(issue.component.slice(prefix.length));
    if (!file) return false;
    return issue.line === undefined ? file.added : file.lines.has(issue.line);
  });
}

// GitHub workflow-command escaping (actions/toolkit `command.ts`).
export function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function annotation(issue, projectKey) {
  const file = issue.component.slice(projectKey.length + 1);
  const line = issue.line === undefined ? '' : `,line=${issue.line}`;
  return `::error file=${escapeProperty(file)}${line},title=${escapeProperty(`Sonar ${issue.rule}`)}::${escapeData(issue.message)}`;
}

class ServerUnavailable extends Error {}

async function api(path, { method = 'GET', allow404 = false } = {}) {
  const { SONAR_HOST_URL: host, SONAR_TOKEN: token } = process.env;
  let res;
  try {
    res = await fetch(`${host}${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ServerUnavailable(`${method} ${path}: ${e.message}`);
  }
  if (allow404 && res.status === 404) return null;
  if (res.status >= 500) throw new ServerUnavailable(`${method} ${path}: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function waitForAnalysis(projectKey, revision, waitSeconds, pollSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    // 404 until the compute engine has created the scratch project.
    const page = await api(`/api/project_analyses/search?project=${encodeURIComponent(projectKey)}&ps=5`, { allow404: true });
    const hit = page?.analyses?.find((a) => a.revision === revision);
    if (hit) return hit.key;
    console.log(`Waiting for SonarQube to process the analysis of ${revision}...`);
    await new Promise((r) => setTimeout(r, pollSeconds * 1000));
  }
  return null;
}

async function fetchOpenIssues(projectKey) {
  const issues = [];
  for (let p = 1; ; p++) {
    const page = await api(`/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&resolved=false&ps=500&p=${p}`);
    issues.push(...page.issues);
    if (issues.length >= page.paging.total || page.issues.length === 0) return issues;
  }
}

function changedLines() {
  // The pull_request checkout is the merge commit: HEAD^1 is the base, so this
  // diff is exactly what the PR changes (needs `fetch-depth: 2`).
  const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' }).trim().split(' ');
  if (parents.length !== 3) {
    throw new Error('HEAD is not a merge commit: check out the pull_request merge ref with fetch-depth: 2');
  }
  const diff = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', 'HEAD^1', 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseChangedLines(diff);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function main() {
  const { SONAR_HOST_URL: host, SONAR_PROJECT_KEY: projectKey, REVISION: revision } = process.env;
  if (!process.env.SONAR_TOKEN) throw new Error('SONAR_TOKEN is empty');
  const changed = changedLines();

  const analysis = await waitForAnalysis(projectKey, revision, Number(process.env.WAIT_SECONDS), Number(process.env.POLL_SECONDS));
  if (!analysis) {
    console.log(`::error title=Sonar PR check::No SonarQube analysis of ${revision} in ${projectKey} -- did the PR scan step fail? ${host}/dashboard?id=${projectKey}`);
    return 1;
  }

  const found = selectNewIssues(await fetchOpenIssues(projectKey), changed, projectKey);
  for (const issue of found) console.log(annotation(issue, projectKey));

  if (found.length === 0) {
    console.log('No Sonar issues on changed lines.');
    summary('### Sonar PR check\nNo Sonar issues on changed lines.');
  } else {
    const rows = found.map((i) => `| \`${i.rule}\` | \`${i.component.slice(projectKey.length + 1)}${i.line ? `:${i.line}` : ''}\` | ${i.message.replace(/\|/g, '\\|')} |`);
    summary(['### Sonar PR check', `${found.length} Sonar issue(s) on changed lines.`, '', '| Rule | Location | Message |', '|---|---|---|', ...rows].join('\n'));
    console.log(`::error title=Sonar PR check::${found.length} Sonar issue(s) on changed lines -- see the annotations.`);
  }

  if (process.env.DELETE_PROJECT === 'true') {
    try {
      await api(`/api/projects/delete?project=${encodeURIComponent(projectKey)}`, { method: 'POST' });
    } catch (e) {
      console.log(`::warning title=Sonar PR check::Could not delete the scratch project ${projectKey}: ${e.message}`);
    }
  }
  return found.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof ServerUnavailable) {
        // Same policy as the token preflight: an outage must not red a PR.
        console.log(`::warning title=Sonar PR check::SonarQube unreachable, check skipped: ${e.message}`);
        process.exit(0);
      }
      console.log(`::error title=Sonar PR check::${escapeData(e.message)}`);
      process.exit(1);
    },
  );
}
