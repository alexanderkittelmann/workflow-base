// Tracking issue for a red SonarQube quality gate on the default branch (workflow-base#30).
//
// The repo's own gate step turns the run red, but a red run on `main` is easy to
// miss. This keeps ONE open issue (found by label) that lists every open
// new-code finding while the gate is red, updates it on every red push and
// closes it on the first green one. It never judges the build itself.
//
// Env (set by action.yml): SONAR_TOKEN, SONAR_HOST_URL, SONAR_PROJECT_KEY,
// REVISION, WAIT_SECONDS, POLL_SECONDS, GH_TOKEN, LABEL, PROJECT_TOKEN,
// PROJECT_OWNER, PROJECT_NUMBER, PROJECT_FIELDS; GITHUB_* from the runner.
// Node only: the self-hosted build runner has node but no jq.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- sonar-gate-tracking-issue -->';
export const TITLE = 'Sonar quality gate red on main';
const MAX_ROWS = 200;

/** The open tracking issue among a label listing; the issues API also returns PRs. */
export function findTrackingIssue(issues) {
  return issues.find((i) => !i.pull_request && (i.body ?? '').includes(MARKER)) ?? null;
}

/** `metric=actual (fails when GT 0)` per failed condition of a project_status response. */
export function failedConditions(projectStatus) {
  return (projectStatus?.conditions ?? [])
    .filter((c) => c.status === 'ERROR')
    .map((c) => `${c.metricKey}=${c.actualValue} (fails when ${c.comparator} ${c.errorThreshold})`);
}

function cell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderBody({ host, projectKey, revision, repo, serverUrl, runId, conditions, issues }) {
  const file = (i) => i.component.slice(projectKey.length + 1);
  const rows = issues.slice(0, MAX_ROWS).map((i) => {
    const where = `${file(i)}${i.line ? `:${i.line}` : ''}`;
    const link = `${host}/project/issues?id=${encodeURIComponent(projectKey)}&open=${encodeURIComponent(i.key)}`;
    return `| \`${i.rule}\` | \`${cell(where)}\` | ${cell(i.message)} | [open](${link}) |`;
  });
  const more = issues.length > MAX_ROWS ? [``, `_...and ${issues.length - MAX_ROWS} more, see the dashboard._`] : [];
  return [
    MARKER,
    `The SonarQube quality gate of \`${projectKey}\` is **red** on the default branch.`,
    '',
    `- Commit: ${serverUrl}/${repo}/commit/${revision}`,
    `- Run: ${serverUrl}/${repo}/actions/runs/${runId}`,
    `- Dashboard: ${host}/dashboard?id=${encodeURIComponent(projectKey)}`,
    `- Failed conditions: ${conditions.length ? conditions.map((c) => `\`${c}\``).join(', ') : 'see the dashboard'}`,
    '',
    `### Open findings on new code (${issues.length})`,
    '',
    ...(issues.length
      ? ['| Rule | Location | Message | Sonar |', '|---|---|---|---|', ...rows, ...more]
      : ['_No open issue on new code; the gate fails on another condition (coverage, duplication, hotspots)._']),
    '',
    'Updated on every red push to the default branch; closed automatically by the next green gate.',
  ].join('\n');
}

class ServerUnavailable extends Error {}

