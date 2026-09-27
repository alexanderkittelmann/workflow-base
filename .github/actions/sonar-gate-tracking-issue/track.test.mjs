// Run: node --test .github/actions/sonar-gate-tracking-issue/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, failedConditions, findTrackingIssue, renderBody } from './track.mjs';

const BASE = {
  host: 'https://sonar.example',
  projectKey: 'org_repo',
  revision: 'abc123',
  repo: 'org/repo',
  serverUrl: 'https://github.com',
  runId: '42',
};

test('findTrackingIssue skips pull requests and unmarked issues', () => {
  const listed = [
    { number: 1, body: `${MARKER}\nold`, pull_request: {} },
    { number: 2, body: 'someone else used the label' },
    { number: 3, body: null },
    { number: 4, body: `${MARKER}\ncurrent` },
  ];
  assert.equal(findTrackingIssue(listed).number, 4);
  assert.equal(findTrackingIssue(listed.slice(0, 3)), null);
});

test('failedConditions keeps only ERROR conditions', () => {
  const status = {
    conditions: [
      { status: 'ERROR', metricKey: 'new_violations', comparator: 'GT', errorThreshold: '0', actualValue: '5' },
      { status: 'OK', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '91' },
    ],
  };
  assert.deepEqual(failedConditions(status), ['new_violations=5 (fails when GT 0)']);
  assert.deepEqual(failedConditions(undefined), []);
});

test('renderBody lists findings with location, escaped message and a Sonar link', () => {
  const body = renderBody({
    ...BASE,
    conditions: ['new_violations=2 (fails when GT 0)'],
    issues: [
      { key: 'K1', rule: 'java:S2259', component: 'org_repo:src/A.java', line: 72, message: 'a | b\nc' },
      { key: 'K2', rule: 'java:S1068', component: 'org_repo:src/B.java', message: 'file level' },
    ],
  });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /\| `java:S2259` \| `src\/A\.java:72` \| a \\\| b c \| \[open\]\(https:\/\/sonar\.example\/project\/issues\?id=org_repo&open=K1\) \|/);
  assert.match(body, /\| `java:S1068` \| `src\/B\.java` \| file level \|/);
  assert.match(body, /Open findings on new code \(2\)/);
  assert.match(body, /https:\/\/github\.com\/org\/repo\/commit\/abc123/);
  assert.match(body, /`new_violations=2 \(fails when GT 0\)`/);
});

test('renderBody explains a red gate without issues and caps long lists', () => {
  assert.match(renderBody({ ...BASE, conditions: [], issues: [] }), /another condition/);
  const many = Array.from({ length: 205 }, (_, n) => ({
    key: `K${n}`, rule: 'r', component: 'org_repo:f', line: n + 1, message: 'm',
  }));
  const body = renderBody({ ...BASE, conditions: [], issues: many });
  assert.equal(body.split('\n').filter((l) => l.startsWith('| `r`')).length, 200);
  assert.match(body, /and 5 more/);
});
