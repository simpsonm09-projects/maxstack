#!/usr/bin/env node
// Prove the workspace skill check needs a model and stops a hung OpenCode run at its
// time limit, naming the command. The stand-in binary never reaches a model, so no
// model call runs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shScript = join(repoRoot, 'scripts', 'verify-workspace-skill.sh');
// A safety net for the test itself: a check that ignores its limit fails here instead of hanging.
const RUN_CEILING_MS = 90_000;

function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'skill-check-'));
  const project = join(base, 'project');
  mkdirSync(project);
  return { base, project };
}

function writeStandIn(base, body) {
  const path = join(base, 'fake-opencode');
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

function assertNoRunawayWait(run) {
  assert.equal(run.error, undefined, `the test had to stop the check: ${run.error?.code ?? ''}`);
}

test('the shell check refuses to run without a model argument', () => {
  const run = spawnSync('bash', [shScript], {
    encoding: 'utf8',
    timeout: RUN_CEILING_MS,
    windowsHide: true,
    env: { ...process.env, WORKSPACE: process.cwd() },
  });
  assertNoRunawayWait(run);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /pass the model as the second argument/);
});

test('a hung shell run stops at its limit and the check names the command', () => {
  const { base, project } = makeFixture();
  try {
    const fake = writeStandIn(base, 'sleep 120\n');
    const run = spawnSync('bash', [shScript, 'poteto-mode', 'opencode-go/test-model', '2'], {
      encoding: 'utf8',
      timeout: RUN_CEILING_MS,
      windowsHide: true,
      env: {
        ...process.env,
        OPENCODE_BIN: fake,
        PROJECT: project,
        WORKSPACE: project,
        PSTACK_TEST_TMPDIR: base,
      },
    });
    assertNoRunawayWait(run);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /did not finish within 2 seconds/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
