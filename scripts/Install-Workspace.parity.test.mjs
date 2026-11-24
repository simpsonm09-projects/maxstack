// Parity between the PowerShell installer and the TypeScript installer. Both run on one fixture workspace, one after
// the other, and the generated tree must be identical. The PowerShell run goes first, its output is snapshotted, the
// workspace is reset to the fixture, and the TypeScript run writes the same tree. The test is the porting contract for
// the Linux behaviour; it is deleted with the PowerShell installer.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import {
  buildWorkspace,
  installer,
  plainOutput,
  psShell,
  repoRoot,
  snapshotTree,
  tsInstaller,
  writeLayers,
} from './lib/installer-test-kit.mjs';

const bun = process.versions.bun ? process.execPath : 'bun';
const bunAvailable =
  process.versions.bun !== undefined ||
  spawnSync('bun', ['--version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
const skip = !psShell ? 'pwsh is not available' : !bunAvailable ? 'bun is not available' : false;

// A Copilot and Pi CLI the POSIX wrapper rule accepts: a real executable file with no .cmd, .bat, or .ps1 extension.
// They go on PATH under bare names, because that is how the PowerShell installer resolves a command off Windows.
function writePosixCli(bin, name) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\necho ${name} "$@"\n`);
  chmodSync(path, 0o755);
}

// The fixture folders stay; everything the installer generated goes, so the second run starts from the same workspace.
function resetWorkspace(workspace) {
  for (const name of readdirSync(workspace)) {
    if (name === 'projects') continue;
    rmSync(join(workspace, name), { recursive: true, force: true });
  }
}

function runInstallerWith(command, ctx, args) {
  const env = { ...(ctx.env ?? process.env), MAXSTACK_TEST_MODE: '1' };
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${ctx.cliBin}${delimiter}${env[pathKey] ?? ''}`;
  return spawnSync(command, [...args], {
    windowsHide: true,
    encoding: 'utf8',
    env,
  });
}

test(
  'the TypeScript installer writes the same Linux workspace tree as the PowerShell installer',
  { skip, timeout: 180000 },
  () => {
    const ctx = buildWorkspace();
    try {
      ctx.cliBin = join(ctx.base, 'cli-bin');
      mkdirSync(ctx.cliBin);
      writePosixCli(ctx.cliBin, 'parity-copilot');
      writePosixCli(ctx.cliBin, 'parity-pi');
      const common = [
        '-Workspace',
        ctx.workspace,
        '-LayersFile',
        writeLayers(ctx),
        '-Apply',
        '-CopilotCommand',
        'parity-copilot',
        '-PiCommand',
        'parity-pi',
      ];

      const powershell = runInstallerWith(psShell, ctx, [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        installer,
        ...common,
      ]);
      assert.equal(powershell.status, 0, plainOutput(powershell));
      const expected = snapshotTree(ctx.workspace, { skipGit: true });
      assert.ok(expected.has('stack.lock.json'), 'the PowerShell run wrote no lock');
      assert.ok(
        readdirSync(join(ctx.workspace, '.maxstack', 'bin')).length > 0,
        'the PowerShell run wrote no wrapper',
      );

      resetWorkspace(ctx.workspace);
      const typescript = runInstallerWith(bun, ctx, [tsInstaller, ...common]);
      assert.equal(typescript.status, 0, plainOutput(typescript));
      const actual = snapshotTree(ctx.workspace, { skipGit: true });

      assert.deepEqual(
        [...actual.keys()].sort(),
        [...expected.keys()].sort(),
        'the tree entries differ',
      );
      for (const [path, value] of expected) {
        assert.equal(actual.get(path), value, `${path} differs between the two installers`);
      }
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  },
);

// A guard for the fixture itself: the two paths must both name files in this checkout, so a renamed module fails here
// rather than skipping silently.
test('the parity test names both installers in this checkout', () => {
  assert.ok(installer.endsWith('Install-Workspace.ps1'));
  assert.ok(tsInstaller.startsWith(join(repoRoot, 'scripts', 'install')));
});