async function sonar(path, { allow404 = false } = {}) {
  const { SONAR_HOST_URL: host, SONAR_TOKEN: token } = process.env;
  let res;
  try {
    res = await fetch(`${host}${path}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ServerUnavailable(`GET ${path}: ${e.message}`);
  }
  if (allow404 && res.status === 404) return null;
  if (res.status >= 500) throw new ServerUnavailable(`GET ${path}: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function github(path, { method = 'GET', body, token = process.env.GH_TOKEN, allow = [] } = {}) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (allow.includes(res.status)) return null;
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function graphql(query, variables) {
  const res = await github('/graphql', { method: 'POST', body: { query, variables }, token: process.env.PROJECT_TOKEN });
  if (res.errors?.length) throw new Error(`GraphQL: ${res.errors.map((e) => e.message).join('; ')}`);
  return res.data;
}

async function waitForAnalysis(projectKey, revision, waitSeconds, pollSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const page = await sonar(`/api/project_analyses/search?project=${encodeURIComponent(projectKey)}&ps=5`, { allow404: true });
    const hit = page?.analyses?.find((a) => a.revision === revision);
    if (hit) return hit.key;
    console.log(`Waiting for SonarQube to process the analysis of ${revision}...`);
    await new Promise((r) => setTimeout(r, pollSeconds * 1000));
  }
  return null;
}

async function newCodeIssues(projectKey) {
  const issues = [];
  for (let p = 1; ; p++) {
    const page = await sonar(
      `/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&inNewCodePeriod=true&resolved=false&ps=500&p=${p}`,
    );
    issues.push(...page.issues);
    if (issues.length >= page.paging.total || page.issues.length === 0) return issues;
  }
}

async function addToProject(issueNodeId) {
  const { PROJECT_TOKEN: token, PROJECT_OWNER: owner, PROJECT_NUMBER: number, PROJECT_FIELDS: fields } = process.env;
  if (!token || !owner || !number) return;
  const data = await graphql(
    `query($owner: String!, $number: Int!) { repositoryOwner(login: $owner) {
       ... on User { projectV2(number: $number) { id } }
       ... on Organization { projectV2(number: $number) { id } } } }`,
    { owner, number: Number(number) },
  );
  const projectId = data.repositoryOwner?.projectV2?.id;
  if (!projectId) throw new Error(`project ${owner}/${number} not found`);
  const added = await graphql(
    `mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } } }`,
    { projectId, contentId: issueNodeId },
  );
  const itemId = added.addProjectV2ItemById.item.id;
  for (const [fieldId, optionId] of Object.entries(fields ? JSON.parse(fields) : {})) {
    await graphql(
      `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
         updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}}) { projectV2Item { id } } }`,
      { projectId, itemId, fieldId, optionId },
    );
  }
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const env = process.env;
  const { SONAR_HOST_URL: host, SONAR_PROJECT_KEY: projectKey, REVISION: revision, GITHUB_REPOSITORY: repo, LABEL: label } = env;
  if (!env.SONAR_TOKEN) throw new Error('SONAR_TOKEN is empty');

  const analysis = await waitForAnalysis(projectKey, revision, Number(env.WAIT_SECONDS), Number(env.POLL_SECONDS));
  if (!analysis) {
    console.log(`::warning title=Sonar gate tracking::No SonarQube analysis of ${revision} -- tracking issue left as is.`);
    output('status', 'UNKNOWN');
    return;
  }
  const { projectStatus } = await sonar(`/api/qualitygates/project_status?analysisId=${encodeURIComponent(analysis)}`);
  const status = projectStatus?.status ?? 'UNKNOWN';
  output('status', status);
  console.log(`Quality gate of ${revision}: ${status}`);

  const open = await github(`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`);
  const existing = findTrackingIssue(open);

  if (status === 'OK') {
    if (existing) {
      await github(`/repos/${repo}/issues/${existing.number}/comments`, {
        method: 'POST',
        body: { body: `Quality gate green again at ${revision}. Closing.` },
      });
      await github(`/repos/${repo}/issues/${existing.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
      console.log(`Closed tracking issue #${existing.number}.`);
    }
    return;
  }
  if (status !== 'ERROR') return;

  const body = renderBody({
    host,
    projectKey,
    revision,
    repo,
    serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
    runId: env.GITHUB_RUN_ID,
    conditions: failedConditions(projectStatus),
    issues: await newCodeIssues(projectKey),
  });

  if (existing) {
    await github(`/repos/${repo}/issues/${existing.number}`, { method: 'PATCH', body: { body } });
    output('issue-number', existing.number);
    console.log(`Updated tracking issue #${existing.number}.`);
    return;
  }
  // 422 = the label already exists.
  await github(`/repos/${repo}/labels`, { method: 'POST', body: { name: label, color: 'd93f0b' }, allow: [422] });
  const created = await github(`/repos/${repo}/issues`, { method: 'POST', body: { title: TITLE, body, labels: [label] } });
  output('issue-number', created.number);
  console.log(`Opened tracking issue #${created.number}.`);
  try {
    await addToProject(created.node_id);
  } catch (e) {
    console.log(`::warning title=Sonar gate tracking::Could not add #${created.number} to the project: ${e.message}`);
  }
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (opened) => {
      output('opened', opened === true ? 'true' : 'false');
      process.exit(0);
    },
    (e) => {
      if (e instanceof ServerUnavailable) {
        console.log(`::warning title=Sonar gate tracking::SonarQube unreachable, tracking skipped: ${e.message}`);
        process.exit(0);
      }
      console.log(`::error title=Sonar gate tracking::${String(e.message).replace(/\r?\n/g, ' ')}`);
      process.exit(1);
    },
  );
}
