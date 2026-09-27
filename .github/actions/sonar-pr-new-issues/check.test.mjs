// Run: node --test .github/actions/sonar-pr-new-issues/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotation, parseChangedLines, selectNewIssues } from './check.mjs';

const DIFF = `diff --git a/src/A.java b/src/A.java
index 1..2 100644
--- a/src/A.java
+++ b/src/A.java
@@ -10,0 +11,2 @@ class A {
+  int x;
+  int y;
@@ -20 +22 @@ class A {
-  old();
+  neu();
@@ -30,3 +31,0 @@ class A {
-  a();
-  b();
-  c();
diff --git a/src/New.java b/src/New.java
new file mode 100644
--- /dev/null
+++ b/src/New.java
@@ -0,0 +1,3 @@
+class New {
+}
+
diff --git a/src/Gone.java b/src/Gone.java
deleted file mode 100644
--- a/src/Gone.java
+++ /dev/null
@@ -1,2 +0,0 @@
-class Gone {
-}
`;

test('parses added and modified lines per file, ignoring pure deletions', () => {
  const changed = parseChangedLines(DIFF);
  assert.deepEqual([...changed.get('src/A.java').lines], [11, 12, 22]);
  assert.equal(changed.get('src/A.java').added, false);
  assert.deepEqual([...changed.get('src/New.java').lines], [1, 2, 3]);
  assert.equal(changed.get('src/New.java').added, true);
  assert.equal(changed.has('src/Gone.java'), false);
});

test('keeps only issues on changed lines, file-level issues only for added files', () => {
  const changed = parseChangedLines(DIFF);
  const issue = (component, line) => ({ component: `k-pr-1:${component}`, line, rule: 'java:S1', message: 'm' });
  const issues = [
    issue('src/A.java', 11), // changed line -> kept
    issue('src/A.java', 15), // untouched line -> pre-existing
    issue('src/A.java', undefined), // file-level on a modified file -> pre-existing
    issue('src/New.java', undefined), // file-level on an added file -> kept
    issue('src/Other.java', 1), // file not in the PR
    { component: 'k-pr-1', rule: 'x', message: 'project level' },
  ];
  assert.deepEqual(selectNewIssues(issues, changed, 'k-pr-1'), [issues[0], issues[3]]);
});

test('escapes annotation properties and data', () => {
  const line = annotation({ component: 'k:src/a,b.java', line: 3, rule: 'java:S2', message: '50% off\nnext' }, 'k');
  assert.equal(line, '::error file=src/a%2Cb.java,line=3,title=Sonar java%3AS2::50%25 off%0Anext');
});
